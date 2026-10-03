import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, webhookDeliveries, webhookEndpoints, webhookEventSubscriptions, webhookEvents } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { assertSafeTestDatabaseUrl, UnsafeTestDatabaseError } from "../src/db/testDatabaseGuard.js";
import { encryptWebhookSecret } from "../src/modules/webhooks/crypto.js";
import {
  WEBHOOK_RETRY_POLICY,
  claimDueDeliveries,
  classifyAttempt,
  computeRetryDelayMs,
  processDueWebhookDeliveries,
  publishEvent,
} from "../src/modules/webhooks/delivery.js";
import { publishEventSchema } from "../src/modules/webhooks/schemas.js";
import { verifyWebhookSignature } from "../src/modules/webhooks/signature.js";
import { createTestOrganization, deleteTestOrganization } from "./helpers.js";

/**
 * Fase 5 — webhook delivery with retry + dedupe. Real local HTTP receivers;
 * all state in the (disposable) database.
 */
after(() => queryClient.end());

const SECRET = "whsec_retry-test-secret";

interface Captured {
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Receiver whose behaviour per request is decided by `respond(n)` (n = 1-based request count). */
function startReceiver(
  respond: (n: number, req: Captured) => { status?: number; headers?: Record<string, string>; delayMs?: number; destroy?: boolean },
): Promise<{ server: http.Server; url: string; received: Captured[] }> {
  const received: Captured[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const captured = { headers: req.headers, body };
        received.push(captured);
        const r = respond(received.length, captured);
        if (r.destroy) {
          req.socket.destroy();
          return;
        }
        setTimeout(() => {
          res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
          res.end("{}");
        }, r.delayMs ?? 0);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/hook`, received });
    });
  });
}

async function setupEndpoint(url: string, eventType = "payment.confirmed") {
  await seed();
  const org = await createTestOrganization(`retry-${Math.random().toString(36).slice(2, 8)}`);
  const [app] = await db.select({ id: applications.id }).from(applications).where(eq(applications.key, "QUALE_A_DICA"));
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({ applicationId: app!.id, organizationId: org.id, url, secretEncrypted: encryptWebhookSecret(SECRET), status: "ACTIVE" })
    .returning();
  await db.insert(webhookEventSubscriptions).values({ webhookEndpointId: endpoint!.id, eventType });
  return { orgId: org.id, endpointId: endpoint!.id };
}

const publish = (orgId: string, extra: { idempotencyKey?: string; data?: Record<string, unknown> } = {}) =>
  publishEvent({ organizationId: orgId, sourceApplicationKey: "NA_PISTA", type: "payment.confirmed", data: extra.data ?? { paymentId: "pay_1" }, idempotencyKey: extra.idempotencyKey });

async function deliveryOf(eventId: string) {
  const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, eventId));
  return row!;
}

/** Simulates the passage of time: the delivery becomes due now. */
async function makeDue(deliveryId: string) {
  await db.update(webhookDeliveries).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(webhookDeliveries.id, deliveryId));
}

// ───────────────────────────── política (pura) ─────────────────────────────

test("classifyAttempt: 2xx sucesso; 408/425/429/5xx/rede → retry; 3xx e restantes 4xx → permanente", () => {
  assert.equal(classifyAttempt(200), "SUCCESS");
  assert.equal(classifyAttempt(204), "SUCCESS");
  for (const s of [null, 408, 425, 429, 500, 502, 503, 504]) assert.equal(classifyAttempt(s), "RETRY", `status ${s}`);
  for (const s of [301, 302, 307, 400, 401, 403, 404, 409, 410, 422]) assert.equal(classifyAttempt(s), "PERMANENT", `status ${s}`);
});

test("computeRetryDelayMs: backoff exponencial com jitter, tecto, e Retry-After respeitado (com tecto)", () => {
  const mid = () => 0.5; // jitter neutro
  assert.equal(computeRetryDelayMs(1, { random: mid }), 30_000);
  assert.equal(computeRetryDelayMs(2, { random: mid }), 60_000);
  assert.equal(computeRetryDelayMs(3, { random: mid }), 120_000);
  assert.equal(computeRetryDelayMs(10, { random: mid }), WEBHOOK_RETRY_POLICY.maxDelayMs);
  const low = computeRetryDelayMs(1, { random: () => 0 });
  const high = computeRetryDelayMs(1, { random: () => 0.999999 });
  assert.ok(low >= 24_000 && high <= 36_000, "jitter ±20%");
  assert.equal(computeRetryDelayMs(1, { retryAfterSeconds: 120 }), 120_000);
  assert.equal(computeRetryDelayMs(1, { retryAfterSeconds: 999_999 }), WEBHOOK_RETRY_POLICY.maxDelayMs);
});

test("guard da BD de testes: recusa hosts remotos; aceita local ou opt-in explícito", () => {
  assert.throws(() => assertSafeTestDatabaseUrl("postgresql://u:p@aws-0-eu-west-2.pooler.supabase.com:5432/postgres"), UnsafeTestDatabaseError);
  assert.doesNotThrow(() => assertSafeTestDatabaseUrl("postgres://postgres@localhost:55432/ul_platform_test"));
  assert.doesNotThrow(() => assertSafeTestDatabaseUrl("postgres://u:p@test-db.example.com/x", "true"));
});

test("idempotencyKey é validado na fronteira (vazio/longo demais rejeitados)", () => {
  assert.equal(publishEventSchema.safeParse({ type: "payment.confirmed", idempotencyKey: "" }).success, false);
  assert.equal(publishEventSchema.safeParse({ type: "payment.confirmed", idempotencyKey: "x".repeat(201) }).success, false);
  assert.equal(publishEventSchema.safeParse({ type: "payment.confirmed", idempotencyKey: "pay_1" }).success, true);
});

// ───────────────────────────── entrega ─────────────────────────────

test("sucesso na primeira tentativa: SUCCESS, attempt 1, headers de evento/delivery, assinatura válida, payload persistido", async () => {
  const { server, url, received } = await startReceiver(() => ({ status: 200 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    assert.equal(r.deliveries, 1);
    assert.equal(r.idempotent, false);
    const d = await deliveryOf(r.eventId);
    assert.equal(d.status, "SUCCESS");
    assert.equal(d.attempt, 1);
    assert.equal(d.responseStatus, 200);
    assert.ok(d.latencyMs != null);
    const h = received[0]!.headers;
    assert.equal(h["x-ul-event-id"], r.eventId);
    assert.equal(h["x-ul-delivery-id"], d.id);
    assert.equal(h["x-ul-delivery-attempt"], "1");
    assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: Number(h["x-ul-timestamp"]), rawBody: received[0]!.body, signature: String(h["x-ul-signature"]) }), true);
    const [event] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, r.eventId));
    assert.deepEqual(event!.payload, { paymentId: "pay_1" });
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("500 → retry agendado na MESMA delivery; sucesso depois do retry com o MESMO event id e delivery id", async () => {
  const { server, url, received } = await startReceiver((n) => ({ status: n === 1 ? 500 : 200 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    let d = await deliveryOf(r.eventId);
    assert.equal(d.status, "PENDING");
    assert.equal(d.attempt, 1);
    assert.equal(d.responseStatus, 500);
    assert.ok(d.nextAttemptAt && d.nextAttemptAt.getTime() > Date.now() + 20_000, "próxima tentativa com backoff");
    assert.equal((await processDueWebhookDeliveries()).attempted >= 0, true);
    assert.equal(received.length, 1, "não é tentada antes da hora");

    await makeDue(d.id);
    await processDueWebhookDeliveries();
    d = await deliveryOf(r.eventId);
    assert.equal(d.status, "SUCCESS");
    assert.equal(d.attempt, 2);
    assert.equal(received.length, 2);
    assert.equal(received[1]!.headers["x-ul-event-id"], r.eventId);
    assert.equal(received[1]!.headers["x-ul-delivery-id"], d.id);
    assert.equal(received[1]!.headers["x-ul-delivery-attempt"], "2");
    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, r.eventId));
    assert.equal(deliveries.length, 1, "nunca uma nova delivery por retry");
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("429 com Retry-After → retry agendado para o momento pedido", async () => {
  const { server, url } = await startReceiver(() => ({ status: 429, headers: { "retry-after": "120" } }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    const d = await deliveryOf(r.eventId);
    assert.equal(d.status, "PENDING");
    const delta = d.nextAttemptAt!.getTime() - Date.now();
    assert.ok(delta > 110_000 && delta <= 121_000, `Retry-After respeitado (${delta}ms)`);
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("400 → FAILED sem retry", async () => {
  const { server, url, received } = await startReceiver(() => ({ status: 400 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    const d = await deliveryOf(r.eventId);
    assert.equal(d.status, "FAILED");
    assert.equal(d.nextAttemptAt, null);
    await processDueWebhookDeliveries();
    assert.equal(received.length, 1);
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("3xx → FAILED e o redirect NÃO é seguido (o payload assinado nunca vai para outro host)", async () => {
  const other = await startReceiver(() => ({ status: 200 }));
  const { server, url } = await startReceiver(() => ({ status: 307, headers: { location: other.url } }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    assert.equal((await deliveryOf(r.eventId)).status, "FAILED");
    assert.equal(other.received.length, 0);
  } finally {
    server.close();
    other.server.close();
    await deleteTestOrganization(orgId);
  }
});

test("falha de rede (ligação cortada) → retry", async () => {
  const { server, url } = await startReceiver(() => ({ destroy: true }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    const d = await deliveryOf(r.eventId);
    assert.equal(d.status, "PENDING");
    assert.equal(d.responseStatus, null);
    assert.match(d.lastError ?? "", /network error/);
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("timeout → retry (o receptor não responde dentro do prazo)", { timeout: 30_000 }, async () => {
  const { server, url } = await startReceiver(() => ({ status: 200, delayMs: WEBHOOK_RETRY_POLICY.timeoutMs + 2_000 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    const d = await deliveryOf(r.eventId);
    assert.equal(d.status, "PENDING");
    assert.match(d.lastError ?? "", /timeout/);
  } finally {
    server.closeAllConnections();
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("tentativas esgotadas → EXHAUSTED (estado final, nunca mais tentada)", async () => {
  const { server, url, received } = await startReceiver(() => ({ status: 503 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    const d = await deliveryOf(r.eventId);
    await db.update(webhookDeliveries).set({ attempt: WEBHOOK_RETRY_POLICY.maxAttempts - 1 }).where(eq(webhookDeliveries.id, d.id));
    await makeDue(d.id);
    await processDueWebhookDeliveries();
    const final = await deliveryOf(r.eventId);
    assert.equal(final.status, "EXHAUSTED");
    assert.equal(final.attempt, WEBHOOK_RETRY_POLICY.maxAttempts);
    assert.equal(final.nextAttemptAt, null);
    const before = received.length;
    await processDueWebhookDeliveries();
    assert.equal(received.length, before);
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("restart: uma delivery presa por um worker morto (lease expirado) é retomada por um worker novo", async () => {
  const { server, url, received } = await startReceiver((n) => ({ status: n === 1 ? 500 : 200 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    const d = await deliveryOf(r.eventId);
    await db
      .update(webhookDeliveries)
      .set({ lockedBy: "worker-que-morreu", lockedUntil: sql`now() - interval '1 second'`, nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(webhookDeliveries.id, d.id));
    await processDueWebhookDeliveries({ workerId: "worker-novo" });
    assert.equal((await deliveryOf(r.eventId)).status, "SUCCESS");
    assert.equal(received.length, 2);
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("uma delivery com lease activo de outro worker não é roubada", async () => {
  const { server, url, received } = await startReceiver((n) => ({ status: n === 1 ? 500 : 200 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    const d = await deliveryOf(r.eventId);
    await db
      .update(webhookDeliveries)
      .set({ lockedBy: "worker-vivo", lockedUntil: sql`now() + interval '1 minute'`, nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(webhookDeliveries.id, d.id));
    await processDueWebhookDeliveries({ workerId: "outro-worker" });
    assert.equal(received.length, 1);
    assert.equal((await deliveryOf(r.eventId)).status, "PENDING");
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("concorrência: dois workers em simultâneo → a delivery é tentada exactamente uma vez", async () => {
  const { server, url, received } = await startReceiver((n) => ({ status: n === 1 ? 500 : 200, delayMs: n === 1 ? 0 : 200 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    await makeDue((await deliveryOf(r.eventId)).id);
    await Promise.all([processDueWebhookDeliveries({ workerId: "w1" }), processDueWebhookDeliveries({ workerId: "w2" }), processDueWebhookDeliveries({ workerId: "w3" })]);
    assert.equal(received.length, 2, "1 tentativa inicial + exactamente 1 retry");
    assert.equal((await deliveryOf(r.eventId)).status, "SUCCESS");
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("claim atómico: enquanto um worker segura a delivery (transacção aberta), outro claim devolve vazio SEM bloquear (SKIP LOCKED)", { timeout: 8_000 }, async () => {
  const { server, url } = await startReceiver(() => ({ status: 500 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    const d = await deliveryOf(r.eventId);
    await makeDue(d.id);
    await db.transaction(async (tx) => {
      const mine = await claimDueDeliveries("tx-worker", { deliveryId: d.id, limit: 1 }, tx);
      assert.equal(mine.length, 1);
      const startedAt = Date.now();
      const theirs = await claimDueDeliveries("other-worker", { deliveryId: d.id, limit: 1 }); // outra ligação
      assert.equal(theirs.length, 0);
      assert.ok(Date.now() - startedAt < 2_000, "não pode ficar à espera do lock");
      throw new Error("rollback"); // larga o claim de propósito
    }).catch((err) => {
      if (!(err instanceof Error) || err.message !== "rollback") throw err;
    });
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("delivery já concluída nunca é reenviada", async () => {
  const { server, url, received } = await startReceiver(() => ({ status: 200 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    await db.update(webhookDeliveries).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(webhookDeliveries.eventId, r.eventId));
    await processDueWebhookDeliveries();
    assert.equal(received.length, 1);
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("endpoint revogado com delivery pendente → FAILED sem envio", async () => {
  const { server, url, received } = await startReceiver(() => ({ status: 500 }));
  const { orgId, endpointId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    await db.update(webhookEndpoints).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(webhookEndpoints.id, endpointId));
    await makeDue((await deliveryOf(r.eventId)).id);
    await processDueWebhookDeliveries();
    const d = await deliveryOf(r.eventId);
    assert.equal(d.status, "FAILED");
    assert.equal(d.lastError, "endpoint revoked");
    assert.equal(received.length, 1);
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

// ───────────────────────────── dedupe ─────────────────────────────

test("evento duplicado no PUBLICADOR (mesma idempotencyKey) → o mesmo evento, nenhuma entrega nova", async () => {
  const { server, url, received } = await startReceiver(() => ({ status: 200 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const first = await publish(orgId, { idempotencyKey: "payment:pay_42" });
    const second = await publish(orgId, { idempotencyKey: "payment:pay_42", data: { paymentId: "outro" } });
    assert.equal(second.eventId, first.eventId);
    assert.equal(second.idempotent, true);
    assert.equal(received.length, 1);
    const events = await db.select().from(webhookEvents).where(and(eq(webhookEvents.organizationId, orgId), eq(webhookEvents.idempotencyKey, "payment:pay_42")));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, { paymentId: "pay_1" }, "o payload original não é sobrescrito");

    const third = await publish(orgId); // sem chave → evento novo
    assert.notEqual(third.eventId, first.eventId);
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("receptor idempotente: processou mas respondeu 500 → o retry traz o MESMO X-UL-Event-Id e o receptor não reprocessa", async () => {
  const processed = new Set<string>();
  let sideEffects = 0;
  const { server, url, received } = await startReceiver((n, req) => {
    const eventId = String(req.headers["x-ul-event-id"]);
    if (!processed.has(eventId)) {
      processed.add(eventId);
      sideEffects++; // ex.: enviar a notificação de pagamento
    }
    return { status: n === 1 ? 500 : 200 }; // 1.ª resposta perdeu-se/falhou depois de processar
  });
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    await makeDue((await deliveryOf(r.eventId)).id);
    await processDueWebhookDeliveries();
    assert.equal(received.length, 2);
    assert.equal(sideEffects, 1, "efeito executado uma única vez");
    assert.equal(received[0]!.headers["x-ul-event-id"], received[1]!.headers["x-ul-event-id"]);
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});

test("HMAC/replay: cada tentativa é assinada com o seu timestamp; corpo adulterado, segredo errado e timestamp antigo são rejeitados", async () => {
  const { server, url, received } = await startReceiver((n) => ({ status: n === 1 ? 500 : 200 }));
  const { orgId } = await setupEndpoint(url);
  try {
    const r = await publish(orgId);
    await makeDue((await deliveryOf(r.eventId)).id);
    await processDueWebhookDeliveries();
    for (const req of received) {
      const ts = Number(req.headers["x-ul-timestamp"]);
      const sig = String(req.headers["x-ul-signature"]);
      assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: ts, rawBody: req.body, signature: sig }), true);
      assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: ts, rawBody: req.body.replace("pay_1", "pay_X"), signature: sig }), false);
      assert.equal(verifyWebhookSignature({ secret: "whsec_errado", timestamp: ts, rawBody: req.body, signature: sig }), false);
      assert.equal(
        verifyWebhookSignature({ secret: SECRET, timestamp: ts, rawBody: req.body, signature: sig, toleranceSeconds: -1 }),
        false,
        "uma captura fora da janela de tolerância é rejeitada (replay)"
      );
    }
  } finally {
    server.close();
    await deleteTestOrganization(orgId);
  }
});
