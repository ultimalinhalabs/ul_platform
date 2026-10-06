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

---

# Bloco 2 — UL Platform + Na Pista (QD preparado, sem publicação)

> 2026-10-06. Branches: `ul-platform` `phase-6/identity-organization-authority` (`da9c54c` + este relatório) · `na-pista` `phase-6/ul-status-compat` (`f455a7f`, **local, sem push**) · `qualeadica` `phase-6/identity-organization-authority` (`2488f87`, **local, sem push**). Nada aplicado em produção, excepto a limpeza autorizada do incidente (B2.3).

## B2.1 UL Platform — revisão final

| Verificação | Resultado |
|---|---|
| Migrations 0012–0014 aditivas | ✅ só `ADD COLUMN … DEFAULT 'active' NOT NULL`, `CREATE TABLE`, constraints e inserções idempotentes de catálogo; nenhum `DROP`/`DELETE`/`UPDATE` de dados |
| Defaults / constraints | ✅ `status` default `active` + `CHECK` (organizações, utilizadores, acesso); unicidade (membership, aplicação) e (organização, aplicação); FK composta `(application_id, role_key)` → catálogo da **mesma** aplicação |
| RLS / permissões | **corrigido no Bloco 2:** as 3 tabelas novas não activavam RLS (dependiam do trigger automático do projecto Supabase) → `ENABLE ROW LEVEL SECURITY` explícito em 0013/0014; verificado: RLS ligado e **0** grants `anon`/`authenticated`. 3 permissões de plataforma novas, só para `PLATFORM_ADMIN` |
| Acesso efectivo | **endurecido:** `/v1/me` só lista aplicações para membership `active` numa organização `active` (um utilizador `disabled` já é recusado); conceder acesso recusa organização suspensa (409) e aplicação não `ACTIVE` (409); aplicação/organização desconhecida → 404 |
| Compatibilidade Na Pista | ✅ campos antigos de `/v1/me` intactos; o Na Pista não verifica acesso a aplicações (usa entitlements) |
| Rollback | §11 (inalterado) |

Testes (BD descartável, sem `.env`): typecheck ✅ · `eslint src tests api` ✅ · migrate 0000–0014 ✅ · seed ×2 (idempotente) ✅ · smoke ✅ · build ✅ · **`identity-organization-authority.test.ts` 13/13** (+4: matriz completa do fallback OWNER/ADMIN/MANAGER/STAFF nas duas aplicações; estados do acesso efectivo; unicidade + FK composta; trilho de auditoria completo; RLS) · **suite completa 235/236 — não 100% verde:** a falha é o teste intermitente pré-existente `listPlatformAuditLogs paginates…` (isolado 7/7), identificado separadamente desde a Fase 5.

## B2.2 Na Pista — compatibilidade (branch local `phase-6/ul-status-compat`, `f455a7f`)

Resolução real: identidade e memberships via `GET /v1/me` (cache 15 s), organização pela rota, role da UL, capacidades locais (`requireCapability`), serviço via `GET /v1/service/me`. **Nenhuma autoridade paralela** — o Na Pista só lê o que a UL devolve.

| Regra | Antes | Depois |
|---|---|---|
| Utilizador UL `disabled` | bloqueado, mas como 401 genérico | **403 `ACCOUNT_DISABLED`** (resposta da UL ou `status` no corpo) |
| Organização UL `suspended` (humano) | **não verificado** (gap da auditoria) | **403 `ORGANIZATION_SUSPENDED`**; as outras organizações do utilizador continuam |
| Organização UL `suspended` (chave de serviço) | 401 genérico | **403 `ORGANIZATION_SUSPENDED`** |
| Membership `suspended` | bloqueada | bloqueada (inalterado) |
| Role | role da organização | role de aplicação `NA_PISTA` quando a UL o envia (explícito, ou fallback = mesmo role), senão o da organização |
| Acesso à aplicação | — | flag `NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS` (**default `false`**: sem mudança de comportamento; ligar só depois de um backfill autorizado de acessos `NA_PISTA`) |
| UL sem os campos novos | — | continua a funcionar (campos opcionais) |
| Cache de identidade | 15 s | **mantida (15 s)**: limite de desactualização documentado e testado — dentro da janela 1 chamada à UL; uma revogação aplica-se assim que a janela expira, nunca depois |

Testes (sem BD, UL simulada por servidor HTTP local): **`platform-identity-status.test.ts` 10/10** (activo; desactivado; token inválido; organização suspensa; membership suspensa; organização desconhecida; acesso cruzado; compatibilidade; role de aplicação; acesso à aplicação com flag desligada/ligada, válido/revogado; cache 15 s; serviço-a-serviço válido/suspenso/revogado/isolado) + `test-database-guard.test.ts` 1/1 · **suite unitária completa 247/247** · typecheck ✅ · build ✅ · eslint dos ficheiros alterados ✅ (o eslint completo mantém 18 erros `no-explicit-any` **pré-existentes** em `tests/e2e/*`, dívida registada na F29A) · mutação: remover a verificação de organização suspensa → teste falha (detectado). **Integração/e2e não executados** (dependem de BD/UL reais — ver incidente).

## B2.3 Incident — Na Pista Production Integration Test

| | |
|---|---|
| Quando | 2026-10-06, 03:00:53 → 03:04:39 UTC (≈4 min) |
| Causa | ao adicionar o guard de BD de testes ao Na Pista, uma edição por script **falhou** (assertion; ficheiro inalterado) e o **mesmo comando composto continuou** e executou `tests/integration/appointments.test.ts` com o `.env` real — escolhido para "provar" que o guard recusava a BD de produção. Sem guard ligado, o teste correu contra a **BD de produção do Na Pista** (`jpwoyo…`). Erros do agente: (1) não parar após a falha da edição; (2) validar um guard usando o alvo real em vez de um host fictício |
| Impacto | **273 linhas sintéticas** em **14 `organization_id` aleatórios novos**: `appointments` 7, `audit_events` 96, `customers` 14, `organization_settings` 13, `professional_schedule_exceptions` 2, `professional_schedule_rules` 98, `professional_services` 14, `professionals` 14, `services` 15 |
| Linhas pré-existentes alteradas | **0** (verificado em todas as tabelas com `created_at`/`updated_at`) |
| Organizações reais | nenhuma tocada: os 14 ids não são organizações UL (0/14), não têm linhas anteriores à execução e não são Wandipopela nem Bué Power (essas vivem no QD, outra BD) |
| Limpeza (autorizada pelo dono, só estes 14 ids) | uma transacção; pré-verificações (contagem exacta por tabela = 273; 0 linhas destes ids anteriores a 03:00 UTC; lista de tabelas revista; sem triggers/rules); `DELETE … WHERE organization_id = ANY(14 ids)` por ordem de FKs, cada `DELETE` com contagem verificada; pós-verificações dentro da transacção (0 linhas para os ids; totais das outras organizações iguais aos de antes) → **COMMIT, 273 linhas removidas**. Sem `TRUNCATE`, sem janela temporal, sem limpeza de fixtures existentes |
| Estado final | 0 linhas para os 14 ids (verificação independente posterior); totais das restantes organizações inalterados e iguais aos da auditoria da Fase 4 (`products` 1283, `appointments` 1420, `orders` 438, `customers` 1199, `organization_settings` 776, `audit_events` 18 577) |
| Ids removidos | `e9aea737-0e2a-46d2-a4c2-88718347df28`, `680e5e4a-462d-4bf7-9985-f4b250e0073d`, `2dce98ba-c368-4090-a33b-1c5e4cb49eca`, `6cd9c177-a798-4cc3-959c-ab138eed69fc`, `c8a123c9-7527-40bb-95c1-6c144ca06b3e`, `8aacc709-76eb-4966-8852-778158f864de`, `54d48707-2e78-4d8b-a847-0a2c90318c54`, `9eda8f1b-58b9-4b88-ae7e-eb1edb3f4dd9`, `05a36870-d0bc-437b-9bb5-e15d795c34a1`, `008ffe37-2112-46aa-ab9c-1a96da73876d`, `3758168f-8459-414c-b36b-11b772bdb668`, `1399aa4f-afa5-49b3-ab78-47df5c5cf6ed`, `f8e72b71-b098-4b13-96ef-0eff39bf1117`, `cc4b85b9-4573-4201-8913-90a8e7e01a40` |

**Correcção — barreira fail-closed:** `na-pista/src/db/testDatabaseGuard.ts`, ligado em `src/db/index.ts` (o único ponto de ligação): sob o runner de testes, um `NA_PISTA_DATABASE_URL` não local **aborta antes de qualquer ligação**, salvo `TEST_DATABASE_ALLOW_REMOTE=true` explícito. Provado só com hosts fictícios (`db.remote.invalid`): import recusado; host local permitido; **processos-filho** dos testes e2e (`startChildServer`) herdam o contexto de teste e também recusam. A BD de produção nunca foi usada para o provar. Atenção: o guard só existe neste branch local; noutros branches do Na Pista o `.env` continua a apontar para produção **sem guard** — publicar/mergear este guard é recomendado antes de qualquer outra execução de integração/e2e.

**Lição operacional:** comandos compostos com etapas dependentes correm com `set -o pipefail` e encadeamento `&&` (ou verificação explícita); uma falha de edição, patch ou assertion **pára** a sequência — nunca há um teste a seguir a um patch falhado. Guards de segurança provam-se com alvos fictícios, nunca com o alvo real.

## B2.4 QD — preparação (sem publicação)

| Verificação | Resultado |
|---|---|
| Branch / commit | `phase-6/identity-organization-authority` @ `2488f87`; alterações do dono (`api/package.json`, `api/scripts/seed/wandipopela-sports.seed.ts`) fora do commit |
| typecheck · build | ✅ · ✅ (`tsc` para pasta temporária; `dist/` do repo intocado) |
| Suite completa (BD descartável, migrations 0000–0027 + seeds, sem `.env`) | **685/686 — não 100% verde:** a falha é `queue-reclaim-stale.test.ts` (`reclaimStale() devolve uma linha PROCESSING abandonada`), **intermitente mesmo isolado** (2/4, 4/4, 2/4); nem o teste nem o módulo `queue` foram tocados pelo commit da Fase 6; no Bloco 1 a mesma suite deu 686/686. Testes de identidade da Fase 6: 11/11 |
| `IDENTITY_AUTHORITY` | `QD` (default) — comportamento actual |

Revisão de código (sem alterações nesta etapa, por instrução):

- `UlIdentityVerifier` ✅ contrato UL (`/v1/me`), sem segredos UL, fail closed, utilizador `disabled` → não autenticado, cache por hash do token. **Menor:** a cache nunca remove entradas expiradas (cresce com tokens distintos) — podar no `set`.
- Re-login ✅ 3 condições + recusa explícita; órfãos nunca ligados; sem profiles duplicados; auditado. **A corrigir antes do corte:** a procura do profile é por `lower(email)` com `limit(1)`, mas o `UNIQUE` de `profiles.email` é sensível a maiúsculas — se existirem dois profiles que só diferem em maiúsculas, a escolha seria arbitrária. Correcção proposta: obter até 2 e **recusar** (`IDENTITY_LINK_REFUSED`, motivo `ambiguous_email`) quando houver mais de um, com teste.
- Shadow mode: **ainda não implementado** (bloco seguinte). Desenho: para cada pedido com autoridade UL (ou um job de comparação), `principal.ul.memberships` → organização QD por `ecosystem_organization_links` → role QD esperado = `applications[QUALE_A_DICA].roleKey` (explícito ou fallback) vs `organization_members.role`; divergência registada (log estruturado/métrica/`activities`), autorização efectiva inalterada. Requer acesso `QUALE_A_DICA` concedido na UL (sem acesso → divergência `no_application_access`).

**Publicação pelo owner (posterior):** com a conta que tem acesso a `airtonalexandrelda-cloud/qualeadica`, em `qualeadica/`: `git switch phase-6/identity-organization-authority`, confirmar `git log --oneline -1` = `2488f87`, depois `git push -u origin phase-6/identity-organization-authority`. Não fazer merge para `main` (o `main` do QD pode fazer deploy automático) antes da revisão e das correcções acima.

## B2.5 Wandipopela — checklist técnico do piloto (NÃO executado)

| # | Passo | Onde | Verificação | Rollback |
|---|---|---|---|---|
| 0 | Pré-requisitos: `0012–0014` em produção (autorizado); correcção `ambiguous_email` no QD; shadow mode implementado e testado | UL / QD | testes + revisão | — |
| 1 | Conta UL do owner: signup email/password com o **mesmo email** do profile QD do owner; email confirmado | Auth UL | `/v1/me` → `emailVerified: true` | apagar a conta UL (sem efeito no QD) |
| 2 | Organização UL "Wandipopela Sports" | UL | `organizations.status = active` | remover a org UL (sem efeito no QD) |
| 3 | Membership OWNER do owner | UL | `/v1/me` → membership `active`, `roleKey OWNER` | suspender/remover a membership |
| 4 | Acesso `QUALE_A_DICA` (platform admin, auditado; **sem subscrição**) | UL | `/v1/me` → `applications: [{QUALE_A_DICA, OWNER}]` | revogar o acesso |
| 5 | Link de organização: QD `52fc5f67-a9db-45a4-8263-16a59c60c8c5` ↔ UL org | QD `ecosystem_organization_links` | `getUlOrganizationId` | remover a linha |
| 6 | Link de identidade: nasce no 1.º login UL do owner (re-login controlado, `verified_email_relogin`) | QD `ecosystem_identity_links` | `req.user.id` = profile QD do owner | remover a linha |
| 7 | Shadow membership activo | QD | logs/métricas de divergência | desligar |
| 8 | Zero divergências para a Wandipopela durante a janela de observação | QD | relatório | — |
| 9 | Re-login controlado: `IDENTITY_AUTHORITY=UL` + Dashboard QD no Auth UL; o owner entra com a conta UL e vê os mesmos dados (contactos, conversas, canal WhatsApp) | QD | contagens antes/depois iguais | `IDENTITY_AUTHORITY=QD` |
| 10 | Rollback documentado e ensaiado; nenhum id QD alterado em nenhum passo | — | — | — |

Bué Power: **nenhuma operação e nenhuma leitura adicional** neste bloco.

## B2.6 Critério de conclusão do Bloco 2

| Item | Estado |
|---|---|
| UL migrations 0012–0014 revistas | ✅ (+ RLS explícito) |
| UL testes completos | ✅ Fase 6 13/13 · suite 235/236 (intermitente pré-existente, separada) |
| UL build/typecheck/smoke | ✅ |
| Application access validado | ✅ |
| Application roles validados | ✅ |
| Status guards validados | ✅ |
| `/v1/me` validado | ✅ |
| Na Pista compatibility validada | ✅ unit 247/247 (integração/e2e não executados) |
| Na Pista status handling corrigido | ✅ (branch local) |
| Cache de 15 s documentada/testada | ✅ |
| QD preparado localmente | ✅ 685/686 (intermitente pré-existente, separada); 2 achados de revisão por corrigir antes do corte |
| QD não publicado | ✅ |
| Wandipopela não tocada | ✅ |
| Bué Power não tocada | ✅ |
| Incidente documentado e limpo | ✅ |
| Relatório actualizado | ✅ |
