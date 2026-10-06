# PHASE 6 — Identity & Organization Authority

> Estado: **Bloco 1 (fundação) implementado em branches, NÃO em produção.** Nenhuma migration aplicada em produção, nenhum dado criado/alterado em produção, nenhum corte de identidade.
> Branches: `ul-platform` e `qualeadica` → `phase-6/identity-organization-authority`. Auditoria prévia: `docs/PHASE-6-IDENTITY-ORGANIZATION-AUDIT.md` (`dd53267`).

## 1. Objectivo

Tornar a UL Platform a autoridade de identidade, organizações, memberships, acesso a aplicações e autorização base; as aplicações (QD primeiro, Na Pista já alinhado) passam a consumir essa autoridade. Cada aplicação continua dona do seu domínio.

## 2. Estado inicial

Ver auditoria: UL (Auth `qajlwc…`) para UL/Na Pista; QD com Auth próprio (`dijpcg…`), 56 organizações próprias, 0 ligações; Na Pista já resolve identidade/membership pela UL (`GET /v1/me`).

**Organizações reais protegidas (decisão do dono):**

| Organização (QD) | id | Estado (READ ONLY, 2026-10-06) | Papel na Fase 6 |
|---|---|---|---|
| **Wandipopela Sports** | `52fc5f67-a9db-45a4-8263-16a59c60c8c5` | 1 OWNER (com conta Auth QD), 739 contactos, 4 conversas, 79 mensagens (última 2026-10-05), 1 canal WhatsApp, PRO **ACTIVE**, sem links | **caso-piloto real** (será a primeira ligação, com autorização própria) |
| **Bué Power** | `53cf98da-75db-43f8-8316-36075187f431` | 1 OWNER (com conta Auth QD), 3 contactos, 3 conversas, 135 mensagens, 1 canal WhatsApp, PRO EXPIRED, sem links | **protegida, intocada** |

Neste bloco **nenhuma das duas foi tocada** (nem leitura de dados pessoais, só contagens).

## 3. Arquitectura

```
UL Auth (Supabase qajlwc) ─▶ UL Platform  ── GET /v1/me ──▶  Na Pista (já)  ·  QD (Fase 6, atrás de flag)
                               │ users.status · organizations.status
                               │ memberships (role da organização)
                               │ membership_application_roles (role por aplicação)
                               │ organization_application_access (acesso, ≠ billing)
                               └ subscriptions/plans/entitlements (comercial — Fase 7)
```

Cadeia de autorização: **Principal → Organization (active) → Membership (active) → Role (organização) → Application (acesso activo) → Application role → Permission** (as permissões dentro da aplicação são do domínio da aplicação).

## 4. Identity model

- **UL:** `users.status` (`active | disabled`, default `active`, `CHECK`). `authenticate` recusa um utilizador `disabled` com **403 `ACCOUNT_DISABLED`** mesmo com sessão Supabase válida. `emailVerified` é lido **server-side** de `auth.users.email_confirmed_at` (nunca de `user_metadata`); sem schema `auth` (local/CI) → `false` (fail closed).
- **QD:** `Principal { authority: "QD_SUPABASE" | "UL", subject, email, ul?: { emailVerified, memberships } }`. `IdentityVerifier` (porta da Fase 5) com duas implementações: `QdSupabaseIdentityVerifier` (inalterado) e **`UlIdentityVerifier`** — segue o padrão do Na Pista: valida o token pela UL em `GET {UL_PLATFORM_API_URL}/v1/me`, **sem guardar segredos do Auth UL**; 401/403 (inválido, expirado, desactivado) → não autenticado; falha da UL → erro (fail closed); cache 15 s por **hash** do token.
- **Flag `IDENTITY_AUTHORITY=QD | UL`** (default `QD`): escolhe UMA autoridade no arranque (`createIdentityVerifier`); `UL` sem `UL_PLATFORM_API_URL` → falha no arranque. Nunca há duas autoridades aceites. Rollback do corte = voltar a `QD`.
- **`req.user.id` continua a ser o id do profile QD** em ambas as autoridades → os 27 usos não mudam.

### Controlled re-login (implementado, inactivo até ao corte)

`resolveProfileForUlPrincipal` (QD, `modules/ecosystem/identity-links.service.ts`):

1. link existente (`ecosystem_identity_links.ul_user_id`) → profile ligado;
2. profile QD com o mesmo email (case-insensitive) → liga **só se** (a) email UL confirmado, (b) o profile tem conta no Auth QD, (c) não está ligado a outro utilizador UL → `link_method = verified_email_relogin`, auditado (`activities` `ECOSYSTEM_IDENTITY_LINKED` em cada organização do profile + log estruturado sem email);
3. profile com o email mas condição falhada → **403 `IDENTITY_LINK_REFUSED`** (sem link, sem profile duplicado);
4. email desconhecido → profile novo com **`id = id UL`** + link `ul_native` (nenhuma credencial criada no Auth QD).

Os 454 profiles órfãos (sem conta Auth QD) **nunca** são ligados automaticamente (regra (b), coberta por teste e por mutação).

## 5. Organization model

- **UL:** `organizations.status` (`active | suspended`, default `active`, `CHECK`). Organização suspensa → **403 `ORGANIZATION_SUSPENDED`** em todas as rotas por membership (`requireOrganizationMembership`, `requireEntitlementAccess`, `requireUsageAccess`) **e** em qualquer chave de serviço org-scoped (verificado em `authenticate`, ponto único — inclui `/v1/service/me`). As outras organizações do mesmo utilizador continuam a funcionar.
- **QD:** `ecosystem_organization_links` (Fase 5) reutilizado — `getUlOrganizationId` / `getQdOrganizationId` já existiam; **não foi criada tabela nova**. Nenhum id QD muda. Organizações novas (futuro): criadas na UL, adoptadas pelo QD com o id UL.

## 6. Membership model

- Membership UL: `active | invited | suspended`; só `active` autoriza. Roles da organização inalterados: OWNER, ADMIN, MANAGER, STAFF.
- **Roles por aplicação (camada adicional, aprovada):** `application_roles` (catálogo por aplicação) + `membership_application_roles (membership_id, application_id, role_key, timestamps)`, único por (membership, aplicação), FK composta para o catálogo **da mesma aplicação**. Catálogos: `QUALE_A_DICA` = OWNER/ADMIN/AGENT; `NA_PISTA` = OWNER/ADMIN/MANAGER/STAFF (os roles que o Na Pista já suporta).
- **Fallback provisório** (`modules/applicationRoles/effectiveRole.ts`, um só sítio): sem role explícito → QD: OWNER→OWNER, ADMIN→ADMIN, MANAGER→AGENT, STAFF→AGENT; Na Pista: mesmo role; outras aplicações: sem role de aplicação. Deve encolher à medida que as organizações atribuírem roles explícitos.
- Atribuição: validada contra o catálogo da aplicação; só um OWNER (da organização) concede/altera OWNER de aplicação; tenant-safe (membership tem de pertencer à organização da rota); auditada (`membership.application_role.set/removed`).

## 7. Application access

- **Separado do billing (aprovado):** `organization_application_access (organization_id, application_id, status active|revoked, granted_by, revoked_at, timestamps)`, único por (organização, aplicação). Acesso efectivo = linha `active` — **uma subscrição não dá acesso e o acesso não exige subscrição** (teste explícito). Revogar = mudar estado, nunca apagar. Conceder/revogar é operação de **platform admin**, auditada.
- Subscrições/planos/entitlements continuam a ser só a camada comercial (Fase 7). O Na Pista não verifica acesso a aplicações (usa entitlements) → nada quebra.

## 8. QD adoption (estado)

Implementado e **desligado** (`IDENTITY_AUTHORITY=QD`): verificador UL, resolução de identidade/re-login, reutilização dos links de organização. **Não feito** (fases seguintes, com autorização): modo sombra das memberships, criação da Wandipopela na UL, links reais, corte, Dashboard QD no Auth UL, desactivação de `POST /api/v1/organizations`.

## 9. Na Pista adoption

Nenhuma alteração no repositório do Na Pista. O contrato `/v1/me` é **aditivo** (campos antigos intactos: `userId`, `email`, `memberships[].membershipId/organizationId/organizationName/roleKey/status`). Organização suspensa: as chaves de serviço do Na Pista param (ponto único na UL); **gap:** as chamadas humanas do Na Pista ainda não verificam `organization.status` (o Na Pista só verifica `membership.status`) — uma linha no `membershipFor` do Na Pista, a tratar num passo próprio.

## 10. Contratos API (UL)

| Endpoint | Auth | Âmbito | Resposta / erros |
|---|---|---|---|
| `GET /v1/me` | JWT UL | o próprio | `{ userId, email, emailVerified, status, memberships: [{ membershipId, organizationId, organizationName, roleKey, status, organization: { id, name, slug, status }, applications: [{ key, roleKey, roleSource: "explicit"\|"fallback"\|null }] }] }` · 401 token inválido/expirado · 403 `ACCOUNT_DISABLED` |
| `GET /v1/organizations/:id` | JWT | membership activa + `organization.read` | inalterado · 403 sem membership / `ORGANIZATION_SUSPENDED` |
| `…/memberships` (GET/POST/PATCH/DELETE) | JWT | membership + permissão | inalterados (+ suspensão) |
| `GET /v1/organizations/:id/application-access` | JWT | membership + `application.read` | `[{ applicationKey, applicationName, status, grantedAt, revokedAt }]` |
| `PUT /v1/organizations/:id/memberships/:membershipId/applications/:applicationKey/role` `{roleKey}` | JWT | membership + `role.assign` | 400 role fora do catálogo · 403 OWNER sem ser OWNER · 404 membership de outra org / app desconhecida |
| `DELETE …/applications/:applicationKey/role` | JWT | membership + `role.assign` | volta ao fallback · 404 sem role explícito |
| `GET /v1/applications/:applicationKey/roles` | JWT | — | catálogo da aplicação |
| `PATCH /v1/platform/organizations/:id/status` `{status}` | JWT | `platform.organization.manage` | 400 estado inválido · 403 sem permissão de plataforma |
| `PATCH /v1/platform/users/:userId/status` `{status}` | JWT | `platform.user.manage` | idem |
| `PUT` / `DELETE /v1/platform/organizations/:id/applications/:applicationKey/access` | JWT | `platform.application_access.manage` | idempotente · 404 nada a revogar |

Não existe `GET /v1/organizations` (lista): `/v1/me` já devolve as organizações do utilizador — não foi criado.

## 11. Migrations (UL; criadas e testadas, **não aplicadas em produção**)

| Migration | Conteúdo | Tipo | Rollback (só com autorização) |
|---|---|---|---|
| `0012_organization_and_user_status` | `organizations.status`, `users.status` (default `active`, `CHECK`); permissões `platform.organization.manage`, `platform.user.manage` → `PLATFORM_ADMIN` | aditiva (linhas existentes recebem `active`) | `DROP CONSTRAINT …_status_check`, `DROP COLUMN status` nas duas tabelas; apagar as 2 permissões (e as suas ligações) |
| `0013_application_roles` | `application_roles` + `membership_application_roles` (FK composta); catálogo QD/Na Pista (7 linhas) | aditiva | `DROP TABLE membership_application_roles, application_roles` |
| `0014_organization_application_access` | `organization_application_access` + permissão `platform.application_access.manage` | aditiva | `DROP TABLE organization_application_access`; apagar a permissão |

Os dados de catálogo são `INSERT … ON CONFLICT DO NOTHING` condicionados à existência das aplicações/role (no-op numa BD nova antes do seed; o seed contém os mesmos dados). QD: **nenhuma migration** neste bloco (a `0027` já tem as tabelas de ligação).

## 12. Segurança

- Sem segredos no código/migrations/testes; o QD não guarda nenhum segredo do Auth UL; nenhum token/segredo/email registado em logs (cache do verificador indexada por hash).
- Organização sempre do parâmetro de rota, validada contra membership activa numa organização activa; nunca do corpo/cabeçalho do cliente.
- `emailVerified` server-side (nunca `user_metadata`).
- Operações de estado/acesso só com permissão de plataforma; atribuição de roles por aplicação com `role.assign` + regra OWNER-só-por-OWNER; tudo auditado.
- Re-login controlado: 3 condições + recusa explícita; órfãos nunca ligados; sem profiles duplicados; sem credenciais criadas no Auth QD.
- `SUPABASE_SERVICE_ROLE_KEY` não usada em nenhum código novo; PAT do Supabase não usado.

## 13. Testes (BD descartável; nunca produção)

**UL Platform** — cluster Postgres 17 descartável, sem `.env`, valores fictícios do CI:

| Verificação | Resultado |
|---|---|
| `typecheck` · `build` · `smoke` | OK · OK · OK |
| `eslint src tests api` | OK (o `npm run lint` completo mantém os 20 erros pré-existentes em `scripts/`) |
| `db:migrate` 0000–0014 · `db:seed` ×2 | OK · idempotente (7 roles de aplicação, 3 permissões novas atribuídas ao `PLATFORM_ADMIN`, 3 `CHECK`) |
| `npm test` (suite completa) | **231/232** — a falha é o teste intermitente pré-existente `listPlatformAuditLogs paginates…` (isolado: 7/7) |
| `tests/identity-organization-authority.test.ts` (novo, HTTP real) | **9/9**: fallback de roles · contrato `/v1/me` (`emailVerified` server-side, campos antigos preservados) · token inválido/expirado/ausente → 401 · utilizador desactivado → `ACCOUNT_DISABLED` e reactivação · organização suspensa → `ORGANIZATION_SUSPENDED` para membro **e** chave de serviço, outra organização intacta, reactivação · isolamento entre organizações (sem membership, organização desconhecida, membership suspensa → 403) · subscrição ≠ acesso; acesso explícito (idempotente) com role efectivo (fallback → explícito), revogação · catálogo por aplicação (QD sem MANAGER, Na Pista sem AGENT), OWNER só por OWNER, ADMIN com `role.assign`, membership de outra organização → 404, STAFF → 403 · operações de plataforma exigem permissão de plataforma |

**QD** — BD descartável (`qd_test`, migrations 0000–0027 + seeds), sem `.env`, UL simulada por servidor HTTP local:

| Verificação | Resultado |
|---|---|
| `tsc --noEmit` | OK |
| Suite completa | **686/686** (675 anteriores + 11 novos) |
| `src/test/identity-authority.test.ts` (novo) | **11/11**: uma só autoridade (QD por omissão; UL; UL sem URL falha) · `UlIdentityVerifier` (válido; inválido/expirado; desactivado por 403 e por estado; cache por hash = 1 chamada; UL indisponível → erro) · middleware QD inalterado · re-login com as 3 condições (liga + auditoria `ECOSYSTEM_IDENTITY_LINKED`; email não confirmado → 403; **órfão nunca ligado**; profile já ligado a outro → 403) · utilizador novo → profile com id UL, link `ul_native`, nenhuma conta Auth QD criada · token inválido → 401 · **preservação**: ligar o dono deixa a organização (linha e id), membros, contactos, conversas e mensagens iguais |
| Teste de mutação | remover a condição "profile tem conta Auth QD" → o teste dos órfãos falha (detectado); código reposto |

## 14. Deployment

Nada em produção. As branches não estão no `master` (Vercel/Railway só fazem deploy do `master`; um push da branch gera, no máximo, um *preview* da Vercel sem variáveis — fail closed). Antes do merge: revisão do dono, autorização da aplicação das migrations `0012–0014` em produção.

## 15. Riscos restantes

1. Na Pista (chamadas humanas) ainda não respeita `organization.status`.
2. Cache de 15 s no verificador UL do QD (e no Na Pista): uma desactivação/revogação demora até 15 s a propagar.
3. Fallback de roles é provisório (MANAGER/STAFF → AGENT no QD).
4. Push do QD bloqueado nesta máquina: a credencial Git activa não tem acesso a `airtonalexandrelda-cloud/qualeadica` (`Repository not found`).
5. `npm run lint` do UL continua com os 20 erros pré-existentes em `scripts/` (Fase 5.1).

## 16. Próxima etapa (cada passo com autorização própria)

1. Revisão deste bloco → merge para `master` + aplicação de `0012–0014` em produção.
2. QD: modo sombra das memberships (UL vs QD → divergências registadas, sem efeito).
3. UL (dados): o dono da **Wandipopela** cria conta UL (mesmo email, confirmado, email/password); criar a organização na UL + membership OWNER + acesso `QUALE_A_DICA`.
4. QD (dados): `ecosystem_organization_links` Wandipopela → UL; o `ecosystem_identity_links` nasce no 1.º login UL do dono (re-login controlado).
5. Modo sombra sem divergências para a Wandipopela → corte (`IDENTITY_AUTHORITY=UL`, Dashboard no Auth UL) numa janela combinada.
6. Só depois: desactivar a criação de organizações no QD; Bué Power e restantes contas seguem o mesmo processo; limpeza de fixtures numa fase separada.

## Critério de conclusão da Fase 6 (estado)

| Item | Estado |
|---|---|
| UL Identity é autoridade definida | ✅ definida (contrato + guards) — corte por fazer |
| Principal definido e utilizado | ✅ (QD, ambas as autoridades) |
| Organization Authority definida | ✅ (estado + links) |
| Membership model definido | ✅ (+ roles por aplicação) |
| QD consegue operar com UL organization | ⏳ código pronto atrás de flag; sem links reais |
| Wandipopela / Bué Power intactas | ✅ (nenhuma operação) |
| Na Pista continua funcional | ✅ contrato aditivo (suite UL + smoke); gap §9 |
| Cross-organization isolation testado | ✅ |
| Application access definido | ✅ (separado do billing) |
| Controlled re-login implementado/testado | ✅ implementado/testado · ⏳ não activado |
| Sem credenciais duplicadas no fluxo novo | ✅ (teste: nenhuma conta Auth QD criada) |
| Migrations testadas | ✅ BD descartável |
| Production migration autorizada | ⏳ |
| Documentação / relatório final | ✅ bloco 1 · ⏳ final |
