# PHASE 6 — Identity & Organization Authority — AUDIT

> 2026-10-06 · auditoria **antes** de qualquer alteração (Fase 6, Parte 1). Nada foi alterado em código ou produção.
> Fontes: código de `ul-platform` (`52b8829`), `qualeadica` (`0a21e51`), `na-pista` (`fff4c1b`), `ul-client` (`a88e67e`); BDs de produção UL (`qajlwc…`) e QD (`dijpcg…`) em sessões `READ ONLY`, só contagens/ids; emails comparados em memória (hash).

## 1. Estado actual — respostas directas

| Pergunta | Resposta (real) |
|---|---|
| Autoridade de identidade por aplicação | **UL Platform / UL Client / UL Console / Na Pista / Na Pista Console** → Supabase Auth UL (`qajlwc…`). **QD API + Dashboard** → Supabase Auth **próprio** (`dijpcg…`), via `QdSupabaseIdentityVerifier` (`auth.getUser`). |
| Quem cria organizations | **UL:** `POST /v1/organizations` — qualquer utilizador autenticado, fica OWNER. O UL Client **não** tem UI de criação. **QD:** `POST /api/v1/organizations` (cria org + membership OWNER + subscrição FREE) — fluxo oficial actual do QD. **Na Pista:** não cria (usa o id UL). |
| Quem cria memberships | **UL:** criador (OWNER automático) e `POST /v1/organizations/:id/memberships` com o `userId` de um utilizador UL **já existente** (sem convite por email). **QD:** criação da org (OWNER) e fluxos próprios de membros (`organization_members`). |
| IDs duplicados | Organizações: 9 na UL vs 56 no QD, **0** partilhadas; `ecosystem_organization_links` = **0** linhas. Utilizadores: 10 contas Auth UL vs 6 QD, **0 emails em comum**. Planos/subscrições paralelos (UL vs QD). |
| Auth IDs locais | **QD:** `profiles.id = auth.users.id` do Auth QD (PK sem default), `organization_members.user_id → profiles.id`, `platform_admins.user_id`. **UL:** `users.id = auth.users.id` UL (espelho criado em cada pedido por `ensureUserExists`). Na Pista: **nenhum** id de utilizador guardado. |
| Ligação do QD ao Supabase Auth | Dashboard: `signInWithPassword` / `signUp` no Auth QD. API: `authMiddleware = createAuthMiddleware(new QdSupabaseIdentityVerifier())` → `req.principal` e `req.user = { id: principal.subject, email }`; `req.user.id` é usado como **id de profile** em 27 sítios (11 ficheiros); `ensureProfileExists(id, email)` faz `insert … onConflictDoNothing` (email é `UNIQUE`). |
| Como o Na Pista usa a identidade UL | `resolveIdentity(token)` → `GET {platform}/v1/me` (cache 15 s por token); `membershipFor(identity, orgId)` exige membership **activa**; `roleKey` vem da UL; capacidades de negócio locais (`requireCapability`); chamadas de serviço via `ulk_` + `GET /v1/service/me`. **É o padrão de referência.** |
| Estruturas da Fase 5 reutilizáveis | QD: `Principal`/`IdentityVerifier` (porta), `ecosystem_identity_links(profile_id PK, ul_user_id UNIQUE, link_method)`, `ecosystem_organization_links(qd_organization_id PK, ul_organization_id UNIQUE, linked_by)` + serviço/rotas admin (idempotente, 409 em re-apontar), `interpretQdEntitlements` (fail-closed, não ligado). UL: `memberships` com estado, `findActiveMembership`, `requirePermission`, `hasApplicationAccess` (via subscrições), `plan_entitlements`, chaves `ulk_`, webhooks com retry. |

## 2. Inventário

### 2.1 UL Platform (produção)

| Objecto | Real |
|---|---|
| `users` | 21 (10 com conta Auth; 11 fixtures sem Auth); **sem coluna de estado** (não há "utilizador desactivado") |
| `auth.users` | 10, provider `email` (100%) |
| Auth settings | `disable_signup: false`, confirmação de email obrigatória, providers activos: só `email` (o botão Google do UL Client não funciona contra este Auth) |
| `profiles` / `customers` | 0 / 0 |
| `organizations` | 9; colunas `id, name, slug, created_by, timestamps` — **sem estado** (não há "organização desactivada") |
| `memberships` | 18, todas `active` (OWNER 9, ADMIN 3, MANAGER 3, STAFF 3); estados suportados `active / invited / suspended`; único `(user, org)` |
| `roles` | globais por organização: OWNER, ADMIN, MANAGER, STAFF — **não existe AGENT**; **não há role por aplicação** |
| Acesso a aplicações | **organização → aplicação** derivado de subscrições activas (`hasApplicationAccess`, `listOrganizationApplications`); subscrições: 5, todas `NA_PISTA`; **`QUALE_A_DICA`: 0** → hoje nenhuma organização tem acesso ao QD pelo modelo UL |
| Aplicações | FOI, HOJE_TEM, MICHA_EXPRESS, NA_PISTA, QUALE_A_DICA, UL_CONSOLE (todas ACTIVE) |
| JWT | HS256 (segredo) ou ES256/JWKS; `issuer` e `aud = authenticated` validados; `sub` UUID |

Endpoints relevantes: `GET /v1/me` (`{userId, email, memberships[]}`) · `POST /v1/organizations` · `GET|PATCH|DELETE /v1/organizations/:id` · `GET|POST /v1/organizations/:id/memberships` · `PATCH|DELETE …/memberships/:membershipId` · subscrições/entitlements/applications por organização · `GET /v1/service/me`. **Não existe** `GET /v1/organizations` (lista) — a lista vem em `/v1/me`.

### 2.2 QD (produção)

| Objecto | Real |
|---|---|
| `auth.users` | 6 (provider `email`) |
| `profiles` | 460 (454 sem conta Auth — resíduos de testes) |
| `organizations` | 56; sem estado de activação (só `motor_enabled`) |
| `organization_members` | 14; role enum `OWNER / ADMIN / AGENT`; **sem estado** (não há membership revogada — só remoção) |
| `platform_admins` | 1 |
| Organizações cujos membros têm conta Auth | 4 |
| `ecosystem_organization_links` / `ecosystem_identity_links` | 0 / 0 (criadas pela `0027`, vazias) |
| Tenant | `tenantMiddleware`: `X-Organization-Id` (ou `:organizationId`); exige linha em `organization_members` para `req.user.id`; sem header usa a 1.ª membership |

### 2.3 Na Pista / UL Client

- **Na Pista:** sem tabelas de utilizadores/organizações/memberships; `organization_id` = id UL; não precisa de migração de identidade.
- **UL Client:** login `signInWithPassword` + `signInWithOAuth(google)` no Auth UL; **sem** signup próprio, **sem** criação de organização, **sem** convites (adicionar membro exige um utilizador UL existente).

## 3. Bué Power (dado crítico)

| Campo | Valor (QD produção) |
|---|---|
| id | `53cf98da-75db-43f8-8316-36075187f431` (slug `bue-power`, criada 2026-08-29) |
| Membros | 1 — OWNER, com conta no Auth QD |
| Dados | 3 contactos · 3 conversas · 135 mensagens (última 2026-10-02) · 1 ligação WhatsApp |
| Subscrição QD | PRO — **EXPIRED** |
| Ligação ao ecossistema | nenhuma (`ecosystem_organization_links` vazio) |
| Existe na UL? | **não** (0 organizações em comum) |

**⚠️ Ponto a confirmar pelo dono:** além da Bué Power, **"Wandipopela Sports"** (`52fc5f67…`) tem **79 mensagens nos últimos 30 dias e uma ligação WhatsApp**. Existe um seed local não commitado (`api/scripts/seed/wandipopela-sports.seed.ts`), o que sugere dados de demonstração — mas não é seguro assumi-lo. Outras com actividade recente são fixtures evidentes (`E2E Persistent Success`, `Token Trace Test`) e `Muambas SKL` (tem script de seed próprio).

## 4. Gaps

| # | Gap | Onde |
|---|---|---|
| G1 | QD só aceita o Auth QD; `req.user.id` = id Auth QD = id de profile | QD API |
| G2 | `ensureProfileExists` ignora em silêncio um principal novo com email já existente (`onConflictDoNothing` no email único) → utilizador sem organizações | QD API |
| G3 | Sem role por aplicação na UL (Funcionário→Bué Power→QD→AGENT vs →Na Pista→ADMIN não é expressável); sem AGENT | UL |
| G4 | Sem estado de organização (desactivada) e de utilizador (desactivado) na UL | UL schema |
| G5 | Acesso ao QD na UL depende de subscrição `QUALE_A_DICA` — 0 existentes; o modelo comercial (A/B/C) continua por decidir | UL comercial |
| G6 | QD continua a criar organizações independentes (fluxo oficial) | QD API/Dashboard |
| G7 | QD Dashboard autentica no Auth QD | QD Dashboard |
| G8 | Sem convite por email na UL; adicionar membro exige utilizador UL existente | UL |
| G9 | UL Client sem criação de organização | UL Client |
| G10 | Google OAuth no UL Client mas desactivado no Auth UL | Config Auth |
| G11 | `organization_members` do QD sem estado (revogação = apagar) | QD |

## 5. Riscos

1. **Bué Power** — uma ligação errada (identidade ou organização) deixa o dono sem acesso aos dados; mitigação: tudo aditivo, ligações em tabelas próprias, ids nunca alterados, rollback = remover a linha de ligação / voltar a flag.
2. **Corte de autenticação do QD** — qualquer mudança de verificador invalida as sessões QD actuais (6 contas); mitigação: flag de autoridade e corte controlado (re-login).
3. **Associação por email** — só segura com email **verificado** na UL e só para profiles com conta Auth QD; nunca para os 454 profiles órfãos.
4. **Deploy automático** — Vercel e Railway fazem deploy a cada push para `master`; alterações estruturais têm de ir por branch/PR e só entrar no `master` depois de autorizadas.
5. **Comercial** — dar acesso ao QD pela UL toca em subscrições/planos (decisão de produto pendente).
6. **Abuso de signup** — Auth UL aceita registos abertos e qualquer utilizador cria organizações (coerente com self-service; avaliar limites).

## 6. Plano de implementação proposto (sem execução)

**Identidade (QD)** — `UlIdentityVerifier` implementa a porta existente: valida o token **pela UL** (`GET /v1/me`, como o Na Pista — sem o QD guardar segredos do Auth UL), devolve `Principal { authority: "UL", subject: <UL user id>, email }`. Resolução **principal → profile QD**: `ecosystem_identity_links` (existente). `req.user.id` continua a ser o **id do profile QD** → os 27 usos não mudam. Profiles novos nascem com `id = UL user id` (sem link necessário). Flag `IDENTITY_AUTHORITY = QD | UL` — **troca**, não dupla aceitação (sem dual-IdP).

**Re-login controlado** — no 1.º login UL, se não há link: ligar ao profile QD existente **apenas** se (a) email UL confirmado, (b) o profile tem conta no Auth QD, (c) não está ligado a outro UL user; `link_method = "verified_email_relogin"`, auditado. Caso contrário, profile novo. Sessões QD antigas deixam de ser aceites no corte (flag `UL`).

**Organização** — UL é a autoridade. Bué Power: **criar a organização na UL** e **ligar** ao id QD existente via `ecosystem_organization_links` (nenhum id QD muda). Organizações novas: criadas na UL; o QD adopta-as com `organizations.id = UL org id` (como o Na Pista) + link próprio; `POST /api/v1/organizations` do QD deixa de ser o fluxo oficial (flag/desactivado).

**Membership / autorização** — autoridade = membership UL (estado `active` obrigatório). O QD deixa `organization_members` de ser a fonte de verdade e passa a resolver o role a partir da UL; Fase 6 começa em **modo sombra** (calcula e regista divergências, não aplica) antes do corte.

**Roles por aplicação (decisão)** — opção recomendada: tabela aditiva UL `membership_application_roles(membership_id, application_id, role_key)` com catálogo de roles por aplicação (QD: OWNER/ADMIN/AGENT); sem linha → mapeamento por omissão do role da organização (OWNER→OWNER, ADMIN→ADMIN, MANAGER/STAFF→AGENT). Alternativa: só mapeamento (não suporta roles diferentes por aplicação).

**Acesso à aplicação (decisão)** — hoje = subscrição. Para o QD: (a) criar uma subscrição `QUALE_A_DICA` para a Bué Power (toca o comercial); ou (b) separar "acesso à aplicação" do comercial (habilitação explícita por organização), deixando subscrições para a fase comercial.

**Estado** — UL: `organizations.status (active|suspended)` e `users.status (active|disabled)` aditivos (default `active`), verificados em `authenticate`/`requireOrganizationMembership` e reflectidos em `/v1/me`.

**Contrato API** — `GET /v1/me` passa a incluir, por membership, estado da organização e aplicações acessíveis com o role efectivo (campos aditivos, não quebra o Na Pista); `GET /v1/organizations/:id` inalterado; avaliar `GET /v1/organizations` (lista) só se `/v1/me` não chegar.

## 7. Migrations previstas

| Repo | Migration | Tipo |
|---|---|---|
| ul-platform | `0012`: `organizations.status`, `users.status` (default `active`) | aditiva |
| ul-platform | `0013` (se escolhido): `membership_application_roles` + catálogo de roles por aplicação (seed) | aditiva |
| qualeadica | nenhuma estrutural obrigatória (`0027` já tem as tabelas de ligação); opcional: estado em `organization_members` | — / aditiva |
| Dados (produção, autorização própria) | UL: criar org "Bué Power" + membership OWNER do dono (após o dono ter conta UL) + acesso QD; QD: 1 linha em `ecosystem_organization_links` + 1 em `ecosystem_identity_links` | inserções |

Nenhuma migration destrutiva; nenhum id alterado; nenhuma limpeza.

## 8. Breaking vs aditivo

| Mudança | Tipo |
|---|---|
| Colunas de estado, tabela de roles por aplicação, campos novos em `/v1/me` | **aditivo** (Na Pista não quebra) |
| `UlIdentityVerifier` + resolução por link no QD com flag `QD` por omissão | **aditivo** (sem mudança de comportamento até à troca) |
| Troca da flag para `UL` + Dashboard QD a autenticar no Auth UL | **breaking** para as 6 contas QD (re-login obrigatório) |
| Desactivar `POST /api/v1/organizations` do QD | **breaking** para o fluxo de criação QD |
| Membership UL como autoridade no QD (fim do modo sombra) | **breaking** para quem não tiver membership UL |

## 9. Impacto específico na Bué Power

- **Nenhuma linha da Bué Power é alterada ou apagada** em nenhuma etapa proposta; o id `53cf98da…` mantém-se.
- Acréscimos: 1 organização na UL, 1 membership UL (dono), 1 link de organização, 1 link de identidade; eventualmente acesso QD (subscrição ou habilitação).
- Canal WhatsApp, webhooks Meta, worker de mensagens, IA e automações não dependem da identidade do utilizador → **não afectados**.
- Único efeito visível: no corte, o dono faz login com a conta UL (mesmo email, verificado) e vê a mesma organização e os mesmos dados.
- Rollback: voltar a flag para `QD` (sessões QD voltam a funcionar) e/ou remover as linhas de ligação — sem perda de dados.

## 10. Ordem segura de execução (proposta)

1. **Decisões do dono** (§11).
2. UL: migrations aditivas + guards de estado + `/v1/me` enriquecido — branch, testes em BD descartável, revisão; migration de produção **com autorização**.
3. QD: `UlIdentityVerifier`, resolução por links, tenant via membership UL em **modo sombra**, flag `IDENTITY_AUTHORITY=QD` — deploy sem mudança de comportamento.
4. UL (dados, autorizado): o dono cria conta UL (email do profile QD, confirmado); criar org "Bué Power" na UL + membership OWNER + acesso QD.
5. QD (dados, autorizado): ligar Bué Power (org) e o dono (identidade).
6. Modo sombra: confirmar zero divergências para a Bué Power.
7. **Corte** (autorizado, com janela): flag `UL`, Dashboard no Auth UL, re-login do dono, verificação dos dados da Bué Power; rollback pronto.
8. Desactivar criação de organizações no QD; mais tarde desactivar signup no Auth QD.
9. Limpeza de fixtures — fase separada, com critérios e autorização.

## 11. Decisões necessárias antes de implementar

1. Roles por aplicação: tabela `membership_application_roles` (recomendado) ou só mapeamento do role da organização?
2. Acesso ao QD na UL: subscrição `QUALE_A_DICA` (comercial) ou habilitação de aplicação separada do comercial?
3. Estado de organização/utilizador na UL (`status`): aprovar as colunas aditivas?
4. "Wandipopela Sports" é real ou demonstração?
5. Conta UL do dono da Bué Power: confirmar que o email será o mesmo do profile QD (e que o dono cria a conta UL — email+password, já que o Google não está activo no Auth UL), ou activar Google no Auth UL.
6. Estratégia de corte: troca única com flag (recomendado, sem dual-IdP) e janela de manutenção para o re-login.
