import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { SignJWT } from "jose";

/**
 * Live HTTP smoke test for Service Scopes + Webhook Infrastructure. Starts
 * the real Express app in-process (no mocking) and drives it exactly like
 * an external client would: real bearer tokens (a Supabase-shaped JWT
 * signed locally with the same shared HS256 secret the app verifies with —
 * no real Supabase project needed for this), real `ulk_` API keys, and a
 * real local HTTP receiver for webhook deliveries so the outbound
 * signature can be independently verified end to end.
 *
 * Run with `npm run smoke` against a real, migrated, seeded database. Not
 * part of `npm test` — it binds real ports and makes real HTTP calls.
 */

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL - ${name}`, extra ?? "");
  }
}

interface CapturedDelivery {
  headers: http.IncomingHttpHeaders;
  body: string;
}

function startReceiver(port: number, received: CapturedDelivery[]): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const { env } = await import("../src/config/env.js");
  const { db, queryClient } = await import("../src/db/index.js");
  const { organizations, users } = await import("../src/db/schema/index.js");
  const { seed } = await import("../src/db/seed/index.js");
  const { verifyWebhookSignature } = await import("../src/modules/webhooks/signature.js");
  const { eq } = await import("drizzle-orm");

  const BASE = `http://127.0.0.1:${env.PORT}/v1`;

  async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- smoke script only, response shape varies per assertion
    return { status: res.status, json: json as { data?: any; error?: any } | undefined };
  }

  async function mintUserToken(userId: string, email: string) {
    const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    return new SignJWT({ email, aud: "authenticated", role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(secret);
  }

  const received: CapturedDelivery[] = [];
  const receiverPort = 4311;
  const receiver = await startReceiver(receiverPort, received);

  await seed();
  await import("../src/server.js"); // starts listening on env.PORT as a side effect

  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const ownerAId = randomUUID();
  const ownerBId = randomUUID();
  const tokenA = await mintUserToken(ownerAId, `smoke-a-${ownerAId}@test.ul-platform.invalid`);
  const tokenB = await mintUserToken(ownerBId, `smoke-b-${ownerBId}@test.ul-platform.invalid`);

  let r = await call("GET", "/health");
  check("GET /health -> 200", r.status === 200);

  r = await call("GET", "/me", { token: tokenA });
  check("GET /me (fresh user) -> 200", r.status === 200);
  check("fresh user has no memberships yet", (r.json?.data?.memberships ?? []).length === 0);

  r = await call("POST", "/organizations", { token: tokenA, body: { name: `Smoke Org A ${ownerAId}` } });
  check("POST /organizations (org A) -> 201", r.status === 201);
  const orgAId: string = r.json?.data?.id;

  r = await call("POST", "/organizations", { token: tokenB, body: { name: `Smoke Org B ${ownerBId}` } });
  check("POST /organizations (org B) -> 201", r.status === 201);
  const orgBId: string = r.json?.data?.id;

  // --- Service Scopes ---

  r = await call("GET", "/service-scopes", { token: tokenA });
  check("GET /service-scopes -> 200", r.status === 200 && Array.isArray(r.json?.data));
  check(
    "registry includes event.publish",
    (r.json?.data ?? []).some((s: { key: string }) => s.key === "event.publish"),
  );

  r = await call("GET", "/applications/NA_PISTA/service-scopes", { token: tokenA });
  check("GET /applications/:key/service-scopes -> 200", r.status === 200);
  const naPistaScopes: string[] = (r.json?.data?.scopes ?? []).map((s: { key: string }) => s.key);
  check("NA_PISTA allowlist includes catalog.read", naPistaScopes.includes("catalog.read"));
  check("NA_PISTA allowlist excludes payment.create", !naPistaScopes.includes("payment.create"));

  r = await call("POST", `/organizations/${orgAId}/api-keys`, {
    token: tokenA,
    body: { applicationKey: "NA_PISTA", scopes: ["catalog.read", "event.publish"] },
  });
  check("create API key with valid scopes -> 201", r.status === 201);
  check(
    "granted scopes echoed back",
    JSON.stringify([...(r.json?.data?.scopes ?? [])].sort()) === JSON.stringify(["catalog.read", "event.publish"]),
  );
  const apiKeySecret: string = r.json?.data?.secret;

  r = await call("POST", `/organizations/${orgAId}/api-keys`, {
    token: tokenA,
    body: { applicationKey: "NA_PISTA", scopes: ["not.a.real.scope"] },
  });
  check("unknown scope -> 400", r.status === 400);

  r = await call("POST", `/organizations/${orgAId}/api-keys`, {
    token: tokenA,
    body: { applicationKey: "NA_PISTA", scopes: ["payment.create"] },
  });
  check("cross-application (unauthorized) scope -> 403", r.status === 403);

  r = await call("GET", "/service/me", { token: apiKeySecret });
  check("GET /service/me (service credential) -> 200", r.status === 200);
  check("service/me reports its own application", r.json?.data?.application === "NA_PISTA");
  check("service/me reports its granted scopes", (r.json?.data?.scopes ?? []).includes("catalog.read"));

  r = await call("GET", "/service/me", { token: tokenA });
  check("GET /service/me with a human JWT -> 403", r.status === 403);

  // --- Webhooks ---

  r = await call("POST", `/organizations/${orgAId}/webhooks`, {
    token: tokenA,
    body: {
      applicationKey: "NA_PISTA",
      url: `http://127.0.0.1:${receiverPort}/hook`,
      eventTypes: ["smoke.pinged"],
    },
  });
  check("POST webhooks -> 201", r.status === 201);
  const webhookId: string = r.json?.data?.id;
  const webhookSecret: string = r.json?.data?.secret;

  r = await call("POST", `/organizations/${orgAId}/events`, {
    token: apiKeySecret,
    body: { type: "smoke.pinged", data: { hello: "world" } },
  });
  check("POST events (publish) -> 202", r.status === 202);
  check("publish reports exactly 1 delivery", r.json?.data?.deliveries === 1);
  check("receiver captured exactly 1 delivery", received.length === 1);

  if (received[0]) {
    const timestamp = Number(received[0].headers["x-ul-timestamp"]);
    const signature = String(received[0].headers["x-ul-signature"]);
    const valid = verifyWebhookSignature({ secret: webhookSecret, timestamp, rawBody: received[0].body, signature });
    check("delivered signature verifies against the one-time secret", valid);

    const envelope = JSON.parse(received[0].body);
    check("envelope source.application is trusted (NA_PISTA)", envelope.source?.application === "NA_PISTA");
    check("envelope organizationId matches the publishing org", envelope.organizationId === orgAId);
    check("envelope type matches", envelope.type === "smoke.pinged");
    check("envelope carries a stable event id", typeof envelope.id === "string" && envelope.id.startsWith("evt_"));
  }
  received.length = 0;

  r = await call("POST", `/organizations/${orgAId}/api-keys`, {
    token: tokenA,
    body: { applicationKey: "NA_PISTA", scopes: ["catalog.read"] },
  });
  const noPublishKey: string = r.json?.data?.secret;
  r = await call("POST", `/organizations/${orgAId}/events`, {
    token: noPublishKey,
    body: { type: "smoke.pinged", data: {} },
  });
  check("publish without event.publish scope -> 403", r.status === 403);

  r = await call("POST", `/organizations/${orgBId}/api-keys`, {
    token: tokenB,
    body: { applicationKey: "NA_PISTA", scopes: ["event.publish"] },
  });
  const orgBKey: string = r.json?.data?.secret;
  r = await call("POST", `/organizations/${orgAId}/events`, {
    token: orgBKey,
    body: { type: "smoke.pinged", data: {} },
  });
  check("cross-organization credential cannot publish into org A -> 403", r.status === 403);

  r = await call("POST", `/organizations/${orgAId}/events`, {
    token: tokenA,
    body: { type: "smoke.pinged", data: {} },
  });
  check("a human JWT cannot publish events -> 401", r.status === 401);

  r = await call("GET", `/organizations/${orgAId}/webhooks`, { token: tokenB });
  check("org B cannot list org A's webhooks -> 403", r.status === 403);

  r = await call("POST", `/organizations/${orgAId}/webhooks/${webhookId}/test`, { token: tokenA });
  check("POST webhooks/:id/test -> 200", r.status === 200);
  check("test delivery reports SUCCESS", r.json?.data?.status === "SUCCESS");
  check("receiver captured the test delivery", received.length === 1);
  received.length = 0;

  r = await call("POST", `/organizations/${orgAId}/webhooks/${webhookId}/revoke`, { token: tokenA });
  check("POST webhooks/:id/revoke -> 200", r.status === 200 && r.json?.data?.status === "REVOKED");

  r = await call("POST", `/organizations/${orgAId}/events`, {
    token: apiKeySecret,
    body: { type: "smoke.pinged", data: {} },
  });
  check("publish after revoke is still accepted -> 202", r.status === 202);
  check("publish after revoke reports 0 deliveries", r.json?.data?.deliveries === 0);
  check("revoked endpoint received nothing", received.length === 0);

  // --- Usage / Metering ---

  r = await call("GET", "/meters", { token: tokenA });
  check("GET /meters -> 200", r.status === 200 && Array.isArray(r.json?.data));
  check("meter registry includes orders", (r.json?.data ?? []).some((m: { key: string }) => m.key === "orders"));

  r = await call("GET", "/applications/NA_PISTA/meters", { token: tokenA });
  check("GET /applications/:key/meters -> 200", r.status === 200);
  const naPistaMeterKeys: string[] = (r.json?.data?.meters ?? []).map((m: { key: string }) => m.key);
  check("NA_PISTA meter allowlist includes orders", naPistaMeterKeys.includes("orders"));

  r = await call("POST", `/organizations/${orgAId}/api-keys`, {
    token: tokenA,
    body: { applicationKey: "NA_PISTA", scopes: ["usage.write", "usage.read"] },
  });
  check("create usage-scoped API key -> 201", r.status === 201);
  const usageKeyA: string = r.json?.data?.secret;
  const usageKeyAId: string = r.json?.data?.id;

  const usageIdempotencyKey = `smoke_usage_evt_${randomUUID()}`;
  r = await call("POST", `/organizations/${orgAId}/applications/NA_PISTA/usage`, {
    token: usageKeyA,
    body: { meterKey: "orders", quantity: 2, idempotencyKey: usageIdempotencyKey },
  });
  check("POST usage (record) -> 201", r.status === 201);
  check("recorded usage quantity is 2", r.json?.data?.quantity === 2);
  check("recorded usage is not flagged idempotent on first write", r.json?.data?.idempotent === false);

  r = await call("POST", `/organizations/${orgAId}/applications/NA_PISTA/usage`, {
    token: usageKeyA,
    body: { meterKey: "orders", quantity: 2, idempotencyKey: usageIdempotencyKey },
  });
  check("duplicate POST usage (same idempotency key) -> 200", r.status === 200);
  check("duplicate usage submission is flagged idempotent", r.json?.data?.idempotent === true);

  r = await call("POST", `/organizations/${orgAId}/applications/NA_PISTA/usage`, {
    token: usageKeyA,
    body: { meterKey: "storage_bytes", quantity: 1024, idempotencyKey: `smoke_usage_evt_${randomUUID()}` },
  });
  check("POST usage for a second meter -> 201", r.status === 201);

  r = await call("GET", `/organizations/${orgAId}/applications/NA_PISTA/usage/orders`, { token: tokenA });
  check("GET usage for one meter (human) -> 200", r.status === 200);
  check("aggregated orders quantity did not double-count the duplicate", r.json?.data?.quantity === 2);

  r = await call("GET", `/organizations/${orgAId}/applications/NA_PISTA/usage`, { token: usageKeyA });
  check("GET usage list (service, usage.read) -> 200", r.status === 200);
  const usageMeterKeys: string[] = (r.json?.data?.meters ?? []).map((m: { meter: { key: string } }) => m.meter.key);
  check(
    "usage aggregation lists both recorded meters",
    usageMeterKeys.includes("orders") && usageMeterKeys.includes("storage_bytes"),
  );

  r = await call(
    "GET",
    `/organizations/${orgAId}/applications/NA_PISTA/usage/orders?from=2027-01-01T00:00:00Z&to=2027-01-31T00:00:00Z`,
    { token: tokenA },
  );
  check("empty period returns 200 with zero quantity", r.status === 200 && r.json?.data?.quantity === 0);

  r = await call("POST", `/organizations/${orgAId}/applications/NA_PISTA/usage`, {
    token: orgBKey,
    body: { meterKey: "orders", quantity: 1, idempotencyKey: `smoke_usage_evt_${randomUUID()}` },
  });
  check("cross-organization usage write rejected -> 403", r.status === 403);

  r = await call("POST", `/organizations/${orgAId}/applications/MICHA_EXPRESS/usage`, {
    token: usageKeyA,
    body: { meterKey: "transactions", quantity: 1, idempotencyKey: `smoke_usage_evt_${randomUUID()}` },
  });
  check("cross-application usage write rejected -> 403", r.status === 403);

  r = await call("GET", `/organizations/${orgAId}/applications/NA_PISTA/usage`, { token: tokenB });
  check("cross-organization usage read rejected -> 403", r.status === 403);

  r = await call("POST", `/organizations/${orgAId}/api-keys`, {
    token: tokenA,
    body: { applicationKey: "NA_PISTA", scopes: ["catalog.read"] },
  });
  const noUsageScopeKey: string = r.json?.data?.secret;
  r = await call("POST", `/organizations/${orgAId}/applications/NA_PISTA/usage`, {
    token: noUsageScopeKey,
    body: { meterKey: "orders", quantity: 1, idempotencyKey: `smoke_usage_evt_${randomUUID()}` },
  });
  check("usage write without usage.write scope rejected -> 403", r.status === 403);

  r = await call("POST", `/organizations/${orgAId}/api-keys/${usageKeyAId}/revoke`, { token: tokenA });
  check("revoke the usage-scoped API key -> 200", r.status === 200 && r.json?.data?.status === "REVOKED");

  r = await call("POST", `/organizations/${orgAId}/applications/NA_PISTA/usage`, {
    token: usageKeyA,
    body: { meterKey: "orders", quantity: 1, idempotencyKey: `smoke_usage_evt_${randomUUID()}` },
  });
  check("revoked credential can no longer record usage -> 401", r.status === 401);

  receiver.close();
  await db.delete(organizations).where(eq(organizations.id, orgAId));
  await db.delete(organizations).where(eq(organizations.id, orgBId));
  await db.delete(users).where(eq(users.id, ownerAId));
  await db.delete(users).where(eq(users.id, ownerBId));
  await queryClient.end();

  console.log(`\n${passed}/${passed + failed} smoke assertions passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exit(1);
});
