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
  const {
    applicationEnvironments,
    applicationIntegrations,
    applications,
    auditLogs,
    organizations,
    platformMemberships,
    platformRoles,
    users,
  } = await import("../src/db/schema/index.js");
  const { seed } = await import("../src/db/seed/index.js");
  const { verifyWebhookSignature } = await import("../src/modules/webhooks/signature.js");
  const { EXPECTED_ISSUER } = await import("../src/integrations/supabase/jwt.js");
  const { eq, or } = await import("drizzle-orm");

  const BASE = `http://127.0.0.1:${env.PORT}/v1`;

  async function call(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; origin?: string; headers?: Record<string, string> } = {},
  ) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...opts.headers,
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
    return {
      status: res.status,
      headers: res.headers,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- smoke script only, response shape varies per assertion
      json: json as { data?: any; error?: any } | undefined,
    };
  }

  async function mintUserToken(userId: string, email: string) {
    const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    return new SignJWT({ email, aud: "authenticated", role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setIssuer(EXPECTED_ISSUER)
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
  check("GET /health -> 200", r.status === 200 && r.json?.data?.status === "ok");

  r = await call("GET", "/health/ready");
  check("GET /health/ready -> 200 (DB reachable)", r.status === 200 && r.json?.data?.status === "ready");
  check(
    "readiness response never mentions the database host/connection string",
    !JSON.stringify(r.json ?? {}).includes("supabase.co") && !JSON.stringify(r.json ?? {}).includes("postgres://"),
  );

  // --- Request ID ---

  r = await call("GET", "/health");
  check("every response carries an X-Request-ID header", Boolean(r.headers.get("x-request-id")));

  r = await call("GET", "/health", { headers: { "X-Request-ID": "client-supplied-id-123" } });
  check("a valid client-supplied X-Request-ID is echoed back, not replaced", r.headers.get("x-request-id") === "client-supplied-id-123");

  r = await call("GET", "/health", { headers: { "X-Request-ID": "invalid id with spaces!" } });
  check(
    "an invalid client-supplied X-Request-ID is replaced with a fresh one, not rejected or passed through",
    r.status === 200 && r.headers.get("x-request-id") !== "invalid id with spaces!" && Boolean(r.headers.get("x-request-id")),
  );

  // --- CORS ---

  r = await call("GET", "/health", { origin: env.PLATFORM_ALLOWED_ORIGINS[0] });
  check(
    "an allow-listed origin receives Access-Control-Allow-Origin",
    r.headers.get("access-control-allow-origin") === env.PLATFORM_ALLOWED_ORIGINS[0],
  );

  r = await call("GET", "/health", { origin: "https://not-an-allowed-origin.example" });
  check(
    "a disallowed origin receives no Access-Control-Allow-Origin (browser will block the response)",
    r.headers.get("access-control-allow-origin") === null,
  );

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

  // --- Service Discovery ---

  r = await call("POST", `/organizations/${orgAId}/api-keys`, {
    token: tokenA,
    body: { applicationKey: "QUALE_A_DICA", scopes: [] },
  });
  check("create a QUALE_A_DICA credential with zero scopes -> 201", r.status === 201);
  const qualeADicaKey: string = r.json?.data?.secret;

  r = await call("GET", `/service/discover?target=NA_PISTA&environment=staging`, { token: qualeADicaKey });
  check("service discovery (valid, fully-active chain) -> 200", r.status === 200);
  check(
    "discovery returns the seeded staging endpoint",
    r.json?.data?.endpoint?.baseUrl === "https://staging.na-pista.example" && r.json?.data?.endpoint?.type === "API",
  );
  check("discovery response has no organizationId field", !("organizationId" in (r.json?.data ?? {})));
  check(
    "discovery response never mentions a secret",
    !JSON.stringify(r.json?.data ?? {}).toLowerCase().includes("secret"),
  );
  check(
    "discovery works with zero granted scopes — authorized by the integration registry, not Service Scopes",
    r.status === 200,
  );

  r = await call("GET", `/service/discover?target=NA_PISTA&environment=staging`, { token: tokenA });
  check("a human JWT cannot use service discovery -> 403", r.status === 403);

  r = await call("GET", `/service/discover?target=NOT_A_REAL_APP&environment=staging`, { token: qualeADicaKey });
  check("discovery of an unknown target application -> 404", r.status === 404);

  r = await call("GET", `/service/discover?target=NA_PISTA&environment=not_a_real_env`, { token: qualeADicaKey });
  check("discovery of an unknown environment -> 404", r.status === 404);

  r = await call("GET", `/service/discover?target=NA_PISTA&environment=production`, { token: qualeADicaKey });
  check("discovery of an unconfigured (no-endpoint) production environment -> 404", r.status === 404);

  r = await call("GET", `/service/discover?target=MICHA_EXPRESS&environment=staging`, { token: qualeADicaKey });
  check("discovery rejected for a target with no registered integration -> 403", r.status === 403);

  r = await call("POST", `/organizations/${orgAId}/api-keys`, {
    token: tokenA,
    body: { applicationKey: "MICHA_EXPRESS", scopes: [] },
  });
  const michaExpressKey: string = r.json?.data?.secret;
  r = await call("GET", `/service/discover?target=NA_PISTA&environment=staging&source=QUALE_A_DICA`, {
    token: michaExpressKey,
  });
  check(
    "a spoofed source query param is ignored — the real (unauthorized) credential identity is used -> 403",
    r.status === 403,
  );

  r = await call("GET", `/service/discover?target=NA_PISTA&environment=staging&organizationId=${orgBId}`, {
    token: qualeADicaKey,
  });
  check(
    "an arbitrary organizationId query param has no effect — discovery is not organization-scoped -> 200",
    r.status === 200 && !("organizationId" in (r.json?.data ?? {})),
  );

  // --- Platform Administration ---
  // Grants a platform-admin fixture directly (bypassing the one-time
  // bootstrap restriction — see modules/platformAdmins/bootstrap.ts, which
  // deliberately refuses once *any* real admin exists on this shared
  // database). Mirrors how this script already seeds organizations/API
  // keys directly rather than going through a setup-only HTTP endpoint.

  const platformAdminId = randomUUID();
  const platformAdminToken = await mintUserToken(
    platformAdminId,
    `smoke-platform-admin-${platformAdminId}@test.ul-platform.invalid`,
  );
  await call("GET", "/me", { token: platformAdminToken }); // materializes the `users` row via ensureUserExists
  const [platformAdminRoleRow] = await db
    .select({ id: platformRoles.id })
    .from(platformRoles)
    .where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  if (!platformAdminRoleRow) throw new Error("PLATFORM_ADMIN role not seeded");
  await db.insert(platformMemberships).values({ userId: platformAdminId, platformRoleId: platformAdminRoleRow.id });

  const plainUserId = randomUUID();
  const plainUserToken = await mintUserToken(plainUserId, `smoke-plain-${plainUserId}@test.ul-platform.invalid`);
  await call("GET", "/me", { token: plainUserToken }); // materializes the `users` row, no org, no platform role

  r = await call("GET", "/platform/me", { token: platformAdminToken });
  check(
    "GET /platform/me for the platform admin reports platformAdmin: true",
    r.status === 200 && r.json?.data?.platformAdmin === true && r.json?.data?.platformRole === "PLATFORM_ADMIN",
  );

  r = await call("GET", "/platform/me", { token: tokenA });
  check(
    "GET /platform/me for an Organization OWNER (no platform role) reports platformAdmin: false, not an error",
    r.status === 200 && r.json?.data?.platformAdmin === false,
  );

  r = await call("POST", "/applications", { token: tokenA, body: { key: "SMOKE_SHOULD_FAIL", name: "x" } });
  check("POST /applications as an Organization OWNER -> 403", r.status === 403);

  r = await call("POST", "/applications", { token: plainUserToken, body: { key: "SMOKE_SHOULD_FAIL", name: "x" } });
  check("POST /applications as a plain authenticated user -> 403", r.status === 403);

  r = await call("POST", "/applications", { body: { key: "SMOKE_SHOULD_FAIL", name: "x" } });
  check("POST /applications with no bearer token -> 401", r.status === 401);

  r = await call("POST", "/applications", { token: "Bearer garbage-not-a-real-token", body: { key: "x", name: "x" } });
  check("POST /applications with a malformed token -> 401", r.status === 401);

  const smokeAppKey = `SMOKE_APP_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  r = await call("POST", "/applications", {
    token: platformAdminToken,
    body: { key: smokeAppKey, name: "Smoke Test App", description: "created by scripts/smoke.ts" },
  });
  check("POST /applications as PLATFORM_ADMIN -> 201", r.status === 201 && r.json?.data?.status === "ACTIVE");

  r = await call("POST", "/applications", { token: platformAdminToken, body: { key: smokeAppKey, name: "dup" } });
  check("POST /applications with a duplicate key -> 409", r.status === 409);

  r = await call("PATCH", `/applications/${smokeAppKey}`, { token: platformAdminToken, body: { status: "SUSPENDED" } });
  check("PATCH /applications/:key as PLATFORM_ADMIN -> 200, SUSPENDED", r.status === 200 && r.json?.data?.status === "SUSPENDED");

  r = await call("PATCH", `/applications/${smokeAppKey}`, { token: tokenA, body: { status: "ACTIVE" } });
  check("PATCH /applications/:key as an Organization OWNER -> 403", r.status === 403);

  r = await call("PATCH", "/applications/NOT_A_REAL_APP", { token: platformAdminToken, body: { status: "ACTIVE" } });
  check("PATCH /applications/:key for an unknown application -> 404", r.status === 404);

  const appCreatedAudit = await db.select().from(auditLogs).where(eq(auditLogs.targetId, smokeAppKey));
  check(
    "platform.application.created was audited for this exact key",
    appCreatedAudit.some((e) => e.action === "platform.application.created"),
  );

  r = await call("POST", `/applications/${smokeAppKey}/environments`, { token: platformAdminToken, body: { key: "staging" } });
  check("POST .../environments as PLATFORM_ADMIN -> 201", r.status === 201);

  r = await call("POST", `/applications/${smokeAppKey}/environments`, { token: tokenA, body: { key: "production" } });
  check("POST .../environments as an Organization OWNER -> 403", r.status === 403);

  r = await call("PATCH", `/applications/${smokeAppKey}/environments/staging`, {
    token: platformAdminToken,
    body: { status: "INACTIVE" },
  });
  check("PATCH .../environments/:key as PLATFORM_ADMIN -> 200, INACTIVE", r.status === 200 && r.json?.data?.status === "INACTIVE");
  await call("PATCH", `/applications/${smokeAppKey}/environments/staging`, { token: platformAdminToken, body: { status: "ACTIVE" } });

  r = await call("POST", `/applications/${smokeAppKey}/environments/staging/endpoints`, {
    token: platformAdminToken,
    body: { type: "API", baseUrl: "http://insecure-not-production.example" },
  });
  check("POST .../endpoints with a valid non-production http URL -> 201", r.status === 201);

  r = await call("POST", `/applications/${smokeAppKey}/environments/staging/endpoints`, {
    token: platformAdminToken,
    body: { type: "API", baseUrl: "https://duplicate.example" },
  });
  check("POST .../endpoints duplicate type for the same environment -> 409", r.status === 409);

  r = await call("PATCH", `/applications/${smokeAppKey}/environments/staging/endpoints/API`, {
    token: platformAdminToken,
    body: { status: "INACTIVE" },
  });
  check("PATCH .../endpoints/:type as PLATFORM_ADMIN -> 200, INACTIVE", r.status === 200 && r.json?.data?.status === "INACTIVE");

  r = await call("POST", `/applications/${smokeAppKey}/environments`, { token: platformAdminToken, body: { key: "production" } });
  const prodEnvOk = r.status === 201;
  r = await call("POST", `/applications/${smokeAppKey}/environments/production/endpoints`, {
    token: platformAdminToken,
    body: { type: "API", baseUrl: "http://not-https-in-production.example" },
  });
  check("POST .../endpoints rejects insecure HTTP in a production environment -> 400", prodEnvOk && r.status === 400);

  r = await call("POST", `/applications/QUALE_A_DICA/integrations/${smokeAppKey}`, {
    token: platformAdminToken,
    body: { description: "smoke test integration" },
  });
  check("POST .../integrations/:target as PLATFORM_ADMIN -> 201", r.status === 201);

  r = await call("POST", `/applications/QUALE_A_DICA/integrations/${smokeAppKey}`, { token: tokenA, body: {} });
  check("POST .../integrations/:target as an Organization OWNER -> 403", r.status === 403);

  r = await call("PATCH", `/applications/QUALE_A_DICA/integrations/${smokeAppKey}`, {
    token: platformAdminToken,
    body: { status: "INACTIVE" },
  });
  check("PATCH .../integrations/:target as PLATFORM_ADMIN -> 200, INACTIVE", r.status === 200 && r.json?.data?.status === "INACTIVE");

  r = await call("GET", "/platform/admins", { token: tokenA });
  check("GET /platform/admins as an Organization OWNER -> 403", r.status === 403);

  r = await call("GET", "/platform/admins", { token: platformAdminToken });
  check(
    "GET /platform/admins as PLATFORM_ADMIN -> 200, includes the bootstrap fixture",
    r.status === 200 && (r.json?.data ?? []).some((a: { userId: string }) => a.userId === platformAdminId),
  );

  // tokenB (org B's owner) is deliberately the actor for every "OWNER, not a
  // platform admin" check below — ownerAId is about to be granted platform
  // authority itself in this same flow, so reusing tokenA here would stop
  // proving what the assertion name claims.
  r = await call("POST", "/platform/admins", { token: tokenB, body: { userId: ownerAId } });
  check("POST /platform/admins as an Organization OWNER (not a platform admin) -> 403", r.status === 403);

  r = await call("POST", "/platform/admins", { token: platformAdminToken, body: { userId: ownerAId } });
  check("POST /platform/admins grants a second admin -> 201", r.status === 201 && r.json?.data?.status === "ACTIVE");

  r = await call("PATCH", `/platform/admins/${ownerAId}`, { token: platformAdminToken, body: { status: "REVOKED" } });
  check("PATCH /platform/admins/:userId revokes the second admin -> 200, REVOKED", r.status === 200 && r.json?.data?.status === "REVOKED");

  r = await call("PATCH", `/platform/admins/${platformAdminId}`, {
    token: platformAdminToken,
    body: { status: "REVOKED" },
  });
  check(
    "PATCH /platform/admins/:userId refuses to revoke the platform's last active administrator -> 409",
    r.status === 409,
  );

  // --- Platform Audit ---

  r = await call("GET", "/platform/audit-logs", { token: tokenA });
  check("GET /platform/audit-logs as an Organization OWNER -> 403", r.status === 403);

  r = await call("GET", "/platform/audit-logs", { token: platformAdminToken });
  check(
    "GET /platform/audit-logs as PLATFORM_ADMIN -> 200, paginated shape",
    r.status === 200 && Array.isArray(r.json?.data?.items) && "nextCursor" in (r.json?.data ?? {}),
  );

  r = await call(
    "GET",
    `/platform/audit-logs?action=platform.application.created&targetId=${smokeAppKey}`,
    { token: platformAdminToken },
  );
  check(
    "audit log finds this run's own platform.application.created event",
    r.status === 200 && (r.json?.data?.items ?? []).some((e: { targetId: string }) => e.targetId === smokeAppKey),
  );

  r = await call("GET", "/platform/audit-logs?limit=1000000", { token: platformAdminToken });
  check("GET /platform/audit-logs with an oversized limit is rejected, not silently clamped -> 400", r.status === 400);

  r = await call("GET", "/platform/audit-logs?cursor=not-a-real-cursor", { token: platformAdminToken });
  check("GET /platform/audit-logs with a malformed cursor -> 400", r.status === 400);

  r = await call("GET", `/platform/audit-logs?action=api_key.created`, { token: platformAdminToken });
  check(
    "the control-plane audit endpoint never returns a tenant event (api_key.created), even filtered by its exact action",
    r.status === 200 && (r.json?.data?.items ?? []).length === 0,
  );

  // --- Platform Credentials (platform-level API keys, organizationId = null) ---

  r = await call("POST", "/platform/credentials", { token: tokenA, body: { applicationKey: "NA_PISTA" } });
  check("POST /platform/credentials as an Organization OWNER -> 403", r.status === 403);

  r = await call("POST", "/platform/credentials", {
    token: platformAdminToken,
    body: { applicationKey: "NA_PISTA", scopes: ["catalog.read"] },
  });
  check(
    "POST /platform/credentials as PLATFORM_ADMIN -> 201, secret shown once",
    r.status === 201 && typeof r.json?.data?.secret === "string" && r.json.data.secret.startsWith("ulk_"),
  );
  check("platform credential has organizationId: null", r.json?.data?.organizationId === null);
  const platformCredentialId: string = r.json?.data?.id;
  const platformCredentialSecret: string = r.json?.data?.secret;

  r = await call("GET", "/platform/credentials", { token: tokenA });
  check("GET /platform/credentials as an Organization OWNER -> 403", r.status === 403);

  r = await call("GET", "/platform/credentials", { token: platformAdminToken });
  check(
    "GET /platform/credentials as PLATFORM_ADMIN -> 200, includes the key just created, never a secret field",
    r.status === 200 &&
      (r.json?.data ?? []).some((k: { id: string }) => k.id === platformCredentialId) &&
      !JSON.stringify(r.json?.data ?? []).includes(platformCredentialSecret),
  );

  r = await call("GET", "/service/me", { token: platformCredentialSecret });
  check(
    "the new platform credential authenticates and reports organizationId: null via /service/me",
    r.status === 200 && r.json?.data?.application === "NA_PISTA" && r.json?.data?.organizationId === null,
  );

  r = await call("POST", `/platform/credentials/${platformCredentialId}/revoke`, { token: tokenA });
  check("POST /platform/credentials/:id/revoke as an Organization OWNER -> 403", r.status === 403);

  r = await call("POST", `/platform/credentials/${platformCredentialId}/revoke`, { token: platformAdminToken });
  check(
    "POST /platform/credentials/:id/revoke as PLATFORM_ADMIN -> 200, REVOKED",
    r.status === 200 && r.json?.data?.status === "REVOKED",
  );

  r = await call("POST", `/platform/credentials/${platformCredentialId}/revoke`, { token: platformAdminToken });
  check("revoking an already-revoked platform credential -> 409", r.status === 409);

  r = await call("GET", "/service/me", { token: platformCredentialSecret });
  check("a revoked platform credential can no longer authenticate -> 401", r.status === 401);

  r = await call("POST", `/organizations/${orgAId}/api-keys`, {
    token: tokenA,
    body: { applicationKey: "NA_PISTA", scopes: [] },
  });
  const orgScopedKeyId: string = r.json?.data?.id;
  r = await call("POST", `/platform/credentials/${orgScopedKeyId}/revoke`, { token: platformAdminToken });
  check(
    "the platform credential revoke route can never reach an Organization's own key -> 404",
    r.status === 404,
  );
  await call("POST", `/organizations/${orgAId}/api-keys/${orgScopedKeyId}/revoke`, { token: tokenA });

  receiver.close();

  // Platform-level fixtures created directly through the mutation endpoints
  // above are real rows in the shared application/environment/integration
  // registries — clean them up explicitly so repeated `npm run smoke` runs
  // don't accumulate SMOKE_APP_* junk applications. FK order matters:
  // integrations/environments (RESTRICT on applicationId) before the
  // application row itself; environments cascade their own endpoints.
  const [smokeApp] = await db.select({ id: applications.id }).from(applications).where(eq(applications.key, smokeAppKey));
  if (smokeApp) {
    await db
      .delete(applicationIntegrations)
      .where(
        or(
          eq(applicationIntegrations.sourceApplicationId, smokeApp.id),
          eq(applicationIntegrations.targetApplicationId, smokeApp.id),
        ),
      );
    await db.delete(applicationEnvironments).where(eq(applicationEnvironments.applicationId, smokeApp.id));
    await db.delete(applications).where(eq(applications.id, smokeApp.id));
  }

  await db.delete(organizations).where(eq(organizations.id, orgAId));
  await db.delete(organizations).where(eq(organizations.id, orgBId));
  await db.delete(users).where(eq(users.id, ownerAId)); // cascades platform_memberships (granted above)
  await db.delete(users).where(eq(users.id, ownerBId));
  await db.delete(users).where(eq(users.id, platformAdminId)); // cascades platform_memberships
  await db.delete(users).where(eq(users.id, plainUserId));
  await queryClient.end();

  console.log(`\n${passed}/${passed + failed} smoke assertions passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exit(1);
});
