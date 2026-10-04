# PHASE 5.2 — UL Platform Production Runtime

> 2026-10-05 · sequência da Fase 5.1 (`docs/PHASE-5-FOUNDATION-HARDENING.md`).
> Sem segredos neste documento: só nomes de variáveis, refs de projecto truncadas, portas e códigos de estado.
> **Estado: NÃO está em produção.** O código e a configuração estão prontos; o deploy na Vercel e na Railway, o domínio e o DNS dependem de acesso às contas (§16).

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

**Production ready: NÃO.**
