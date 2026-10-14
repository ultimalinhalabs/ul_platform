# Landing leads intake (`POST /v1/service/leads`)

The UL landing (`ultimalinha-landing`, www.ultimalinha.ao) no longer has a database. Its
`/api/leads` route forwards each contact request, server to server, to UL Platform, which stores
it in `commercial_leads` — the top of UL's own commercial pipeline (before any proposal).

```
browser → LP /api/leads (Zod) → POST https://api.ultimalinha.ao/v1/service/leads
                                  Authorization: Bearer ulk_…   (UL_LANDING, lead.create)
                                  Idempotency-Key: ul-landing-<uuid>
        ← 201 { id, status }  → LP sends notification + auto-reply with its own SMTP
```

## Contract

- **Auth:** PLATFORM_SERVICE credential of application `UL_LANDING` with scope `lead.create`.
  Organization credentials are refused (403) even if a scope were ever granted. The source
  application is the credential's own application — never a body field.
- **Idempotency-Key** header (8–200 chars), required. Same key + same body → `200` with the
  original lead (`idempotent: true`); same key + different body → `409`.
- **Body** (`.strict()`, unknown fields → 400): `companyName`, `contactName`, `email`, `phone`,
  `businessArea`, `desiredService`, `message`, optional `landingPage`, `utm{source,medium,campaign,term,content}`,
  `userAgent`. Bounds mirror the landing form.
- **Response:** `{ data: { id, status: "NEW", createdAt, idempotent } }` — never the personal data sent.
- Rate limit 30/min per credential. Audit `commercial.lead.received` (no personal data in metadata).

## Data

Migration `0021_landing_leads`: table `commercial_leads` (RLS on, no anon/authenticated grants),
application `UL_LANDING`, scope `lead.create` allow-listed for `UL_LANDING` only. Additive; no
existing table changes. There is no read endpoint yet — leads are read directly by the owner
until a Console view is built.

## Communication

UL Platform stores the lead; it does not send email. The landing keeps sending the internal
notification and the auto-reply with its SMTP (owner decision, 2026-10-14). The target model —
`lead.received` event → QD Notification — waits for the QD Notification API
(`ECOSYSTEM-REALITY-AUDIT.md` §15–16).

## Rollout (each step needs explicit authorization)

1. Apply `0021` to UL production (recipe in the Phase 5.2/6 runbook; pending set must be exactly `0021`).
2. Merge/deploy UL Platform (Vercel + Railway auto-deploy `master`).
3. Platform admin: `POST /v1/platform/credentials` `{ "applicationKey": "UL_LANDING", "scopes": ["lead.create"] }`
   — the secret is shown once.
4. Vercel project `ultimalinha-landing`: add `UL_PLATFORM_LEADS_API_KEY` (sensitive, Production +
   Preview), optionally `UL_PLATFORM_API_URL`; remove `DATABASE_URL`.
5. Merge/deploy the landing; validate with one owner-authorized submission, then rotate/revoke as needed.
