import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Na Pista manual-validation fixtures (Na Pista F29 — docs/manual-validation.md
 * in the na-pista repo). Dev-only tooling, same family as f19..f27
 * provisioning scripts — no UL Platform production change.
 *
 * Unlike the E2E fixtures (minted JWTs for synthetic user ids), a human must
 * be able to SIGN IN to the Na Pista Console, so this creates REAL Supabase
 * Auth users (Admin API, service-role key read from this repo's .env — never
 * written anywhere) with random passwords, then drives the Platform's own
 * public API with each user's real access token:
 *
 *   MV_PRODUCT_REFERENCE_<run>  — retail/catalog-oriented organization
 *   MV_SERVICE_REFERENCE_<run>  — appointment/service-oriented organization
 *   each with OWNER / ADMIN / MANAGER / STAFF, an active NA_PISTA/BUSINESS
 *   subscription, a platform-facing credential (usage.write, event.publish —
 *   what Na Pista itself needs, see na-pista src/platform/serviceAuth.ts) and
 *   an integration credential (catalog.read, catalog.write).
 *
 * Output: ../na-pista/.fixtures/manual-validation.json (git-ignored there).
 * It contains passwords and credential secrets: never commit, paste or log it.
 * Nothing secret is printed to stdout. No ids are fixed — every run is new.
 *
 * Usage: npm run mv:provision   (requires `npm run dev` already running)
 * Cleanup: npm run mv:teardown
 */
const ROLES = ["OWNER", "ADMIN", "MANAGER", "STAFF"] as const;
const REFERENCES = [
  { key: "PRODUCT_REFERENCE", label: "Mercearia Referência", slug: "product" },
  { key: "SERVICE_REFERENCE", label: "Estúdio Referência", slug: "service" },
] as const;

async function main() {
  const { env } = await import("../src/config/env.js");
  const BASE = `http://127.0.0.1:${env.PORT}/v1`;
  const runId = randomUUID().slice(0, 8);

  async function supabase(path: string, init: { method: string; key: string; bearer?: string; body?: unknown }) {
    const res = await fetch(new URL(path, env.SUPABASE_URL), {
      method: init.method,
      headers: { apikey: init.key, authorization: `Bearer ${init.bearer ?? init.key}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = (await res.json().catch(() => undefined)) as ReturnType<typeof JSON.parse>;
    // Only the status and Supabase's error code — never the request body (passwords).
    if (!res.ok) throw new Error(`Supabase ${init.method} ${path} -> ${res.status} ${json?.error_code ?? json?.code ?? ""}`);
    return json;
  }

  async function platform(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => undefined)) as { data?: ReturnType<typeof JSON.parse>; error?: { code?: string } } | undefined;
    if (!res.ok) throw new Error(`Platform ${method} ${path} -> ${res.status} ${json?.error?.code ?? ""}`);
    return json!.data;
  }

  /** A real Supabase Auth user (email pre-confirmed) signed in with its password — the same token the Console gets. */
  async function createUser(reference: string, role: string) {
    const email = `mv-${reference}-${role}-${runId}@test.ul-platform.invalid`.toLowerCase();
    const password = `Mv-${randomBytes(12).toString("base64url")}`;
    const user = await supabase("/auth/v1/admin/users", {
      method: "POST",
      key: env.SUPABASE_SERVICE_ROLE_KEY,
      body: { email, password, email_confirm: true, user_metadata: { source: "na-pista-manual-validation" } },
    });
    const session = await supabase("/auth/v1/token?grant_type=password", { method: "POST", key: env.SUPABASE_ANON_KEY, body: { email, password } });
    await platform("GET", "/me", session.access_token); // creates the Platform user record
    return { id: user.id as string, email, password, role, token: session.access_token as string };
  }

  const organizations: Record<string, unknown> = {};
  for (const reference of REFERENCES) {
    const users = [];
    for (const role of ROLES) users.push(await createUser(reference.slug, role));
    const owner = users[0]!;
    const org = await platform("POST", "/organizations", owner.token, { name: `MV_${reference.key}_${runId}` });
    for (const user of users.slice(1)) {
      await platform("POST", `/organizations/${org.id}/memberships`, owner.token, { userId: user.id, roleKey: user.role });
    }
    const subscription = await platform("POST", `/organizations/${org.id}/subscriptions`, owner.token, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });
    const platformFacing = await platform("POST", `/organizations/${org.id}/api-keys`, owner.token, { applicationKey: "NA_PISTA", scopes: ["usage.write", "event.publish"] });
    const integration = await platform("POST", `/organizations/${org.id}/api-keys`, owner.token, { applicationKey: "NA_PISTA", scopes: ["catalog.read", "catalog.write"] });

    organizations[reference.key] = {
      id: org.id,
      name: org.name,
      displayLabel: reference.label,
      subscriptionId: subscription.id,
      users: Object.fromEntries(users.map((u) => [u.role, { id: u.id, email: u.email, password: u.password }])),
      credentials: {
        platformFacing: { keyId: platformFacing.id, secret: platformFacing.secret, scopes: platformFacing.scopes },
        integration: { keyId: integration.id, secret: integration.secret, scopes: integration.scopes },
      },
    };
    console.log(`${reference.key}: organization ${org.id} (${users.length} users)`);
  }

  const fixtures = {
    createdAt: new Date().toISOString(),
    runId,
    platformBaseUrl: BASE,
    // Public client configuration (the same values the Console ships to browsers) — lets the Na Pista seed script sign in.
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    organizations,
  };

  const dir = new URL("../../na-pista/.fixtures/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const outPath = new URL("manual-validation.json", dir);
  writeFileSync(outPath, JSON.stringify(fixtures, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(`Manual-validation fixtures written to ${decodeURIComponent(outPath.pathname).replace(/^\//, "")} (contains passwords/secrets — git-ignored, do not share).`);
}

main().catch((error) => {
  console.error("Manual-validation provisioning failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
