# PHASE 5 — FOUNDATION HARDENING — Última Linha Ecosystem

> 2026-10-03 · sequência da Fase 4 (`docs/ECOSYSTEM-REALITY-AUDIT.md`).
> Sem segredos neste documento. Tudo o que foi aplicado em produção está listado em §16.

## 1. Executive Summary

- **Pasta-mãe:** o `projeto_ul/.git` (remote da landing, 0 commits) foi **removido** (movido para backup fora do projecto). Os 8 repositórios continuam independentes.
- **Webhooks (UL Platform):** a entrega passou de "1 tentativa, sem retry, sem dedupe, sem timeout, a seguir redirects" para **eventos persistidos com id estável, uma delivery por (endpoint, evento), retry com backoff/jitter, timeout, lease anti-concorrência e idempotência do publicador**. Migration `0010` **aplicada em produção** (autorizada).
- **Testes do UL Platform** deixaram de poder correr contra a BD real (guard). O mesmo risco já tinha sido fechado no QD.
- **QD:** fundação do ecossistema pronta numa branch: mapping de organizações QD↔UL, ligação de identidade, porta de identidade (uma só autoridade) e modelo de capacidades Automation/Notification. Migration `0027` **não aplicada** (sem autorização), por isso o código **não** está no `main`.
- **Hardening de privilégios UL** (`0011`): pronto, testado, **não aplicado** (sem autorização) e numa branch própria.
- **Divergência de migrations do UL resolvida na causa:** a 11.ª linha registada é a migration `0000` do **Na Pista**, aplicada por engano na BD do UL. Não bloqueia nada e não foi mexida.
- **Remotes:** o `gh` CLI foi instalado, mas falta autenticação. Os 4 repositórios sem remote ficam por tratar (§4).

## 2. Scope

Feito: segurança, governança, fiabilidade de webhooks, contratos service-to-service (documentados), mapping de organizações, preparação de identidade, modelo de entitlements.
Não feito (fora do âmbito ou à espera de decisão): migração de identidade, integração Na Pista → QD, Notification Engine, cobrança, novas aplicações comerciais, limpeza de dados.

## 3. Security hardening

| Item | Antes | Depois | Validação |
|---|---|---|---|
| Testes do UL Platform | `dotenv/config` → um `npm test` local corria contra a BD real (`qajlwc…`) | `src/db/testDatabaseGuard.ts`: em test runs, só BD local (ou `TEST_DATABASE_ALLOW_REMOTE=true`) | teste unitário; suite inteira corrida contra Postgres descartável |
| Entrega de webhooks | sem timeout; `fetch` seguia redirects (payload assinado podia ir para outro host) | timeout de 10 s; `redirect: "manual"` → 3xx = `FAILED` | testes `timeout → retry`, `3xx → FAILED e redirect não seguido` |
| Privilégios Data API (UL) | RLS sem policies, mas GRANTs de `anon`/`authenticated` em 31 tabelas | migration `0011` (revoke + default privileges) — **pendente de autorização** | BD descartável: 31/31 → 0/32 |
| Data API (QD) | já fechada na Fase 4 (`0026`, `43b98bf`) | preservada; as tabelas novas da `0027` nascem com RLS | teste `as tabelas novas nascem fechadas à Data API` |
| Auditoria de segredos | — | nenhum `.env` com valores versionado; nenhum segredo real em ficheiros versionados (só placeholders, BDs de CI em `localhost` e URLs inválidas em testes) | script de auditoria (só caminhos/estado git) |

Achado menor por corrigir: `qualeadica/api/src/config/env.ts` e `drizzle.config.ts` têm uma credencial de BD **local** por omissão (`localhost:5434`) — sem risco de produção; remover quando se mexer nesse ficheiro.

## 4. Repository / remotes state

| Repo | Remote | Branch | Estado | Acção nesta fase |
|---|---|---|---|---|
| `ul-platform` | `ultimalinhalabs/ul_platform` | `master` | limpo | commits + push (`061833f`, `6c6fcef`, docs) · branch `phase-5/revoke-public-data-api-grants` |
| `qualeadica` | `airtonalexandrelda-cloud/qualeadica` | `main` | 2 alterações do dono (não tocadas) | branch `phase-5/ecosystem-foundation` (`0a21e51`) |
| `ul-console` | `ultimalinhalabs/ul_console` | `master` | 87 alterações do dono | nenhuma |
| `ultimalinha-landing` | `ultimalinhalabs/ultimalinha-landing` | `main` | 51 alterações do dono | nenhuma |
| `ul-client` | **nenhum** | `master` | 81 alterações do dono | **bloqueado**: sem remote |
| `na-pista` | **nenhum** | `f31-reference-product-ui` | 14 alterações do dono | **bloqueado** |
| `na-pista-console` | **nenhum** | `f31-reference-product-ui` | limpo | **bloqueado** |
| `na-pista-landing` | **nenhum** | `main` | limpo | **bloqueado** |

Convenção observada: organização `ultimalinhalabs`, nomes com underscore (`ul_platform`, `ul_console`). Remotes esperados (a confirmar pelo dono): `ultimalinhalabs/ul_client`, `na_pista`, `na_pista_console`, `na_pista_landing`, privados. O `gh` CLI 2.102.0 foi instalado (escopo de utilizador) mas **não está autenticado**; não foi criado nenhum recurso externo. Nunca empurrar alterações locais não commitadas do dono — só commits existentes.

## 5. Parent `.git` remediation

Verificado antes: 0 commits, 0 stashes, sem `index` (nada staged), sem hooks activos, sem workflows; os 8 filhos têm `.git` próprio. Acção: `projeto_ul/.git` **movido** para o scratchpad da sessão (backup temporário fora do projecto), não apagado. Depois: `projeto_ul` deixou de ser um repositório (`fatal: not a git repository`); os 8 repositórios mantêm toplevel, remote e o mesmo número de alterações.

## 6. Webhook retry architecture

```
POST /v1/organizations/:org/events {type, data, idempotencyKey?}
  └─ TX: INSERT webhook_events (evt_…)  +  INSERT webhook_deliveries (1 por endpoint, PENDING, next_attempt_at=now)
  └─ 1.ª tentativa inline  (claim por id → POST assinado → resultado)
retry worker (server.ts, a cada 15 s; também em várias instâncias)
  └─ UPDATE … WHERE id IN (SELECT … status='PENDING' AND next_attempt_at<=now() AND lease livre
                            ORDER BY next_attempt_at LIMIT 50 FOR UPDATE SKIP LOCKED)  → lease 60 s
  └─ tentativa → SUCCESS | FAILED | EXHAUSTED | PENDING(next_attempt_at = backoff)   (só se ainda detém o lease)
```

| Resposta | Resultado |
|---|---|
| 2xx | `SUCCESS` |
| 408, 425, 429, 5xx, rede, timeout (10 s) | retry (`Retry-After` em 429/503, com tecto) |
| 3xx | `FAILED` (redirect não seguido) |
| outros 4xx | `FAILED` |
| retryable na última tentativa | `EXHAUSTED` |
| endpoint revogado entretanto | `FAILED` sem envio |

Política: **8 tentativas**, base 30 s, ×2, tecto 30 min, jitter ±20 % (≈1 h de cobertura). Assinatura HMAC inalterada (`HMAC-SHA256(secret, "<ts>.<body>")`, comparação em tempo constante); timestamp novo por tentativa, por isso a janela anti-replay (300 s) aplica-se a cada tentativa. Logs: `eventId`, `deliveryId`, `endpointId`, `attempt`, `status`, `httpStatus`, latência, `nextAttemptAt`, `final` — nunca o segredo, os headers de autorização ou o payload.

## 7. Webhook dedupe model

- **Identidade do evento:** `X-UL-Event-Id` (`evt_<uuid>`), igual em todas as tentativas e endpoints.
- **Identidade da delivery:** `X-UL-Delivery-Id`, uma linha única por (endpoint, evento); `X-UL-Delivery-Attempt` indica o número da tentativa.
- **Publicador:** `idempotencyKey` opcional, único por (organização, aplicação de origem) — publicar de novo devolve o evento original (`idempotent: true`), sem novas deliveries e sem sobrescrever o payload.
- **Receptor:** tem de deduplicar por `X-UL-Event-Id` (at-least-once). Testado com um receptor que processa e responde 500: o retry chega com o mesmo id e o efeito executa uma vez.

## 8. Service-to-service contract (estado real)

| Aspecto | Real no código |
|---|---|
| Autenticação | `Authorization: Bearer ulk_<id>.<secret>`; `authenticate` distingue pelo prefixo |
| Armazenamento | `api_keys.secret_hash` = SHA-256; comparação `timingSafeEqual` |
| Introspecção | `GET /v1/service/me` → `{ apiKeyId, application, organizationId, scopes }` (cache 15 s no Na Pista) |
| Autorização | scopes persistidos por chave (`api_key_scopes`), limitados à allowlist da aplicação (`application_service_scopes`); scope fora da allowlist → 403, desconhecido → 400 |
| Organização | `requireServiceOrganizationMatch`: organização da chave = `:organizationId` do path, senão 403; o corpo nunca define a organização |
| Ciclo de vida | criação (segredo mostrado uma vez), `expiresAt` opcional, revogação auditada; **rotação = criar nova + revogar antiga** (sem endpoint atómico) |
| **Gap:** ambiente | as chaves **não** estão ligadas a `staging`/`production`; a separação depende de projectos/BDs distintos por ambiente |
| **Gap:** discovery | só 2 endpoints `staging` ilustrativos (`.example`); nenhum de produção. Não foram inventados URLs — cada aplicação regista o seu quando tiver um ambiente real (UL Console → `application_endpoints`) |

Contrato preparado para o QD (não activado): **UL → QD** = webhooks do UL assinados (`X-UL-*`), receptor QD idempotente por `X-UL-Event-Id`, assinatura verificada com o segredo do endpoint; **QD → Na Pista** = chave `ulk_` org-scoped da aplicação `QUALE_A_DICA` com `catalog.read`, path `/v1/organizations/{ul_org}/…` (via `ecosystem_organization_links`).

## 9. Organization mapping (QD, branch `phase-5/ecosystem-foundation`)

`ecosystem_organization_links(qd_organization_id PK → organizations ON DELETE CASCADE, ul_organization_id UNIQUE NOT NULL, linked_at, linked_by → profiles)` + RLS. Comportamento: mesmo par → idempotente; re-apontar ou reutilizar → 409; id inválido → 400; organização inexistente → 404; auditado (`ECOSYSTEM_ORGANIZATION_LINKED`); rotas `GET/POST /api/v1/admin/organizations/:id/ecosystem-link` só para platform admins. Nunca altera `organizations.id`. Ainda não verifica que a organização UL existe (não há integração activa) — passa a verificar na fase de identidade.

## 10. UL Platform hardening

- Webhooks (§6–§7); guard de testes (§3); revogação de GRANTs pronta (§3, pendente).
- **Divergência de migrations — causa:** a linha 11 de `drizzle.__drizzle_migrations` (BD UL) tem o hash de `na-pista/drizzle/migrations/0000_organic_power_man.sql`; foi aplicada por engano na BD do UL (mesma tabela de migrations por omissão), o que explica também o schema residual `na_pista`. Não bloqueia: o migrator só aplica migrations posteriores à última registada, e as do UL são posteriores. **Não foi apagada** — deve sair na mesma limpeza autorizada do resíduo `na_pista*`.
- Auth: JWT verificado server-side (`verifySupabaseAccessToken`); chaves com hash e comparação em tempo constante; organizações/ownership/roles validados no servidor (Fases anteriores do UL — sem alterações).
- Teste pré-existente intermitente: `listPlatformAuditLogs paginates with a stable cursor` falha às vezes na `HEAD` limpa (empate de timestamps numa BD rápida) — não relacionado.

## 11. Identity preparation (QD, branch)

`Principal { authority, subject, email }` + porta `IdentityVerifier`; o middleware delega no `QdSupabaseIdentityVerifier` — **uma única autoridade** (Supabase do QD). Nenhum token UL é aceite (testado com um JWT com o formato UL). `ecosystem_identity_links(profile_id PK, ul_user_id UNIQUE, link_method)` aditiva. Autenticação separada da autorização (tenant/role continuam no QD). **Não** migrado: utilizadores, passwords, sessões, Auth do QD. Quando a autoridade UL entrar: validar emissor, audiência, JWKS/segredo, expiração e claims, e a membership vem do UL.

## 12. Entitlement model

UL: `plan_entitlements` key/value por plano de aplicação já suporta capacidades separadas sem mudar o schema. Chaves propostas para `QUALE_A_DICA`: `automation.enabled`, `automation.messages.monthly.max`, `notifications.enabled`, `notifications.whatsapp.monthly.max`, `notifications.email.monthly.max`. QD: `modules/ecosystem/entitlements.ts` interpreta-as **fail-closed** (sem subscrição / ausente / tipo errado ⇒ desligado ou 0), quotas independentes; **não ligado ao runtime**. O seed comercial do UL **não foi alterado** (valores comerciais = decisão do dono).

**Gap documentado:** uma organização só pode ter **uma subscrição não cancelada por aplicação**. Opções: **A** planos combinados com chaves por capacidade (funciona hoje); **B** duas aplicações no registry; **C** add-ons no UL Platform. Decisão em aberto.

## 13. Automation vs Notification

Inalterado e reforçado: o mesmo transporte de eventos (UL webhooks com retry/dedupe) é a entrada futura da **Notification**; nenhuma conversa artificial; o QD só comunica — a aplicação de domínio é dona do evento. Partilham canais/providers/credenciais/entrega/retry/observabilidade; não partilham estado nem pipelines.

## 14. Tests

| Suite | Resultado | Como |
|---|---|---|
| UL Platform (completa) | **223/223** (202 antes + 21 novos) | Postgres descartável, sem `.env` (`DOTENV_CONFIG_PATH` inexistente, valores falsos) |
| UL `webhook-retry.test.ts` | 21/21 | receptores HTTP locais reais |
| QD (completa) | **675/675** | Postgres descartável, sem `.env` |
| QD `ecosystem-foundation.test.ts` | 18/18 (inclui `channels-auth`) | idem |
| Typecheck / build / lint | UL: typecheck + build + eslint OK · QD: `tsc` OK | |
| Mutação | 5xx→permanente e remoção do `SKIP LOCKED` detectadas (o teste de concorrência original não detectava; foi acrescentado um teste determinístico de claim com transacção aberta) | |

## 15. Migrations

| Repo | Migration | Estado |
|---|---|---|
| ul-platform | `0010_webhook_retry_and_dedupe` (aditiva) | **produção — aplicada e verificada** |
| ul-platform | `0011_revoke_public_data_api_grants` | testada; **não aplicada**; branch `phase-5/revoke-public-data-api-grants` (fora do `master` para não ser aplicada por engano) |
| qualeadica | `0027_ecosystem_links` (aditiva, RLS) | testada; **não aplicada**; branch `phase-5/ecosystem-foundation` |

## 16. Production changes (lista exacta)

1. BD UL Platform (`qajlwc…`): migration `0010` aplicada **sozinha** (migrator do drizzle sobre uma cópia das migrations truncada na `0010`). Verificado: `webhook_events` criada (RLS ligado), 6 colunas novas, 3 índices, as 2 deliveries antigas preservadas, GRANTs de `anon` inalterados (a `0011` não entrou).
2. Nenhuma outra alteração em produção. O UL Platform não tem deploy de produção registado; nada foi feito deploy manualmente. O código do QD desta fase não está no `main`.

## 17. Remaining risks

1. 4 repositórios sem backup remoto.
2. `0011` e `0027` por aplicar (a `0027` bloqueia o merge do QD).
3. Webhooks: o worker corre dentro do processo do servidor — sem servidor UL a correr, não há retries (o estado fica na BD e retoma quando arrancar).
4. Chaves de serviço sem ligação a ambiente; sem rotação atómica.
5. Linha de migration órfã do Na Pista e schema `na_pista*` na BD UL (limpeza destrutiva por autorizar).
6. Teste intermitente de paginação do audit log (pré-existente).

## 18. Decisions still required

1. Autorizar `0011` (UL) e `0027` (QD) em produção; depois fazer merge das branches.
2. Autenticar o `gh` (`gh auth login`) e confirmar nomes/visibilidade dos 4 remotes.
3. Modelo comercial Automation/Notification (A/B/C) e valores das entitlements `QUALE_A_DICA`.
4. Limpeza do resíduo `na_pista*` + linha de migration órfã na BD UL, e dos dados órfãos do QD.
5. Onde corre o UL Platform em produção (necessário para o worker de retries e para registar endpoints reais).

## 19. Next phase (recomendado, não implementado)

**Fase 6 — Identity & Organization authority:** UL Client com signup/criação de organização/convites; QD aceita a autoridade UL (estratégia C, verifier UL explícito), liga organizações e perfis via as tabelas desta fase; QD passa a consumir entitlements UL (`interpretQdEntitlements`) em modo sombra antes de os aplicar.

---

## Phase 5.1 — Foundation Closure

> 2026-10-04 · fecho dos pontos críticos da Fase 5. Sem segredos neste documento (só refs de projecto truncadas, contagens e códigos de estado). Não é a Fase 6.

### 5.1.1 Remotes

| Repo | Remote confirmado pelo dono | Configurado | Remote antes | Publicado | Estado |
|---|---|---|---|---|---|
| `ul-client` | `ultimalinhalabs/ul_client` | sim (`origin`) | **vazio** (0 refs) | **não** (regra: só remote) | `master` · 14 commits · 81 alterações do dono intactas (57 M, 24 ??) |
| `na-pista` | `ultimalinhalabs/na_pista` | sim | **vazio** | **não** (regra: só remote) | `f31-reference-product-ui` (+ `main`, `f29a-…`, `f30-…`) · 60 commits · 14 alterações do dono intactas (1 M, 13 ??) |
| `na-pista-console` | `ultimalinhalabs/na_pista_console` | sim | **vazio** | **sim** — `main` (`aacd265`), upstream `origin/main` | limpo; `f31-reference-product-ui` **não** publicada (decisão do dono) |
| `na-pista-landing` | `ultimalinhalabs/na_pista_landing` | sim | **vazio** | **sim** — `main` (`a0a238c`), upstream `origin/main` | limpo |

- Existência e vazio verificados com `git ls-remote` (só leitura), com controlos: um repo inexistente dá `Repository not found`; `ul_platform` devolve refs.
- **Publicação:** a 1.ª tentativa falhou com 403 (credencial Git da máquina = conta `airtonalexandrelda-cloud`, sem escrita nestes repositórios). Depois de o dono autenticar o `gh` com a conta `ultimalinhalabs`, o push foi feito com essa credencial **só no comando** (`-c credential.helper=!gh auth git-credential`, sem alterar a configuração global), após nova confirmação de remote vazio: `main` publicado nos dois repositórios limpos, sem force. O credential manager do Windows mantém a conta antiga (usada por `ul_platform`/`qualeadica`).
- Nenhum remote criado, renomeado ou com visibilidade alterada; nenhum force push; nenhum conteúdo remoto apagado.

**Auditoria pré-publicação (4 repos, histórico completo, só caminhos/padrões — nenhum valor impresso):**

| Verificação | Resultado |
|---|---|
| Caminhos sensíveis alguma vez commitados (`.env*` excepto `.example`, `*.pem/key/p12/pfx`, `id_rsa`, `credentials*.json`, dumps, `*.db/sqlite`, `node_modules`, `.next`, `dist`, `build`) | nenhum ficheiro de segredo/dump/build; só código-fonte cujo nome contém "credential"/"secret" e migrations `.sql` |
| Conteúdo de todos os blobs do histórico (chave privada, JWT, URL Postgres com password, `ulk_…`, `sk_live`, AWS, Resend, GitHub, Google, `sb_secret`, OpenAI, Anthropic, token Meta) | 1 acerto: `ulk_44444444.supe…` num mock de `integrations.test.tsx` (na-pista-console) — fixture de baixa entropia, não é segredo |
| `.gitignore` — `na-pista-console` | **falhava**: `.env.production/.development/.test`, dumps, chaves, `credentials.json`, `build/` não ignorados → corrigido em `main` (`aacd265`, via worktree temporário; checkout `f31-…` do dono intocado) |
| `.gitignore` — `na-pista-landing` | dumps, `id_rsa`, `credentials.json`, `dist/`, `build/` não ignorados → corrigido (`a0a238c`) |
| `.gitignore` — `ul-client`, `na-pista` | `.env*` ignorados; **dumps, `id_rsa`, `credentials*.json` não ignorados** (e `key.pem`/`.next` no `na-pista`) — **não alterado** (árvores com trabalho do dono). Recomendação: o mesmo bloco antes do primeiro push |

Bloco acrescentado (só `.env.example` continua versionado; `git ls-files -ci --exclude-standard` vazio depois): `.env*`, `!.env.example`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `credentials*.json`, `service-account*.json`, `*.dump`, `*.sql.gz`, `dump*.sql`, `backup*.sql`, `*.sqlite`, `*.sqlite3`, `*.db`, `/build/`, `/dist/`.

### 5.1.2 Migration `0011_revoke_public_data_api_grants` (UL, `qajlwc…`) — aplicada

| Passo | Evidência |
|---|---|
| Branch / ficheiro | `phase-5/revoke-public-data-api-grants` (`2d04cfc`); ficheiro aplicado = blob da branch (sha256 do conteúdo LF `9f8faf6e…`; registado com CRLF, como as 12 anteriores) |
| `0010` aplicada | linha `#12` `created_at=1791049531901` = `0010_webhook_retry_and_dedupe` (hash confere) |
| Antes | 12 linhas (inclui `#11`, a órfã do Na Pista — intocada); `anon`/`authenticated` com ALL em **32/32** tabelas `public`; RLS 32/32; 0 policies; 0 triggers em `auth.*`; Data API `GET …?limit=0` → **200** |
| Dry-run | réplica da regra do migrator do drizzle-orm (aplica `when > max(created_at)`): **só `0011`**; o script de aplicação aborta se o conjunto pendente não for exactamente esse |
| Segurança operacional | snapshot das ACLs (32 relações + 6 default ACLs) e SQL de rollback exacto guardados fora do repo (scratchpad da sessão); migração transaccional (`migrate` do drizzle-orm) |
| Aplicação | 12 → **13** linhas; última `created_at=1791049705201` = `0011` |
| Depois | grants `anon`/`authenticated` em `public`: **0**; default ACLs de `postgres` para tabelas/sequências: sem anon/authenticated; Data API → **401 / 42501** (`organizations`, `api_keys`, `platform_memberships`, `webhook_events`); Auth `/auth/v1/health` 200, `/auth/v1/settings` 200; role da API (`postgres`, BYPASSRLS) mantém leitura/escrita; 13 chaves de serviço activas intactas; `na_pista`, `na_pista_spike`, `na_pista_drizzle_meta` intocados |
| Git | merge `b6913bc` em `master`, publicado (`250ff87..b6913bc`). A branch remota `phase-5/revoke-public-data-api-grants` não foi apagada |

Achado residual (não corrigido — fora do âmbito autorizado): os default ACLs do owner `supabase_admin` (tabelas/sequências/funções) e os de `postgres` para **funções** ainda concedem a `anon`/`authenticated`; existe `public.rls_auto_enable` (SECURITY DEFINER, EXECUTE para `anon`). As tabelas das migrations são criadas como `postgres`, por isso não herdam GRANTs. Avaliar numa migration própria.

Nota de processo: a comparação ficheiro↔blob antes da aplicação reportou diferença e o comando seguiu em frente (encadeamento mal construído). Verificado imediatamente a seguir: a diferença é só CRLF↔LF (conteúdo idêntico). Na `0027` a comparação passou a abortar o script.

### 5.1.3 Migration `0027_ecosystem_links` (QD, `dijpcg…`) — aplicada

| Passo | Evidência |
|---|---|
| Antes | 28 linhas registadas, última = `0026`; dry-run: **só `0027`**; tabelas `ecosystem_*` inexistentes; 42/42 tabelas com RLS, 0 expostas |
| Aplicação | como `postgres`; ficheiro verificado igual ao blob da branch (o script aborta se diferir); 28 → **29**, última = `0027` |
| Tabelas | `ecosystem_organization_links`, `ecosystem_identity_links` — RLS ligado, 0 policies, `anon`/`authenticated` sem privilégios, **0 linhas** (nenhum link criado) |
| Índices / constraints | 2 PK, `uq_ecosystem_org_links_ul_org`, `uq_ecosystem_identity_links_ul_user`, 3 FK (organizations CASCADE, profiles CASCADE, `linked_by` SET NULL) |
| Data API QD | `ecosystem_*`, `platform_admins`, `organizations` → **401 / 42501**; Auth 200; 44/44 tabelas com RLS, 0 expostas |
| Invariantes | organizations 56, profiles 460, organization_members 14, organization_subscriptions 34, auth.users 6 — **iguais a antes** (nada migrado, criado ou apagado) |
| Git | `main` avançado por fast-forward para `0a21e51` só depois da verificação e da suite; alterações do dono (`api/package.json`, `api/scripts/seed/wandipopela-sports.seed.ts`) intactas |

Nota: o Postgres truncou o nome da FK `ecosystem_organization_links_qd_organization_id_organizations_id_fk` (67 > 63 caracteres). Inofensivo em runtime; um futuro `drizzle-kit generate/push` pode reportar diferença de nome.

O `main` do QD pode ter deploy automático (`api/vercel.json`). O código publicado é a fundação da Fase 5: porta de identidade com **uma** autoridade (Supabase do QD), rotas admin de mapping, interpretação de entitlements **não ligada ao runtime**. Nenhum token UL é aceite.

### 5.1.4 Testes pós-produção (nunca contra produção)

Cluster Postgres 17 descartável (`initdb` no scratchpad, `localhost:55432`), roles `anon`/`authenticated`/`service_role` simulados, sem `.env` real no processo.

| Suite | Resultado |
|---|---|
| UL `typecheck` / `build` / `smoke` / `db:migrate` (0000–0011 → 0 grants anon) / `db:seed` | OK |
| UL `npm test` | **222/223** — a falha é o teste intermitente pré-existente `listPlatformAuditLogs paginates…` (§10); isolado passa 3/3 |
| UL `npm run lint` | **falha: 20 erros `no-explicit-any` pré-existentes** em `scripts/f19–f27-provision-fixtures.ts` e `manual-validation-provision.ts` (versionados desde 2026-09-23, não tocados). `eslint src tests` limpo. Correcção ao §14: o "eslint OK" da Fase 5 não vale para o repositório inteiro — e o CI corre `npm run lint` |
| QD `tsc --noEmit` | OK |
| QD suite completa (migrations 0000–0027 + seeds platform-policies/plans/legal, chaves fictícias) | **674/675** na corrida limpa; a falha é `postgres-notify-listener` (ficheiro não tocado) — interferência de NOTIFY entre ficheiros em paralelo; isolado 3/3, e passou na 1.ª corrida completa. `ecosystem-foundation` + `whatsapp-webhook`: 19/19 |
| Guard UL | recusa host remoto **e** o `.env` real (produção) sob o runner de testes |
| Guard QD | recusa `TEST_DATABASE_URL` ausente e host remoto |

### 5.1.5 Webhooks (`0010`) — verificação em produção

`webhook_events` 0 · `webhook_deliveries` 2 (`SUCCESS`) · 0 `PENDING` vencidas · 0 leases activos · 8 índices (`webhook_deliveries_due_idx`, `…_endpoint_event_unique`, `webhook_events_idempotency_unique`, …) · RLS ligado nas duas tabelas. Migration não repetida; nenhum evento enviado. Comportamento do worker validado pela suite `webhook-retry` (receptores HTTP locais).

### 5.1.6 Service-to-service — sem activação

0 chaves `QUALE_A_DICA` (19 chaves, todas `NA_PISTA`, 13 activas); endpoints: só os 2 `staging` `.example`; 3 integrações `ACTIVE` (só discovery); allowlist `QUALE_A_DICA` inalterada (`catalog.read`, `event.publish`, `report.generate`, `usage.read`, `usage.write`). Nenhuma chave, endpoint ou integração criada. QD → Na Pista e Na Pista → eventos UL continuam desligados.

### 5.1.7 UL Platform — runtime de produção (diagnóstico, nada alterado)

| Pergunta | Resposta (evidência) |
|---|---|
| Onde está deployado | **Em lado nenhum.** Sem Dockerfile/`vercel.json`/Railway/Render/Fly/Procfile; CI = lint/typecheck/test/build, sem deploy; README: "No production deployment was performed" |
| Serviço persistente / worker | **Nenhum.** `pg_stat_activity` na BD `qajlwc…`: só ligações Supabase (PostgREST, Supavisor, pg_cron, exporter, pg_net); nada a escutar na porta 4000 local |
| URL | os consumidores apontam para `http://localhost:4000` / `http://127.0.0.1:4000` (`na-pista`, `na-pista-console`, `ul-client`, `ul-console`) |
| Arranque | `npm run build && npm start` (`node dist/server.js`); `server.ts` arranca o retry worker (15 s) no mesmo processo |
| Migrations | manuais (`drizzle-kit migrate`, ou script dirigido como nesta fase); o CI só migra a BD de CI |
| Secrets | `.env` local (`DATABASE_URL`, `SUPABASE_*`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, …) |
| Health | `GET /health` (liveness) e `GET /health/ready` (verifica a BD) |
| Ambiente | `APP_ENV=development` nos `.env` locais; `staging`/`production` exigem `PLATFORM_ALLOWED_ORIGINS` explícito |
| Última actividade da API na BD | `audit_logs` / `usage_events`: 2026-10-02 (corridas locais) |

**Risco:** o UL Platform só corre na máquina do programador, ligado à BD de produção. Sem esse processo não há API para o Na Pista/consolas e **não há retries** — as deliveries `PENDING` esperam na BD e são processadas por quem arrancar o servidor (incluindo um portátil de desenvolvimento, que passa a entregar webhooks de produção). Impacto actual nulo (0 pendentes, 0 endpoints activos). **Recomendação:** antes de activar qualquer evento real, um deploy persistente único (`APP_ENV=production`, segredos no host, `/health/ready` como health check, migrations como passo explícito e autorizado) e uma BD separada para desenvolvimento local. Não foi criada infraestrutura.

### 5.1.8 Organization mapping / identidade / comercial / dados

- `ecosystem_organization_links` existe em produção, vazia; nenhum link criado nem inferido (email/nome).
- Identidade não migrada; QD continua `QdSupabaseIdentityVerifier → Principal`; Auth do QD intacto.
- Comercial: planos, subscrições, preços, seed, billing e checkout **não alterados**; A/B/C por decidir.
- Dados: nada apagado (`na_pista*`, linha órfã `#11`, perfis/organizações órfãos, fixtures, subscrições, utilizadores).

### 5.1.9 Definition of Done

| Item | Estado |
|---|---|
| 4 remotes configurados · nenhum criado arbitrariamente · nenhum force push | ✅ |
| Nenhum segredo publicado · alterações locais do dono preservadas | ✅ |
| `0011` aplicada e verificada · Data API UL endurecida · UL `master` actualizado | ✅ |
| `0027` aplicada e verificada · Data API QD preservada · QD `main` actualizado após validação | ✅ |
| Webhook `0010` preservado · organization mapping disponível · nenhum link automático | ✅ |
| Identidade não migrada · comercial não alterado · dados não apagados | ✅ |
| Runtime UL auditado · risco do retry worker documentado | ✅ |
| Testes / typecheck / build | ✅ (com as intermitências conhecidas) |
| Lint | ⚠️ `npm run lint` do UL falha por 20 erros pré-existentes em `scripts/` |
| Publicação de `na-pista-console` e `na-pista-landing` | ✅ `main` publicado (após autenticação `gh` como `ultimalinhalabs`) |

### 5.1.10 Riscos restantes / decisões do dono

1. ~~Acesso de escrita aos repositórios~~ — resolvido (`gh` como `ultimalinhalabs`); `na-pista-console` e `na-pista-landing` publicados.
2. `ul-client` e `na-pista`: decidir o que commitar e quando; aplicar antes o bloco de `.gitignore`. Continuam **sem backup remoto**.
3. `na-pista-console`: publicar também `f31-reference-product-ui` (a branch de trabalho, 2 commits à frente de `main`)?
4. UL Platform sem runtime de produção (API e retries só existem quando alguém corre localmente contra a BD de produção).
5. Default ACLs residuais (`supabase_admin`, funções) e `public.rls_auto_enable` executável por `anon`.
6. Lint do UL vermelho (`scripts/`) — o CI falha no passo de lint.
7. Mantêm-se os riscos 4–6 do §17 (chaves sem ambiente, resíduo `na_pista*` + linha órfã, teste intermitente).
