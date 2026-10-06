# PHASE 5.2 — UL Platform Production Runtime

> 2026-10-05 · sequência da Fase 5.1 (`docs/PHASE-5-FOUNDATION-HARDENING.md`).
> Sem segredos neste documento: só nomes de variáveis, refs de projecto truncadas, portas e códigos de estado.
> **Estado (actualizado 2026-10-05, §18):** API em produção em `https://api.ultimalinha.ao` (Vercel) e worker a correr na Railway, ambos validados com evidência real. **Production ready: NO** — blockers em §18.9. As secções 1–17 descrevem a preparação (antes do deploy); a §18 é a execução.

## 1. Estado inicial

| | |
|---|---|
| Repo / branch / remote | `ul-platform` · `master` (`ca5a8b0`, limpo) · `ultimalinhalabs/ul_platform` |
| Runtime de produção | **nenhum** (Fase 5.1 §5.1.7): sem deploy, sem processo ligado à BD de produção |
| Desenvolvimento local | `.env` local com `DATABASE_URL` = **BD de produção** (`qajlwc…`, pooler de sessão 5432) |
| Vercel / Railway | sem configuração no repositório, sem CLI instalada, sem projecto ligado, sem credenciais na máquina |

## 2. Arquitectura encontrada

| Item | Real no código |
|---|---|
| Runtime | Express 5 + TypeScript ESM, compilado com `tsc` para `dist/` (**não** é Next.js) |
| Entrypoint HTTP | `src/server.ts` — criava a app, fazia `listen` **e** arrancava o retry worker no mesmo processo; a app não era exportável |
| Entrypoint do worker | **não existia** (o worker vivia dentro do `server.ts`) |
| Scripts | `build` = `tsc -p tsconfig.json` · `start` = `node dist/server.js` · `dev` = `tsx watch src/server.ts` · `db:migrate` = `drizzle-kit migrate` |
| Rotas | tudo sob `/v1` (19 routers, 66 rotas); auth por rota (JWT Supabase ou `ulk_`) |
| Health | `GET /v1/health` (liveness, sem BD) e `GET /v1/health/ready` (`select 1`) — **já existiam**, nenhum endpoint criado |
| Processo persistente | só o retry worker (`setInterval` 15 s) |
| Estado em memória | rate limiter por processo (`Map` + sweep timer `unref`) — ver §15 |
| Filesystem / WebSocket / LISTEN-NOTIFY / advisory locks / `SET` de sessão | nenhum |
| BD | `postgres` (postgres.js) `max:5`, `idle_timeout:20`, prepared statements activos; uma única variável `DATABASE_URL` |
| Migrations | `drizzle/migrations` 0000–0011; produção em `0011` (13 linhas registadas, inclui a órfã do Na Pista); **nenhuma pendente** |

## 3. Mudanças realizadas

| Ficheiro | Mudança | Porquê |
|---|---|---|
| `src/app.ts` (novo) | a app Express (helmet, CORS, requestId, timing, JSON, `/v1`, errorHandler) movida sem alterações | permitir servi-la sem `listen` (Vercel) |
| `src/server.ts` | só `listen` + shutdown; **deixa de arrancar o worker** | API e worker são processos distintos |
| `src/worker.ts` (novo) | processo dedicado: `select 1` no arranque (sai com código 1 se a BD falhar), `startWebhookRetryWorker`, shutdown que espera o tick em curso | worker persistente na Railway |
| `src/modules/webhooks/delivery.ts` | `startWebhookRetryWorker` devolve `{ workerId, stop }`; o timer deixa de ter `unref` (é ele que mantém o processo vivo); `stop()` espera o tick em curso | **motor de retry inalterado** (claim, lease, `SKIP LOCKED`, backoff, jitter, timeout, HMAC) |
| `src/db/index.ts` | `prepare: false` | a API na Vercel usa o pooler Supavisor em **modo transacção (6543)**, incompatível com prepared statements nomeados; correcto também no modo sessão |
| `api/index.js` (novo) | `export { default } from "../dist/app.js"` | Function única da Vercel; serve a mesma app compilada que o `npm start` |
| `vercel.json` (novo) | `framework: null`, `npm ci`, `npm run build`, `outputDirectory: public`, rewrite `/(.*)` → `/api` | não deixar a Vercel auto-detectar `src/server.ts`; não publicar a raiz do repo como estático |
| `public/README.md` (novo) | output estático vazio intencional | idem |
| `.vercelignore` (novo) | `.env`, `.env.*`, `*.pem`, `*.key`, `node_modules`, `dist` | um `vercel deploy` pela CLI nunca envia segredos locais |
| `railway.json` (novo) | build `npm run build`, start `npm run start:worker`, restart `ON_FAILURE` (10) | worker na Railway |
| `package.json` | `dev:worker` (`tsx watch src/worker.ts`), `start:worker` (`node dist/worker.js`) | |
| `.gitignore` | `.env.*`, `!.env.example`, `*.pem`, `*.key` | `.env.production` e afins não estavam ignorados |
| `README.md`, `src/middleware/requestId.ts` | referências ao novo entrypoint | |

Não alterado: `env.ts` (decisão do dono — §6), CORS (código), autenticação, HMAC, service-to-service, schema, migrations, permissões Supabase (a `0011` mantém-se).

**Mudança de comportamento local:** `npm run dev` já **não** processa retries; para isso corre-se também `npm run dev:worker`.

## 4. Configuração Vercel (preparada, **não criada**)

| Definição | Valor |
|---|---|
| Repositório | `ultimalinhalabs/ul_platform` |
| Branch de produção | `master` |
| Root directory | `/` (raiz do repo) |
| Framework preset | Other (`"framework": null` no `vercel.json`) |
| Install / Build | `npm ci` / `npm run build` (vêm do `vercel.json`) |
| Function | `api/index.js` (Node.js; `engines.node >=20`) |
| Preview deployments | **sem variáveis de ambiente** (não há BD de preview) → a Function falha na validação do env (fail-closed); nunca recebem a BD de produção |

Validado localmente: `import("./api/index.js")` devolve a app Express, não cria servidor e o processo termina sozinho (sem timer, worker ou listener). **Não validado:** o build real na Vercel (precisa da conta).

## 5. Configuração Railway (preparada, **não criada**)

| Definição | Valor |
|---|---|
| Serviço | worker, a partir de `ultimalinhalabs/ul_platform`, branch `master` |
| Build / Start | `npm run build` / `npm run start:worker` (de `railway.json`) |
| Restart policy | `ON_FAILURE`, máx. 10 |
| Réplicas | 1 recomendada (mais são seguras: `SKIP LOCKED` + lease) |
| Rede | sem porta pública, sem domínio, sem health check HTTP (o worker não serve HTTP) |
| Observabilidade | logs JSON: `worker.started` (com `workerId`), `webhook.delivery.attempt` por tentativa, `webhook.worker.error`, `worker.startup.db_error`, `worker.shutdown.*` |

Atenção ao build: o `tsc` é devDependency. Não definir `NODE_ENV=production` na fase de build da Railway (ou garantir que as devDependencies são instaladas), senão `npm run build` falha.

## 6. Variáveis de ambiente (nomes exactos do `src/config/env.ts`; sem valores)

| Variável | Usada por | Local (`.env`) | Vercel Production (API) | Vercel Preview | Railway (worker) |
|---|---|---|---|---|---|
| `DATABASE_URL` | `db/index.ts` | **BD local** `localhost:54329` | produção `qajlwc…` via pooler **transacção 6543** | — | produção `qajlwc…` via pooler **sessão 5432** |
| `APP_ENV` | logger, CORS guard | não definida (= development) | `production` | — | `production` |
| `NODE_ENV` | logger | `development` | **não definir** (a Vercel define `production` em runtime; defini-la no build salta as devDependencies) | — | ver §5 |
| `PORT` | `server.ts` | `4000` | não usada | — | não usada |
| `SUPABASE_URL` | JWT (JWKS) | projecto Auth UL | projecto Auth UL | — | exigida pelo `env.ts`, não usada |
| `SUPABASE_JWT_SECRET` | JWT HS256 | sim | sim | — | exigida pelo `env.ts`, não usada |
| `SUPABASE_ANON_KEY` | **nenhum código** | sim | exigida pelo `env.ts` | — | exigida pelo `env.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | **nenhum código** (só 2 scripts manuais) | sim | exigida pelo `env.ts` | — | exigida pelo `env.ts` |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | cifra dos segredos dos endpoints | sim | sim | — | sim — **tem de ser o mesmo valor da API** (o worker decifra o que a API cifrou) |
| `PLATFORM_ALLOWED_ORIGINS` | CORS | `localhost:3000,3002,3010` | os 8 origins de §9 | — | exigida quando `APP_ENV≠development` (mesmo valor) |
| `TEST_DATABASE_ALLOW_REMOTE` | guard de testes | não definir | não definir | — | não definir |

Decisão do dono: **manter o `env.ts`**. Consequência registada: a Vercel e a Railway recebem `SUPABASE_SERVICE_ROLE_KEY` (que nenhum código usa) e a Railway recebe `SUPABASE_JWT_SECRET` (que o worker não usa). Ver §15.

Valores de produção: copiados (hash verificado) para `%USERPROFILE%\.ul-secrets\ul-platform\production.env`, fora de qualquer repositório, ACL só para o utilizador `airto`. **Atenção:** o `DATABASE_URL` guardado é o do pooler de **sessão** (5432); a Vercel precisa da variante de **transacção** (mesmo host, porta 6543 — copiar do painel Supabase → Connect → Transaction pooler).

## 7. Domínio

`https://api.ultimalinha.ao` → projecto Vercel da API. Só depois de o deployment `*.vercel.app` passar todas as validações (§12).

## 8. DNS

Não foi criado nem inventado nenhum registo. Depois de adicionar o domínio na Vercel, usar **exactamente** o registo que o painel indicar para `api` em `ultimalinha.ao`, no gestor DNS do domínio (a confirmar pelo dono). Alteração DNS só com confirmação explícita do operador.

## 9. CORS

Allow-list explícita (nunca `*`; o `env.ts` recusa arrancar em produção sem ela). Origins indicados pelo dono para `PLATFORM_ALLOWED_ORIGINS` de produção:

```
https://napista.ao,https://www.napista.ao,https://console.napista.ao,https://client.ultimalinha.ao,https://console.ultimalinha.ao,https://app.ultimalinha.ao,https://qualeadica.ao,https://api.qualeadica.ao
```

Notas: (1) nenhum destes domínios aparece no código — vieram do dono; (2) `https://api.qualeadica.ao` é uma API, não uma página — só é necessário se um browser carregar páginas desse host; (3) `https://www.qualeadica.ao` existe no CORS do QD mas **não** foi incluído (não indicado); (4) chamadas servidor-a-servidor (`ulk_`, Na Pista API) não dependem de CORS.

Validado localmente: origin fora da lista → sem `Access-Control-Allow-Origin`; origin da lista → ecoado.

## 10. Health endpoint

Já existiam e mantêm-se: `GET /v1/health` → `{"data":{"status":"ok"}}` sem dependências, e `GET /v1/health/ready` → `select 1` (503 `NOT_READY` sem detalhes se a BD falhar). Não foi criado `GET /health` na raiz: os dois endpoints acima cobrem liveness e readiness.

## 11. Testes (todos locais; nada contra produção)

BD descartável (cluster Postgres 17 do scratchpad, `localhost:55432`), sem `.env` (`DOTENV_CONFIG_PATH` inexistente, valores fictícios do CI). `TEST_DATABASE_ALLOW_REMOTE` **não** foi usado.

| Verificação | Resultado |
|---|---|
| `typecheck` · `build` | OK (`dist/app.js`, `dist/server.js`, `dist/worker.js`) |
| `eslint src tests api` | OK (o `npm run lint` completo continua com os 20 erros pré-existentes em `scripts/`, Fase 5.1) |
| `db:migrate` + `db:seed` | OK |
| `npm test` | **222/223** — a falha é o teste intermitente pré-existente `listPlatformAuditLogs paginates…` (igual à Fase 5/5.1); inclui auth, JWT, api-keys, service-scopes, discovery, webhooks, `webhook-retry` (retry, backoff, lease, `SKIP LOCKED`, idempotência, dedupe) |
| `npm run smoke` | **125/125** |
| Varrimento de rotas sem credenciais | **66 rotas: 64 → 401, 2 health → 200, 0 violações**; `ulk_` forjado em `/v1/service/me` → 401; JWT inválido em `/v1/me` → 401 |
| Entrypoint Vercel | app exportada, sem `listen`, sem worker, processo termina sozinho |
| Worker e2e (processo separado `dist/worker.js`) | tentativa inline → 500 → `PENDING`; o worker entrega na tentativa 2 → `SUCCESS`, lease libertado; mesmo `X-UL-Event-Id` nas duas tentativas; HMAC válido em ambas; segredo ausente dos logs |
| Guard de testes | preservado (Fase 5.1 validou a recusa de host remoto e do `.env` de produção) |

## 12. Deployment

**Não feito.** Não há credenciais Vercel/Railway nesta máquina. Sequência preparada (a executar depois do login do dono, §16):

1. criar o projecto Vercel ligado a `ultimalinhalabs/ul_platform`, branch de produção `master`;
2. variáveis **só em Production** (§6, `DATABASE_URL` de transacção);
3. 1.º deployment → validar `https://<projecto>.vercel.app/v1/health`, `/v1/health/ready`, 401 sem credenciais, CORS (origin permitido vs. não permitido), `/v1/me` com um JWT real, `/v1/service/me` com uma chave `ulk_` real;
4. adicionar `api.ultimalinha.ao` → registo DNS exacto da Vercel (confirmação do operador) → validar TLS e repetir o passo 3 no domínio;
5. serviço Railway (§5), variáveis (§6, `DATABASE_URL` de sessão) → validar o log `worker.started`, ausência de `worker.startup.db_error` e uma ligação do worker visível em `pg_stat_activity`;
6. validar o retry em produção sem eventos de negócio: só com um endpoint de teste controlado e autorização (hoje há 0 endpoints activos e 0 deliveries pendentes).

Nenhuma migration é aplicada pelo deploy (build = `tsc`; `db:migrate` não faz parte de nenhum comando de build/start).

## 13. Worker

O worker **não está em produção**. Código, entrypoint, config Railway e e2e local estão prontos. Falta: conta Railway, criação do serviço, variáveis e validação em produção (§12 passos 5–6).

## 14. Segurança

| Verificação | Estado |
|---|---|
| Segredos fora do Git | `.env` ignorado; `.env.*`/`*.pem`/`*.key` passam a ignorados; `.vercelignore` impede uploads; nenhum valor no código ou neste relatório |
| Service role key só no backend | nunca usada pelo código; só chega a Vercel/Railway porque o `env.ts` a exige (decisão do dono) |
| CORS | allow-list explícita, sem `*`, validada |
| HMAC / service-to-service | inalterados: `Bearer ulk_<id>.<secret>`, SHA-256, `timingSafeEqual`, scopes, binding à organização, `/v1/service/me` (testes + varrimento) |
| Endpoints anónimos | só `/v1/health` e `/v1/health/ready` |
| Logs | sem tokens/segredos (e2e confirmou o segredo do webhook ausente); o logger nunca regista payload/headers de auth |
| Credenciais hardcoded | nenhuma no código da app |
| Permissões Supabase | `0011` intacta; nada reaberto |
| Local ↔ produção | **corrigido**: o `.env` local aponta para `localhost:54329` (cluster dedicado em `%USERPROFILE%\.ul-dev`, scram, ACL só do utilizador). As outras variáveis locais (`SUPABASE_*`) continuam a apontar para o projecto Auth UL, o fornecedor de identidade partilhado |

## 15. Riscos restantes

1. **Nada em produção ainda** (API, worker, domínio).
2. `SUPABASE_SERVICE_ROLE_KEY` (não usada) na Vercel e na Railway, e `SUPABASE_JWT_SECRET` na Railway — superfície de credenciais desnecessária (decisão: manter `env.ts`). Mitigação possível no futuro: tornar estas variáveis opcionais/por processo.
3. Rate limiter em memória: na Vercel cada instância tem o seu contador → o limite efectivo multiplica pelo número de instâncias. Aceitável hoje (aplicado só a emissão/revogação de credenciais, teste de webhook e discovery); um limite distribuído seria trabalho próprio.
4. A 1.ª tentativa de entrega de um webhook continua inline no pedido `POST /v1/organizations/:org/events` (até 10 s por endpoint, em série) — dentro da duração de uma Function, mas aumenta a latência do pedido. Os retries são só do worker.
5. Sem BD de preview: os deployments de preview da Vercel ficam sem variáveis (falham em vez de tocarem produção).
6. Desenvolvimento local: o cluster local não arranca sozinho depois de reiniciar o Windows (§16).
7. `npm run lint` do repositório falha em `scripts/` (pré-existente) — o CI falha nesse passo.
8. Os consoles locais já não vêem dados de produção (consequência intencional da separação).

## 16. Acções manuais do dono

1. **Vercel:** `! npx vercel login` (ou um token `VERCEL_TOKEN`), e confirmar a equipa/conta onde o projecto deve ficar.
2. **Railway:** `! npx @railway/cli login` (ou `RAILWAY_TOKEN`), e confirmar o projecto Railway.
3. Copiar do painel Supabase a connection string do **Transaction pooler** (6543) para a Vercel; a de sessão (5432) para a Railway. Os restantes valores estão em `%USERPROFILE%\.ul-secrets\ul-platform\production.env`.
4. DNS de `ultimalinha.ao`: indicar o gestor do domínio e confirmar o registo que a Vercel mostrar.
5. Arranque da BD local depois de reiniciar: `"C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe" -D "%USERPROFILE%\.ul-dev\pgdata" -o "-p 54329 -c listen_addresses=localhost" -l "%USERPROFILE%\.ul-dev\pg.log" start`.
6. Confirmar os origins de CORS (§9, notas 2–3).

## 17. Próximos passos

1. Com os logins: executar §12 e actualizar este relatório com as evidências (URL, health, CORS, auth, service auth, TLS, DNS, worker, retry).
2. Registar o endpoint de produção da API no próprio registry (`application_endpoints`) só quando o domínio estiver validado — e só com autorização.
3. Avaliar uma migration para os default ACLs residuais (`supabase_admin`, funções) e `public.rls_auto_enable` (Fase 5.1).
4. Corrigir o lint de `scripts/` para o CI voltar a verde.

### Checklist de produção (§15 do pedido)

| Item | Estado |
|---|---|
| Vercel deployment successful · API responde · `/v1/health` responde | ⏳ falta conta Vercel |
| Production database confirmado | ⏳ (config definida; validar no deploy) |
| Secrets configurados | ⏳ |
| CORS validado | ✅ local · ⏳ produção |
| Auth / service auth validados | ✅ local (testes + varrimento) · ⏳ produção |
| Webhook endpoint validado | ✅ local · ⏳ produção |
| Worker persistente / retry worker validados | ✅ local (e2e) · ⏳ Railway |
| DNS `api.ultimalinha.ao` · HTTPS | ⏳ |
| Logs sem segredos | ✅ local |
| Local não aponta para produção | ✅ |
| Migrations não aplicadas indevidamente | ✅ (nenhuma aplicada nesta fase) |
| Smoke tests | ✅ local 125/125 |

**Production ready: NÃO** (estado antes do deploy — ver §18.9 para o estado actual).

---

## 18. Execução do deployment (2026-10-05)

Contas autenticadas pelo dono nesta máquina (CLIs `vercel` 62.2.0 e `railway` 5.63.1). Nenhum valor secreto neste documento; todas as variáveis foram passadas por stdin a partir de `%USERPROFILE%\.ul-secrets\ul-platform\production.env`.

### 18.1 Contas e projectos

| | Vercel | Railway |
|---|---|---|
| Conta / equipa | `ultimalinhalabs` · equipa `ultima-linha` · plano **Hobby** | Última Linha Labs · workspace plano **HOBBY em trial** (`isTrialing: true`, crédito 5 USD, cliente `INACTIVE`) |
| Projecto | **`ul-platform`** (`prj_vDKfmehm…`) criado; `project-gbh3l` (vazio, sem deploys, sem repo) **não tocado**; `ultimalinha-landing` não tocado | **`ul-platform`** (`b49d201c…`), ambiente `production`, serviço **`worker`** (`0f7795d4…`) |
| Repositório | `ultimalinhalabs/ul_platform` — **a ligação Git falhou** (a Vercel GitHub App não tem acesso ao repo); deploy feito pela CLI | `ultimalinhalabs/ul_platform`, branch `master` (ligado; o deploy inicial veio da ligação, mas um push posterior — `edc1df6` — **não** disparou redeploy: deploy automático por push não confirmado) |
| Região | Functions em **`lhr1`** (Londres; alterado de `iad1` — a BD está em `eu-west-2`) | **EU West** (`europe-west4`), 1 réplica |

### 18.2 Vercel

- Variáveis **só em Production** (8): `APP_ENV`, `DATABASE_URL` (Secret, **pooler de transacção 6543**), `SUPABASE_URL`, `SUPABASE_ANON_KEY` (Secret), `SUPABASE_SERVICE_ROLE_KEY` (Secret), `SUPABASE_JWT_SECRET` (Secret), `WEBHOOK_SECRET_ENCRYPTION_KEY` (Secret), `PLATFORM_ALLOWED_ORIGINS`. Preview: 0 variáveis. Development: 0. `NODE_ENV`, `PORT`, `TEST_DATABASE_ALLOW_REMOTE`: não definidas.
- O `DATABASE_URL` 6543 foi derivado do de sessão (mesmo host Supavisor, mesmas credenciais, porta 6543) e **verificado antes** com uma ligação `READ ONLY`: mesma BD (13 migrations registadas).
- Deployment de produção `dpl_39nsX7xPuHWfG6hU2cggKku6Ru2q` (commit `c7dec41`), **Ready**, build 23 s, uma Function `api/index` (1.32 MB) em `lhr1`. Aliases: `ul-platform.vercel.app`, `ul-platform-ultima-linha.vercel.app`.
- Deployment Protection activa nos URLs `*.vercel.app` (`all_except_custom_domains`) — validados com `vercel curl`; o domínio próprio é público.
- `vercel link` criou `.vercel/` (ignorado) e um `.env.local` com um token OIDC da Vercel de curta duração (ignorado; não lido pela app — o `dotenv` só lê `.env`). Também acrescentou `.env*` ao `.gitignore` depois de `!.env.example`; corrigido para só `.vercel`.

### 18.3 Domínio, DNS e TLS

| Item | Evidência |
|---|---|
| Domínio | `api.ultimalinha.ao` associado ao projecto `ul-platform`, `verified: true` |
| DNS | nameservers de `ultimalinha.ao` = **AngoWeb** (`ns1/ns2.mx.angoweb.net`). Registo indicado pela Vercel (rank 1) e criado pelo operador na AngoWeb, **após confirmação explícita**: `CNAME api → ba567697a95a6679.vercel-dns-017.com` (TTL 3600) |
| Propagação | resolvido em `ns1`/`ns2` AngoWeb, `1.1.1.1` e `8.8.8.8`; Vercel `misconfigured: false` |
| TLS | certificado `cert_7jXnpuMe…` emitido pela Vercel: `CN=api.ultimalinha.ao`, Let's Encrypt, válido até 2027-01-03, renovação automática; `curl` verify OK |
| HTTP | `http://` → **308** para `https://`; `Strict-Transport-Security: max-age=31536000; includeSubDomains` |

### 18.4 Validação da API em produção (`https://api.ultimalinha.ao`; repetida também no `*.vercel.app`)

| Teste | Resultado |
|---|---|
| `GET /v1/health` | **200** `{"data":{"status":"ok"}}` |
| `GET /v1/health/ready` | **200** `{"data":{"status":"ready"}}` — BD de produção acessível via pooler 6543 |
| Sem credenciais: `/v1/me`, `/v1/organizations/:id`, `/v1/platform/audit-logs`, `/v1/service/me` | **401** em todas |
| JWT inválido (`/v1/me`) · `ulk_` forjada (`/v1/service/me`) | **401** · **401** |
| Ficheiros: `/package.json`, `/.env`, `/dist/app.js`, `/api/index.js` | **404** em todos (só o `public/README.md` vazio é estático) |
| Cabeçalhos | `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `X-Request-Id`; sem `X-Powered-By` |
| CORS (preflight) | os 9 origins da allow-list ecoados em `Access-Control-Allow-Origin`; `https://evil.example`, `http://localhost:3000` e `null` → **sem** cabeçalho |
| **JWT real** (`/v1/me`) | **200** — sessão real do Auth UL para o platform admin `p***93@ultimalinha.dev` (autorizado pelo dono), obtida pela Admin API (magic link gerado e verificado, sem envio de email nem password); token **ES256** (`role: authenticated`, `amr: otp`) → valida o caminho JWKS. Sessão terminada (`logout` 204) depois de cada validação |
| **Service auth real** (`/v1/service/me`) | **200** — chave temporária de plataforma `NA_PISTA`, scope único `usage.read`, expiração 15 min, criada e revogada com as funções do próprio código (auditadas, actor `p***93`). Resposta: `application: NA_PISTA`, `organizationId: null`, `scopes: ["usage.read"]`. Depois da revogação a mesma chave → **401**. Chaves usadas: `4808e060…` (`*.vercel.app`) e `9a0de15c…` (domínio final), ambas `REVOKED` |

Nota sobre o JWT: o logout termina a sessão (refresh token), mas um access token já emitido continua criptograficamente válido para a UL Platform até expirar (≤ 1 h), porque a verificação é local (assinatura + `exp`). Comportamento esperado de JWTs.

CORS — `https://api.qualeadica.ao` é uma API, não uma página; nenhum teste mostrou uso por browser desse origin. Fica na allow-list (autorizado) como **candidato a remoção futura**. `https://www.qualeadica.ao` foi incluído por autorização explícita do dono.

### 18.5 Worker (Railway)

| Item | Evidência |
|---|---|
| Serviço | criado vazio, variáveis definidas com `--skip-deploys`, **só depois** ligado ao repo → o 1.º build já tinha variáveis |
| Variáveis (8) | `APP_ENV=production`, `DATABASE_URL` (**pooler de sessão 5432**), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `WEBHOOK_SECRET_ENCRYPTION_KEY` (mesmo valor da API), `PLATFORM_ALLOWED_ORIGINS` (exigida pelo `env.ts` quando `APP_ENV≠development`). `NODE_ENV` e `TEST_DATABASE_ALLOW_REMOTE` **não** definidas |
| Build | Railpack: `npm ci` (com devDependencies) → `npm run build` (`tsc`) — o `railway.json` foi aplicado |
| Start | `npm run start:worker` → `node dist/worker.js` |
| Deploy | `a686f577…` **SUCCESS** (commit `c7dec41`). Dois deploys anteriores falharam **antes do build** por erro meu de configuração: o `scale eu-west=1` acrescentou EU West à região por omissão (`sfo`) e o plano só permite uma região (`configErrors`); corrigido para `eu-west=1, sfo=0` |
| Restart / réplicas / rede | `ON_FAILURE`, máx. 10 · 1 réplica, só EU West · **sem domínio público**, sem porta, sem health check HTTP |
| Arranque | log `event="worker.started"`, `environment="production"`, `workerId="webhook-worker-e7d9676b…"`; **0** `worker.startup.db_error` (o `select 1` à BD de produção passou), **0** `webhook.worker.error`, **0** shutdowns, **1** arranque de contentor ao fim de vários minutos (sem reinícios) |
| Ligação à BD | `pg_stat_activity` passou a mostrar 2 ligações `Supavisor`/`postgres` que não existiam antes do deploy (compatíveis com worker + API; o Supavisor não identifica a origem — evidência indirecta) |
| API não corre o worker | logs da Vercel (2 h): **0** ocorrências de `worker.started`/`webhook-worker`; o entrypoint `api/index.js` só importa `dist/app.js` |
| Estado de entregas | 0 `PENDING`, 0 com lease activo, 2 deliveries históricas (`SUCCESS`) |

### 18.6 Retry em produção — **validado** (tentativa 2, §18.6.2)

O único mecanismo de teste existente, `POST /v1/organizations/:org/webhooks/:id/test` (`testWebhookEndpoint`), faz **uma tentativa directa, sem persistir delivery nem retry** — não exercita o worker. O caminho com retry é `POST /v1/organizations/:org/events` (`publishEvent`), que exigiria em produção: uma organização, um webhook endpoint `ACTIVE` subscrito a um tipo de evento, uma chave `ulk_` org-scoped com `event.publish`, a publicação de um evento e um **receptor público controlado** (500 → 200) acessível a partir da Railway. Nada disso existe, e criar dados de produção ou um receptor externo não estava autorizado — **parado para decisão do dono**. Validação equivalente feita localmente (§11): processo `dist/worker.js` separado, 500 → `PENDING` → retry → `SUCCESS`, mesmo `X-UL-Event-Id`, HMAC válido, lease libertado, segredo fora dos logs.

#### 18.6.1 Ensaio controlado em produção — tentativa 1 (2026-10-05, autorizado pelo dono) — **incompleto**

Plano autorizado: organização sintética `TEST — UL retry check 2026-10-05` (slug `test-ul-retry-check-20261005`), endpoint exclusivo (aplicação `NA_PISTA`, só `webhook.test` — tipo sintético já usado pela plataforma; **não existe event catalog** no código, decisão confirmada pelo dono), chave org-scoped só com `event.publish` (expiração 30 min), receptor local 500 → 200 exposto por um Cloudflare Quick Tunnel (`cloudflared` instalado com autorização), evento publicado pela API real (`POST https://api.ultimalinha.ao/v1/organizations/{org}/events`).

| Facto | Evidência |
|---|---|
| Dados criados (11:22 UTC) | org `4eec7529…`, 1 membership OWNER (`p***93`), endpoint `6d78405c…`, chave `8df32128…`, evento `evt_1481451a…` (`webhook.test`), delivery `edf8463b…` |
| Publicação pela API de produção (Vercel) | evento persistido + 1 delivery (tentativa 1 inline) |
| **Retry pela Railway** | logs do worker: tentativas **2, 3, 4, 5, 6** desta delivery (`webhook.delivery.attempt`), com backoff crescente (11:22:46 → 11:23:42 → 11:25:20 → … → 11:37:13; próxima marcada para 11:55:04); estado mantido `PENDING`; lease libertado entre tentativas (`locked_by`/`locked_until` nulos) |
| Resposta recebida pelo worker | **HTTP 530** da Cloudflare em todas as tentativas registadas — o túnel não encaminhou para o receptor, apesar de a sonda de prontidão (feita a partir desta máquina) ter passado pelo túnel. Causa não confirmada (hipótese: rota do quick tunnel ainda não disponível no colo da Cloudflare usado pela Railway) |
| Receptor | não confirmado que tenha recebido alguma tentativa → **sem** verificação de 500 → 200, HMAC e `X-UL-Event-Id` do lado do receptor |
| Segredos nos logs | nenhum segredo nos logs do worker (as linhas só têm ids, tentativa, estado, `httpStatus`, duração) |

**Incidente (erro meu):** o orquestrador chamava `railway logs` de forma síncrona; o comando ficou em modo contínuo, bloqueou o processo e o `timeout` externo terminou-o **sem** executar o bloco de limpeza. Os dados de teste ficaram em produção ~35 min (o worker continuou a tentar o túnel). Detectado por verificação directa na BD; limpeza feita em seguida com as funções auditadas do próprio código:

| Limpeza (11:5x UTC) | Resultado |
|---|---|
| chave `8df32128…` | `REVOKED` (auditado) |
| endpoint `6d78405c…` | `REVOKED` (auditado) |
| organização de teste | apagada com `deleteOrganization` (auditado) → cascata |
| Depois | organização 0, memberships 0, chaves 0, endpoints 0, eventos 0, delivery 0; `audit_logs` da organização **preservados** (2 linhas, `organization_id` NULL) |
| Processos locais | `cloudflared` e o script parados |

Conclusão desta tentativa: o **worker de retry está activo e a executar retries em produção** (evidência directa nos logs da Railway); o **ciclo completo 500 → retry → 200 com HMAC/`X-UL-Event-Id` verificados no receptor continua por provar em produção** — feito na tentativa 2 (§18.6.2).

#### 18.6.2 Ensaio controlado em produção — tentativa 2 (2026-10-05) — **VALIDADO**

Correcções em relação à tentativa 1: nenhum subprocesso síncrono; **pré-teste do túnel a partir de dentro do contentor do worker da Railway** antes de criar qualquer dado (abortaria sem criar nada); limpeza imediatamente a seguir ao ensaio (antes de ler logs), também em SIGINT/SIGTERM e com prazo interno de 12 min; execução sem `timeout` externo.

Acesso para o pré-teste (autorizado pelo dono): chave SSH **efémera** ed25519 dedicada (`SHA256:2GhMdgcm…`), registada na Railway só durante o ensaio; host key `ssh.railway.com` aceite no primeiro contacto (`SHA256:+S1xg92F…`). A chave pessoal `id_ed25519` (com passphrase) chegou a ser registada e foi removida sem uso.

| Passo | Evidência real |
|---|---|
| Pré-teste local / a partir da Railway | `204` / `RAILWAY_PROBE=204` — só então foram criados dados |
| Organização TEST | `0163e1f9…`, slug `test-ul-retry-check-20261005` (actor `p***93`) |
| Endpoint TEST | `28535ba3…`, aplicação `NA_PISTA`, só `webhook.test`, URL do túnel |
| Chave TEST | `1f3d5114…`, org-scoped, scopes `["event.publish"]`, expiração 30 min |
| Publicação pela API de produção (Vercel) | `POST https://api.ultimalinha.ao/v1/organizations/{org}/events` → **202**, `eventId=evt_9808fab6…`, `deliveries: 1`, `idempotent: false` |
| **Delivery persistida** | `fa4842cd…` |
| **Tentativa 1 falhou** | executada pela **Vercel** (inline): receptor respondeu **500**; log Vercel `attempt=1 status=PENDING httpStatus=500` |
| **Estado PENDING** | após a tentativa 1: `PENDING`, `attempt=1`, próxima em 28 s, sem lease |
| **Retry pelo worker Railway** | log do worker Railway `attempt=2 status=SUCCESS httpStatus=200` (nenhum worker local a correr; a API não corre worker) |
| **Tentativa 2 com sucesso** | receptor respondeu **200**; BD: `SUCCESS`, `attempt=2`, `response_status=200`, `delivered_at=2026-10-05T11:57:45Z`, latência 1406 ms |
| **Mesmo `X-UL-Event-Id`** | as 2 chamadas recebidas: `sameEvent: true`, `sameDelivery: true` (`X-UL-Delivery-Attempt` 1 e 2) |
| **HMAC válido** | `sigOk: true` nas 2 tentativas (verificado no receptor com o segredo do endpoint, `X-UL-Timestamp` + corpo bruto) |
| **Lease libertado** | `locked_until = NULL`, `locked_by = NULL` |
| **Sem segredos nos logs** | 3 valores procurados (segredo do webhook, token `ulk_` completo, parte secreta) → **0** ocorrências nos logs da Railway e **0** nos da Vercel |

Intervalo: tentativa 1 às 11:57:04, tentativa 2 às 11:57:44 (backoff ~30 s ± jitter + tick de 15 s do worker).

Limpeza (executada pelo próprio script, auditada):

| Item | Resultado |
|---|---|
| chave `1f3d5114…` | `REVOKED` |
| endpoint `28535ba3…` | `REVOKED` |
| organização TEST | apagada (`deleteOrganization`) → cascata |
| Restante na BD | org 0, memberships 0, chaves 0, endpoints 0, eventos 0, delivery 0; `audit_logs` preservados (os 2 ensaios: 4 linhas) |
| Verificação independente | 0 organizações `test-ul-retry-check%`; total de organizações **9** (igual ao estado anterior); 0 deliveries `PENDING` |
| Acessos temporários | chave SSH efémera removida da Railway e apagada do disco; nenhuma chave SSH registada na Railway; entrada `ssh.railway.com` removida do `known_hosts`; `cloudflared` parado (continua instalado em `%LOCALAPPDATA%\Microsoft\WinGet\Packages`) |

Nenhum schema, migration, motor de retry ou organização existente foi alterado.

### 18.7 Segurança — verificação pós-deploy

- Nenhum segredo no Git, nas saídas das CLIs ou neste documento; variáveis sensíveis da Vercel como *Secret*.
- O PAT do Supabase (`sbp_…`, Management API, toda a conta) que tinha sido colocado no `.env` do repo foi movido para `%USERPROFILE%\.ul-secrets\ul-platform\supabase-pat.env` (ACL só do utilizador) e **não foi usado**. Recomendação: revogá-lo no painel Supabase quando deixar de ser necessário.
- `0011` intacta, nenhuma permissão Supabase alterada, nenhuma migration aplicada (produção continua com 13 linhas), schema inalterado, `env.ts` inalterado.
- Credenciais temporárias de validação: 2 chaves `ulk_` (revogadas, 401 confirmado) e 2 sessões Auth (logout).

### 18.8 Problemas encontrados

1. Ligação Git da Vercel falhou inicialmente (GitHub App sem acesso) — deploy pela CLI. **Resolvido em 2026-10-06** pelo dono: projecto ligado a `ultimalinhalabs/ul_platform`, branch de produção `master` (deploy automático verificado em §18.10).
2. Railway: 2 deploys falhados por configuração de região (erro meu, corrigido).
3. `vercel link` alterou o `.gitignore` de forma a anular `!.env.example` (corrigido).
4. A Railway marca o `railway.json` (config-as-code) como *deprecated*; continua a funcionar até **2026-12-01** — migrar antes dessa data.
5. Deploy automático da Railway por push **não funcionou**: o push `edc1df6` não gerou deploy (≥ 5 min). O worker continua no `c7dec41` (código idêntico — o commit era só documentação). Verificar o acesso da Railway GitHub App a `ultimalinhalabs/ul_platform` e os triggers do serviço; até lá, novos deploys do worker só por `railway service redeploy` / `railway up`.

### 18.9 Checklist final

| Item | Estado | Evidência |
|---|---|---|
| Vercel deployment successful | ✅ | `dpl_39nsX7…` Ready |
| API responde · `/v1/health` responde | ✅ | 200 no domínio final |
| Production database confirmado | ✅ | `/v1/health/ready` 200 (6543); worker `select 1` OK (5432); mesma BD (13 migrations) |
| Secrets configurados | ✅ | 8 + 8 variáveis, só Production |
| CORS validado | ✅ | 9 permitidos ecoados; 3 recusados |
| Auth validado | ✅ | JWT real 200; inválido 401 |
| Service auth validado | ✅ | chave real 200; revogada 401; forjada 401 |
| Webhook endpoint validado | ✅ | entrega real em produção a um endpoint TEST (§18.6.2) |
| Worker persistente validado | ✅ | `worker.started`, sem erros nem reinícios |
| Retry worker validado | ✅ | ensaio controlado em produção: Vercel tentativa 1 → 500 → `PENDING` → worker Railway tentativa 2 → 200 → `SUCCESS`; mesmo `X-UL-Event-Id`; HMAC válido; lease libertado; 0 segredos nos logs — §18.6.2 |
| DNS `api.ultimalinha.ao` | ✅ | CNAME propagado |
| HTTPS | ✅ | Let's Encrypt, HSTS, 308 |
| Logs sem secrets | ✅ | eventos de arranque e entregas sem segredos; nenhum segredo impresso |
| Local não aponta para produção | ✅ | `.env` → `localhost:54329` |
| Migrations não aplicadas indevidamente | ✅ | 13 linhas, inalterado |
| Smoke tests | ✅ | local 125/125 + validação de produção acima |

**Production ready: NO**

Blockers:
1. ~~Ciclo de retry em produção~~ — **resolvido** (§18.6.2).
2. **Railway em trial** (crédito 5 USD, cliente inactivo) — quando o crédito acabar o worker pára e deixa de haver retries. Activar um plano pago.
3. ~~Deploy contínuo do worker~~ — **resolvido em 2026-10-06** (§18.10): GitHub App da Railway autorizada pelo dono em `ultimalinhalabs/ul_platform` e trigger `github`/`master` criado.

Riscos não bloqueantes: Vercel **Hobby** (uso não comercial pelos termos da Vercel — passar a Pro antes de tráfego comercial); `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_JWT_SECRET` presentes onde não são usadas (decisão: manter `env.ts`); rate limiter por instância; `railway.json` deprecated a partir de 2026-12-01; PAT do Supabase guardado localmente (revogar quando possível).

### 18.10 Deploy contínuo — verificação (2026-10-06)

| Plataforma | Evidência |
|---|---|
| Vercel — ligação Git | projecto `ul-platform` ligado pelo dono a `github` → `ultimalinhalabs/ul_platform`, branch de produção `master` (01:25 UTC) |
| Vercel — push de teste | commit `e573f60` (alteração real ao relatório) empurrado às 01:26:35 → deployment `dpl_B1doB3wHtiH7mfM6XMG9vso3m76A`, `target: production`, origem Git (`master`/`e573f60`), **READY** às 01:27:12 (~25 s) |
| Vercel — domínio | `api.ultimalinha.ao` passou a apontar para `dpl_B1doB3w…`; `/v1/health` 200, `/v1/health/ready` 200, `/v1/me` sem credenciais 401, `ulk_` forjada 401, `/package.json` 404, CORS permitido ecoado / `evil.example` ausente |
| Railway — mesmo push | **sem** novo deploy: o worker continua em `a686f577` (`c7dec41`). Causa: `deploymentTriggers` do serviço `worker` = **vazio** (a ligação da fonte fez só o deploy inicial). O código do worker não mudou desde `c7dec41` (os commits seguintes são só documentação/`.gitignore`), por isso o worker em execução está actualizado |
| Railway — causa e correcção | o "Could not load branches" no painel = a GitHub App da Railway sem acesso ao repo (conta pessoal `ultimalinhalabs`). O dono autorizou a app e ligou o branch: trigger `2e37fbb2…` (`provider: github`, `ultimalinhalabs/ul_platform`, `branch: master`, `checkSuites: false`) |
| Railway — deploy ao ligar | `1873a8f4…` (commit `7021186`) **SUCCESS**; o anterior `a686f577…` ficou `REMOVED`; log `worker.started` (`environment=production`), 0 `worker.startup.db_error`, 0 `webhook.worker.error`, 1 arranque |
| Railway — push de teste | ver linha seguinte (commit deste registo) |
