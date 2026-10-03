# ECOSYSTEM REALITY AUDIT — Última Linha

> Fase 4 · 2026-10-03 · baseado em **código + `.env` (sanitizado) + BDs reais (sessões forçadas READ ONLY)**.
> Nenhum segredo neste documento: só refs de projecto Supabase, hosts sanitizados, nomes de tabelas e contagens.
> Comparações de ids/emails entre BDs feitas em memória (hash) — só contagens foram registadas.

**Separação desta fase:**
- **READ-ONLY AUDIT** — §1–§12 (inventário, autoridades, duplicações).
- **IMPLEMENTATION CHANGES** — §19 (uma correcção de segurança crítica no QD, aplicada com autorização explícita; governança actualizada).

---

## 1. Applications & repositories

| Repositório (pasta) | Nome no brief | App | Tipo | Remote | Branch | Estado git |
|---|---|---|---|---|---|---|
| `ul-platform` | `ul-project` | UL Platform (control plane) | API Express + Drizzle | `ultimalinhalabs/ul_platform` | `master` | limpo |
| `ul-client` | `ul-client` | UL Client (consola do tenant) | Next | **sem remote** | `master` | 81 alterações locais por commitar |
| `ul-console` | `ul-console` | UL Console (admin da plataforma) | Next | `ultimalinhalabs/ul_console` | `master` | 87 alterações locais |
| `ultimalinha-landing` | `ul-landing` | Landing UL | Next + Drizzle | `ultimalinhalabs/ultimalinha-landing` | `main` | 51 alterações locais |
| `na-pista` | (não listado — é o backend) | Na Pista API (commerce engine) | API Express + Drizzle | **sem remote** | `f31-reference-product-ui` | 14 alterações locais |
| `na-pista-console` | `na-pista-console` | Na Pista Console | Next | **sem remote** | `f31-reference-product-ui` | limpo |
| `na-pista-landing` | `na-pista-landing` | Landing Na Pista | Next (estático) | **sem remote** | `main` | limpo |
| `qualeadica` | `qualeadica` | QD API + Dashboard (+ landing QD) | Express + Next (monorepo de 2 pacotes) | `airtonalexandrelda-cloud/qualeadica` | `main` | 2 alterações do dono |

**ARCHITECTURE GAP — pasta-mãe:** `projeto_ul/` é **ela própria um repositório git** sem commits, com `origin = ultimalinhalabs/ultimalinha-landing`. Um `git add -A && git commit && git push` feito na pasta errada publicaria todos os repositórios irmãos (incluindo `.env`) no remote da landing. Registado nas regras de governança (§20). Recomendação: remover `projeto_ul/.git` (não tem commits — decisão do dono).

**Divergências nome↔responsabilidade:** `ul-project` não existe (é `ul-platform`); `ul-landing` é `ultimalinha-landing`; o backend `na-pista` não estava na lista mas é a autoridade do domínio Na Pista; a dashboard do QD é também a landing do QD (schema `landing_page`).

## 2. Supabase projects

| Ref | Usado por | Auth | BD | Observação |
|---|---|---|---|---|
| `qajlwcbvssikljoqmbii` (eu-west-2) | `ul-platform` (BD + verificação JWT), `ul-client`, `ul-console`, **`na-pista-console`** (Auth) | **Autoridade de identidade UL** — 10 utilizadores (email) | UL Platform (`public`) **+ resíduos `na_pista*`** | RLS ligado em todas as tabelas `public`, sem policies (Data API nega tudo) |
| `jpwoyonvsneezcshpswg` (eu-central-1) | `na-pista` (BD via `NA_PISTA_DATABASE_URL`, schema `na_pista`) | **0 utilizadores** — o Na Pista não usa este Auth | Na Pista | identidade vem do UL (`GET /v1/me`); `SUPABASE_*` no `.env` não são lidos pelo `env.ts` |
| `dijpcgtostvvtekgxdlv` (eu-west-1) | `qualeadica/api`, `qualeadica/dashboard` | **Auth próprio do QD** — 6 utilizadores | QD (`public`) + `landing_page` | estava **totalmente exposto pela Data API** — corrigido (§19) |
| `aobrrdhuefbffqjnsmcj` (eu-west-3) | `ultimalinha-landing` (`.env` local) | — | **inacessível**: o pooler responde *"tenant/user not found"* (projecto pausado/apagado) | os envs de produção (Vercel) não foram auditados — não confirmável a partir daqui |

Storage: 0 buckets nos 3 projectos acessíveis. Edge functions: nenhuma no código.

## 3. Databases (estado real)

**UL Platform (`qajlwc…`)** — 31 tabelas `public`: `applications`(6) `service_scopes`(9) `application_service_scopes`(24) `application_integrations`(3) `application_environments`(10) `application_endpoints`(2) `meters`(6) `application_meters`(13) `plans`(7) `plan_entitlements`(11) `subscriptions`(5) `entitlements`(0) `usage_events`(19) `api_keys`(19) `api_key_scopes`(30) `webhook_endpoints`(1) `webhook_event_subscriptions`(1) `webhook_deliveries`(2) `organizations`(9) `memberships`(18) `users`(21) `profiles`(0) `customers`(0) `roles`(4) `permissions`(20) `role_permissions`(42) `platform_roles`(1) `platform_permissions`(9) `platform_role_permissions`(9) `platform_memberships`(2) `audit_logs`(3285). Migrações: 11 registadas vs **10 ficheiros** no repositório (divergência a investigar). **Resíduo:** schemas `na_pista` (8 tabelas: 395 produtos, 89 pedidos, 107 clientes; 62 organizações, **nenhuma** é organização UL; última escrita 2026-09-23), `na_pista_spike`, `na_pista_drizzle_meta` (4 migrações) — dados da época dos spikes F19–F27, antes de o Na Pista ter BD própria. Viola "nenhuma BD partilhada".

**Na Pista (`jpwoyon…`)** — schema `na_pista`, 16 tabelas: `products`(1283) `categories`(73) `services`(1641) `professionals`(2113) `professional_services` `professional_schedule_rules` `professional_schedule_exceptions` `appointments`(1420) `orders`(438) `order_items` `customers`(1199) `inventory_balances` `stock_movements` `organization_settings`(776) `organization_platform_credentials`(3) `audit_events`(18 577). **Sem tabela de organizações/utilizadores/memberships** (correcto: usa o id da organização UL). **Sem variantes.** 776 organizações em `organization_settings`, só **1** é organização UL actual (o resto são fixtures de E2E); as 3 credenciais de plataforma são de organizações UL. Migrações 11/11.

**QD (`dijpcg…`)** — 42 tabelas `public` + `landing_page`(3). Migrações 28 registadas / 27 ficheiros (uma linha duplicada antiga, inofensiva). Ver §7 para identidade.

**UL Landing (`aobrrd…`)** — inacessível (ver §2).

## 4. Auth authorities

| App | Autoridade actual | Como valida | Ids |
|---|---|---|---|
| UL Platform / Client / Console | Supabase `qajlwc…` | JWT verificado server-side (`SUPABASE_JWT_SECRET`); `public.users` = espelho `(id, email)` | `users.id = auth.users.id` (10/10); 11 linhas `users` sem conta Auth (fixtures) |
| Na Pista API + Console | **UL** (`qajlwc…`) — o console faz login no Supabase UL | `GET {platform}/v1/me` com o JWT do utilizador; chamadas de serviço `ulk_` via `GET /v1/service/me` | nenhum id de utilizador guardado; `organization_id` = id UL |
| QD API + Dashboard | **Supabase próprio `dijpcg…`** | `supabase.auth.getUser(token)` | `profiles.id = auth.users.id`; roles OWNER/ADMIN/AGENT locais |

**0** ids Auth e **0** emails em comum entre o Auth do QD e o Auth UL.

## 5. Organization authority (fluxo real)

- **UL Platform:** `POST /v1/organizations` (qualquer utilizador autenticado → OWNER). 9 organizações.
- **UL Client:** **não cria** organizações nem contas (só login, `PATCH` da organização, membros, chaves, webhooks, `POST/PATCH` de subscrições). Organizações e utilizadores nascem hoje por scripts/fixtures do UL Platform.
- **Na Pista:** **não cria** organizações — cria `organization_settings` para um id UL já existente.
- **QD:** **cria as suas próprias** organizações (`POST /api/v1/organizations` + membership OWNER + subscrição FREE). 56 organizações, 0 com id UL.

## 6. Membership authority

UL: `memberships` (18, todas `active`), roles `OWNER/ADMIN/MANAGER/STAFF` + permissões; `platform_memberships` (2) para `PLATFORM_ADMIN`. Na Pista: consome a membership UL (cache 15 s), permissões de negócio locais. QD: `organization_members` (14; 13 OWNER, 1 ADMIN) + `platform_admins` (1) — autoridade paralela.

## 7. QD — utilizadores de teste (números reais)

O brief estimava ~100 utilizadores; a BD mostra:

| | Total | Notas |
|---|---|---|
| `auth.users` | **6** | 4 gmail, 2 `muambas-skl.test`; 4 activos nos últimos 30 dias |
| `profiles` | 460 | **454 sem conta Auth** — 450 com domínio `exemplo.ao` (resíduos das suites de teste que antes corriam contra esta BD) |
| `organizations` | 56 | 13 com membros; **só 4 com um membro que tem conta Auth** |
| `organization_members` | 14 | |
| `organization_subscriptions` | 34 | FREE 32, PRO 1 activo, PRO 1 expirado |
| WhatsApp ligados | 4 organizações (3 Cloud API, 1 Coexistence) | |
| organizações com conversas | 15 | |

Esforço real de migração de identidade: **6 contas e 4 organizações efectivas** (+ 52 organizações órfãs/fixture que não precisam de migrar).

## 8. Commercial authority

| | UL Platform (real) | QD (real) |
|---|---|---|
| Planos | 7 (QUALE_A_DICA: só `BUSINESS`) | 4 (FREE/PRO/ADVANCED/ENTERPRISE) |
| Entitlements | `plan_entitlements` key/value por plano; QUALE_A_DICA só `conversations.max=10000` | colunas fixas em `plans` (mensagens, relatórios, leads, catálogo, conhecimento…) |
| Subscrições | 5, **todas NA_PISTA**; **0 QUALE_A_DICA** | 34 locais |
| Usage | 19 eventos, só NA_PISTA | `organization_usage` local |
| Quem vende | ninguém (UL Client pode `POST` subscrição; sem pagamento) | QD (`plan_change_requests` + aprovação manual) |

## 9. Domain authorities

| Domínio | Hoje (real) | Duplicado em |
|---|---|---|
| Produtos/categorias/serviços/profissionais/horários/marcações/pedidos/clientes/inventário | **Na Pista** (BD `jpwoyon…`) | QD (`organization_catalog`, `_variants`, `_aliases`, `orders`, `order_items`, `appointments`); resíduo `na_pista` na BD UL |
| Variantes de produto | **só QD** (56) | — (Na Pista não tem) |
| Contactos/conversas/mensagens/canais WhatsApp/IA/traces/takeover/automations/alertas/relatórios | **QD** | — |
| Comunicação transaccional (email/WhatsApp template) | **QD** (`communication_log` 31) e landing UL/QD (Resend/SMTP próprios) | landings têm envio de email próprio |

## 10. Service-to-service (real)

- Mecanismo existente: chaves `ulk_` emitidas pelo UL Platform, por aplicação, com scopes da allowlist; introspecção `GET /v1/service/me` (cache 15 s no Na Pista); `requireServiceOrganizationMatch` para chaves org-scoped.
- Real na BD: **19 chaves, todas NA_PISTA** (13 activas: 12 org-scoped + 1 de plataforma). **0 chaves QUALE_A_DICA.**
- Scopes reais QUALE_A_DICA: `catalog.read`, `event.publish`, `report.generate`, `usage.read`, `usage.write`.
- Integrações reais: `QUALE_A_DICA→NA_PISTA`, `NA_PISTA→MICHA_EXPRESS`, `HOJE_TEM→QUALE_A_DICA` (todas `ACTIVE`, só "podem descobrir-se").
- Discovery: só 2 endpoints, ambos `staging` ilustrativos (`.example`); **nenhum endpoint de produção** registado.
- Eventos: `POST /v1/organizations/:org/events` → webhooks da organização, assinatura HMAC, **1 tentativa, sem retry, sem dedupe** (`modules/webhooks/delivery.ts`). Real: 1 webhook (revogado), 2 entregas (smoke). **O Na Pista ainda não publica eventos** (nenhum código de publicação).
- QD: **não usa nenhum destes mecanismos** (só `QUEUE_TICK_SECRET` interno).

## 11. Duplicação actual (resumo)

1. Identidade: 2 Auth (UL `qajlwc` vs QD `dijpcg`), 0 sobreposição.
2. Organizações/memberships/platform admins: UL vs QD.
3. Comercial: planos/subscrições/entitlements/usage UL vs QD.
4. Catálogo/pedidos/marcações: Na Pista vs QD.
5. Resíduo do Na Pista dentro da BD UL (`na_pista`, `na_pista_spike`).
6. `public.customers` na BD UL (0 linhas) vs `na_pista.customers`.
7. Envio de email: QD (SMTP), landing UL e dashboard QD (Resend/SMTP próprios).

## 12. Authority matrix

| Domínio | Autoridade actual | Autoridade futura | BD actual | Aplicação |
|---|---|---|---|---|
| Identity | UL Auth (UL, Na Pista) **e** QD Auth (QD) | UL Platform | `qajlwc` / `dijpcg` | UL / QD |
| Organization | UL Platform **e** QD | UL Platform | `qajlwc` (9) / `dijpcg` (56) | UL / QD |
| Membership | UL Platform **e** QD | UL Platform | `qajlwc` (18) / `dijpcg` (14) | UL / QD |
| Plans | UL Platform **e** QD | UL Platform | `qajlwc` (7) / `dijpcg` (4) | UL / QD |
| Subscription | UL (só Na Pista) **e** QD | UL Platform | `qajlwc` (5) / `dijpcg` (34) | UL / QD |
| Entitlement | UL (key/value) **e** QD (colunas) | UL Platform | `qajlwc` / `dijpcg` | UL / QD |
| Products | Na Pista **e** QD | Na Pista | `jpwoyon` (1283) / `dijpcg` (38) | Na Pista / QD |
| Services | Na Pista | Na Pista | `jpwoyon` (1641) | Na Pista |
| Orders | Na Pista **e** QD | Na Pista | `jpwoyon` (438) / `dijpcg` (4) | Na Pista / QD |
| Conversations | QD | QD | `dijpcg` (25) | QD |
| Contacts | QD | QD | `dijpcg` (761) | QD |
| WhatsApp Channels | QD | QD | `dijpcg` (4) | QD |
| AI Processing | QD | QD | `dijpcg` (traces em `messages.metadata`) | QD |
| Notifications | QD (`CommunicationService`, interno) | QD (Notification Engine) | `dijpcg` (`communication_log` 31) | QD |

## 13. Identity migration strategy (dados reais: 6 contas, 4 organizações efectivas, 0 sobreposição)

| | A. Big-bang | B. Dupla identidade | C. Re-login controlado |
|---|---|---|---|
| Como | exportar as 6 contas (hash bcrypt) para o Auth UL, criar as 4 organizações no UL, mapear ids, trocar o middleware num deploy | o QD aceita JWT dos dois projectos durante uma janela; `PrincipalId` normalizado + tabela de correspondência | cada utilizador cria/entra com conta UL (invite por email); no 1.º login o QD liga a conta UL ao `profile` local pelo email verificado; organizações ligadas por `ul_org_id` |
| Passwords | migram (hash) — exige export de `auth.users` | mantêm-se | utilizador define nova (ou Google) |
| Tokens/sessões | todas invalidadas no corte | ambas válidas | sessões QD expiram naturalmente |
| Memberships | recriadas no UL | duplicadas durante a janela | recriadas no UL por invite |
| Rollback | difícil (ids trocados) | fácil (desligar flag) | fácil (mapping é aditivo) |
| Risco | médio (corte único) | **alto** (dois IdPs = duas superfícies de ataque, lógica permanente) | **baixo** |
| Esforço com 6 contas | baixo | alto (código permanente) | **baixo** |

**Recomendação: C.** Com 6 contas de teste e 4 organizações efectivas, a dupla identidade não compensa a complexidade nem o risco de segurança. Big-bang é viável, mas obriga a manipular hashes de passwords entre projectos sem necessidade. Os 454 perfis órfãos e as 52 organizações sem dono real **não migram** (ficam, não se apagam — decisão de limpeza à parte).

## 14. Organization mapping (proposta — não criada)

Nunca mudar ids existentes. No QD, uma tabela de ligação aditiva, criada só quando a fase de identidade começar:

```
ecosystem_organization_links
  qd_organization_id  uuid PK → organizations.id
  ul_organization_id  uuid UNIQUE NOT NULL   -- id da organização no UL Platform
  linked_at timestamptz, linked_by uuid
```
Na Pista já usa o id UL directamente (`organization_id` = id UL) — **sem mapping**. Logo QD→Na Pista passa por `qd_org → ul_org → path /v1/organizations/{ul_org}/…`.

## 15. Notification & Communication architecture

**O que já existe no QD (código real):**
- `modules/communication` — `CommunicationService.send()` + `CommunicationChannelProvider` (`EMAIL` SMTP, `WHATSAPP` template), `template.registry`, `recipient-resolver`, idempotência por `dedupeKey` em `communication_log`. Usado por alertas, relatórios e pedidos de plano. **É um proto-Notification Engine interno** (destinatários = admins da organização).
- `modules/queue` — `ChannelAdapter` + `OutboundQueueWorker` (fila persistente, retry, takeover checkpoint) + `WhatsAppChannelAdapter` (texto livre, janela de 24 h). **É o canal de saída da Automation.**
- `integrations/whatsapp/cloud-api.client.ts` — cliente Meta partilhado por ambos.

```
                         QUALÉ A DICA
                  Communication Infrastructure
     ┌──────────────┬──────────────┬──────────────┬───────────────┐
  Channels       Providers       Delivery        Observability
  (WHATSAPP,     (Meta Cloud,    (fila outbound, (communication_log,
   EMAIL)         SMTP)           retry, dedupe)  traces, métricas)
     └──────────────┴──────┬───────┴──────────────┴───────────────┘
              ┌────────────┴─────────────┐
       Automation Engine          Notification Engine
       (inbound → conversa →      (evento da aplicação →
        IA → decisão → resposta;   pedido → destinatário →
        takeover; janela 24 h)     canal → template →
                                   entitlement → entrega)
```

**Partilhado:** providers (Meta, SMTP), credenciais do canal (`organization_whatsapp_connections`, cifradas), fila/retry, templates, observabilidade, rate limiting.
**Independente:** contratos de entrada (mensagem inbound vs. `NotificationRequest`), estado (conversa/lote vs. pedido de notificação), pipeline (IA/decisão vs. resolução de destinatário/canal), testes.
**Regra:** a Notification nunca depende de `conversations` (uma notificação para um cliente que nunca falou com o negócio não cria conversa); a Automation nunca envia templates de notificação.
**Gap:** hoje `communication` só serve notificações internas (admins) e o canal WhatsApp de template não tem fila/retry próprios (envio síncrono com `dedupeKey`); a fila outbound é só da Automation. Unificar a *entrega* (não os pipelines) é o primeiro passo técnico.

**Channel ownership:** número/WABA/token Meta vivem em `organization_whatsapp_connections` (token cifrado AES-256-GCM); SMTP em env do QD. **Nunca** saem do QD (nem para UL Client, Na Pista ou IA).

## 16. Event ownership

**A aplicação é dona do EVENTO; o QD é dono da COMUNICAÇÃO.** Fluxo futuro (não implementado):
```
Na Pista ── PAYMENT_CONFIRMED (facto, com o contexto necessário) ──▶ UL Platform POST /v1/organizations/:org/events
   ──▶ webhook da organização (assinado, X-UL-Event-Id) ──▶ QD Notification API ──▶ Notification Engine ──▶ WhatsApp / Email
```
O QD nunca tenta confirmar o pagamento. Pré-requisitos reais em falta: (1) o Na Pista ainda não publica eventos; (2) a entrega do UL é 1 tentativa sem retry — o receptor do QD tem de ser idempotente por `X-UL-Event-Id` e o Platform precisa de retry antes de notificações críticas; (3) formato `type` é `domain.action` (2 partes) → `payment.confirmed`.

Catálogo: `Na Pista /v1/organizations/{ul_org}/products ──▶ CatalogContextSource (QD, Fase 3A) ──▶ contexto da IA`.

## 17. Entitlement model

O modelo UL (`plan_entitlements` key/value por plano de aplicação) **suporta** entitlements separados por chave (`automation.enabled`, `notifications.enabled`, `notifications.whatsapp.monthly.max`, `notifications.email.monthly.max`). **GAP:** uma organização só pode ter **uma** subscrição não cancelada por aplicação (`409` na segunda) e não há add-ons — logo "Automation Plan" + "Notification Plan" vendidos em separado para o mesmo `QUALE_A_DICA` **não é possível hoje**. Opções: (a) planos combinados com chaves por capacidade; (b) duas aplicações no registry (`QUALE_A_DICA_AUTOMATION`, `QUALE_A_DICA_NOTIFICATIONS`) partilhando o mesmo serviço; (c) conceito de add-on no Platform. Decisão de produto.

## 18. Future UL Client flow & migration roadmap

```
USER → UL CLIENT → signup/login (Auth UL) → UL PLATFORM → criar organização → escolher aplicações
     → subscrever → entitlements → Na Pista / QD (acesso por organização + membership UL)
```
Gaps reais para este fluxo: UL Client não tem signup nem criação de organização; não há convites por email (`F17-BACKEND-GAPS.md`); não há pagamento.

| Passo | O quê | Repo | Bloqueado por |
|---|---|---|---|
| 1 | Limpeza de governança (remover `.git` da pasta-mãe; remotes para `ul-client`, `na-pista*`) | — | decisão do dono |
| 2 | UL Client: signup + criar organização + convites | ul-client / ul-platform | — |
| 3 | QD: aceitar JWT UL (estratégia C) + `ecosystem_organization_links` | qualeadica | 2 |
| 4 | Planos/entitlements QUALE_A_DICA no UL (decidir §17) | ul-platform | decisão de produto |
| 5 | QD consome entitlements UL (fail-closed decidido) | qualeadica | 3, 4 |
| 6 | Na Pista publica eventos (outbox) + retry no Platform | na-pista / ul-platform | — |
| 7 | QD Notification API (receptor de webhooks UL, idempotente) | qualeadica | 6 |
| 8 | `NaPistaCatalogSource` (HTTP, `catalog.read`) | qualeadica | 3; variantes no Na Pista |
| 9 | Arquivar/remover o resíduo `na_pista*` da BD UL | ul-platform | autorização explícita (destrutivo) |

## 19. Implementation changes nesta fase

1. **SEGURANÇA CRÍTICA — QD (`dijpcg…`), corrigida e publicada.** Os roles `anon`/`authenticated` tinham SELECT/INSERT/UPDATE/DELETE nas 42 tabelas `public`, todas sem RLS; a anon key é pública (bundle da dashboard). Sonda com `limit=0` confirmou HTTP 200 em `platform_admins`, `messages`, `organization_whatsapp_connections` — qualquer pessoa podia ler/apagar dados ou inserir-se como platform admin. Nenhum cliente usava a Data API (só Auth); a API usa `postgres` (dono + `BYPASSRLS`). Migration `0026_lock_down_public_data_api` (RLS em todas as tabelas, revogação de privilégios actuais e por omissão) — testada numa BD descartável com os roles simulados, **aplicada em produção com autorização do dono**, verificada (Data API → `401 / 42501`; API continua a ler). Commit `43b98bf` no `qualeadica`.
2. Governança actualizada (§20).
3. Nenhum dado apagado, nenhuma BD alterada além do ponto 1.

## 20. Governança — o que mudou

| Documento | Regra encontrada | Ainda válida? | Alteração |
|---|---|---|---|
| `projeto_ul/CLAUDE.md` | "never depend … direct database access" (§2) | sim — é de **runtime** entre aplicações | clarificado: leitura de auditoria autorizada pelo dono ≠ dependência de runtime |
| `projeto_ul/CLAUDE.md` | §13 prioridade "UL Platform Core v1"; "Minha Express" | desactualizado | prioridade actual = integração do ecossistema; nome corrigido para "Micha Express" |
| `projeto_ul/CLAUDE.md` | sem regras de git/produção/cross-repo | lacuna | nova §15: READ / WRITE / GIT / PRODUCTION / mapa de repos + aviso do `.git` da pasta-mãe |
| `qualeadica/CLAUDE.md` | pipeline "IA só abaixo de 80%" | desactualizado | pipeline real + posição no ecossistema (Communication + Intelligence Layer) + regras de BD de teste |
| `qualeadica/.claude/settings.json` | nega `Read(.env)` | **sim** | mantida (o audit usou scripts que nunca imprimem valores) |

`projeto_ul/CLAUDE.md` **não está versionado em nenhum repositório com remote** (a pasta-mãe não tem commits) — a alteração é local; não foi feito commit na pasta-mãe de propósito.

## 21. Riscos e decisões pendentes do dono

1. Remover `.git` da pasta-mãe (armadilha de publicação).
2. Dar remote a `ul-client`, `na-pista`, `na-pista-console`, `na-pista-landing` (hoje sem backup remoto).
3. Projecto Supabase da landing UL inacessível — confirmar o env de produção da landing.
4. Escolher a estratégia de identidade (recomendada: C).
5. Modelo comercial Automation vs Notification (§17).
6. Limpeza do resíduo `na_pista*` na BD UL e dos 454 perfis / 52 organizações órfãs no QD (destrutivo — só com instrução explícita).
7. Retry na entrega de webhooks do UL antes de notificações críticas.
8. UL Platform: 11 migrações registadas vs 10 ficheiros — reconciliar.
9. UL Platform: `anon`/`authenticated` mantêm GRANTs em `public` (protegidos por RLS sem policies) — endurecer com REVOKE quando conveniente.

---

## Actualização — Fase 5 (2026-10-03)

Factos novos (detalhe em `docs/PHASE-5-FOUNDATION-HARDENING.md`):

- **Pasta-mãe:** `projeto_ul/.git` removido (estava vazio: 0 commits). `projeto_ul` já não é um repositório; os 8 filhos continuam independentes.
- **Divergência 11 vs 10 migrations na BD UL — causa:** a linha extra é `na-pista/drizzle/migrations/0000_organic_power_man.sql`, aplicada na BD do UL na fase spike (origem também do schema residual `na_pista`). Não bloqueia migrations do UL; limpeza por autorizar.
- **Webhooks UL:** passam a ter retry persistente, dedupe por evento/delivery, timeout, sem redirects; migration `0010` aplicada em produção (agora 12 linhas registadas).
- **Data API UL:** GRANTs de `anon`/`authenticated` ainda presentes (RLS bloqueia); revogação pronta na branch `phase-5/revoke-public-data-api-grants`, não aplicada.
- **QD:** tabelas de ligação ao ecossistema (`0027`) prontas na branch `phase-5/ecosystem-foundation`, não aplicadas.
