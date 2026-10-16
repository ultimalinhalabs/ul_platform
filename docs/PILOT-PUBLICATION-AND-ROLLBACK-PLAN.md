# Plano de publicação e reversão — piloto Na Pista Crescimento

> Preparado a 16/10/2026 (passo 5). **Nada foi publicado.** Cada passo marcado com 🔐 precisa de autorização
> explícita do dono no momento, conforme o §15 do CLAUDE.md. Estado da produção verificado só em leitura
> (`BEGIN READ ONLY`, apenas contagens).
>
> **Valores comerciais:** Na Pista Crescimento, 25 000 Kz / 30 dias, 500 produtos, 5 utilizadores, são
> **propostos e não aprovados para produção**. O catálogo e os termos não são carregados nem aprovados em
> produção sem autorização. Documentos relacionados em `docs/pilot/`:
> - `PILOT-JOURNEY.md` — o ciclo completo do cliente;
> - `LEGAL-REVIEW-CHECKLIST.md` — revisão jurídica;
> - `PAYMENTS-AND-COMMUNICATIONS-SETUP.md` — pagamentos e comunicações.

## 1. O que vai ser publicado

| Repositório | Branch local | Commits por publicar | Destino |
|---|---|---|---|
| ul-platform | `feature/pilot-readiness` | 7, de `b78a799` a `8fe5a12`, mais o commit deste plano | Vercel `ul-platform` (API) e Railway `worker` (auto-deploy de `master`) |
| ul-console | `feature/manual-payment-confirmation` | 2 (`1f9fc4e`, `fd9b63b`) | Vercel `ul-console` (auto-deploy de `master`) |
| ul-client | `block-2c/no-organization-onboarding` | 9 (PR #2 em rascunho já existe; a branch remota está atrasada) | Vercel `ul-client` (auto-deploy de `master`) |
| na-pista | `feature/plan-limits-products` | 2 (`9d5188e`, `0b4602d`) | ⚠️ **não existe destino de produção** (ver §6) |
| na-pista-console | `feature/team-invitations` | 1 (`4e83ba5`) | ⚠️ não existe projeto Vercel (ver §6) |

Node: os três projetos Vercel estão em **24.x**. O Railway (Railpack) segue o `engines.node`, que na produção
ainda é `>=20` e passa a `24.x` com este merge. É a mesma versão usada na CI e localmente.

## 2. Estado da produção (leitura, 16/10/2026)

- Migrações aplicadas até à **0021**. Pendentes, pela regra do drizzle: **0022 a 0028**, exatamente as deste plano.
- Tabelas que as migrações alteram: `plans` 7, `proposals` 0, `proposal_items` 0, `contracts` 0,
  `entitlement_grants` 0, `organizations` 10.
- Nenhuma tabela nova existe ainda. Nenhum grant viola a regra nova de ativação (0023). Nenhum utilizador
  tem mais de 10 organizações (janela de criação da 0022).
- Ainda não existem `NA_PISTA_GROWTH` nem termos `np-tos-*`.

## 3. Revisão das migrações 0022–0028

| Migração | O que faz | Toca em tabelas existentes? | Risco |
|---|---|---|---|
| 0022 | `organization_creation_requests` (idempotência de `POST /v1/organizations`) | índice novo em `organizations(created_by, created_at)` | baixo (10 linhas; bloqueio de escrita de ms) |
| 0023 | `commercial_payments` (append-only, trigger), permissão `platform.payment.confirm`, scope `payment.confirm` | `entitlement_grants`: coluna nullable e check recriado (0 linhas) | baixo |
| 0024 | catálogo self-service: `plans.purchase_mode/price/currency/period_days/terms_template_id`; `proposals.channel`, `request_idempotency_key`; `duration_days` | colunas com default ou nullable; checks passam nas 7 linhas de `plans` | baixo |
| 0025 | `organization_invitations` (RLS) | não | nulo |
| 0026 | renovação: `contract_renewal_authorizations`, `contract_renewals`; `commercial_payments.renewal_id`; índices únicos refeitos; trigger de pagamentos alargado | só `commercial_payments` (criada na 0023, vazia) | baixo |
| 0027 | `payment_proofs`, `payment_proof_files` (bytea, imutável); permissão `platform.payment_proof.read`; papel **`PLATFORM_FINANCE`** (sem membros) | inserções em catálogos de permissões | nulo |
| 0028 | `email_outbox` (RLS) | não | nulo |

Todas são aditivas. Nenhuma faz backfill, `DROP` de dados ou `UPDATE` em massa. Todas as tabelas novas
têm RLS ativo sem políticas e `REVOKE` para `anon/authenticated`. Os nomes de FK com mais de 63
caracteres são truncados pelo PostgreSQL (aviso apenas), como já acontece em migrações anteriores.

## 4. Sequência de publicação

1. 🔐 **Backup**: confirmar que existe um backup/PITR recente no Supabase do projeto UL (dashboard → Database →
   Backups). Anotar a hora.
2. 🔐 **Migrações em produção (0022–0028)**: aplicar com a receita segura:
   - extrair (`git archive`) as migrações exatas do commit aprovado;
   - simular a regra do drizzle e **abortar se o conjunto pendente não for exatamente 0022–0028**;
   - aplicar numa única execução.
   - Verificação a seguir: 30 linhas em `drizzle.__drizzle_migrations`, as tabelas novas existem e as
     contagens do §2 ficam iguais.
3. 🔐 **Variáveis de ambiente** (antes do merge, para o deploy já arrancar com elas):
   - **Vercel `ul-platform` (API):**
     - `PAYMENT_BANK_NAME`, `PAYMENT_ACCOUNT_HOLDER`, `PAYMENT_IBAN`, `PAYMENT_MCX_EXPRESS_NUMBER` (o dono fornece);
     - `PAYMENTS_NOTIFY_EMAIL` (ex.: financeiro@ultimalinha.ao);
     - `UL_CLIENT_URL=https://platform.ultimalinha.ao`, `UL_CONSOLE_URL=https://console.ultimalinha.ao`.
   - **Railway `worker`:**
     - as mesmas `UL_*_URL` e `PAYMENT_*` (usadas nos emails de renovação);
     - `SMTP_HOST=mail.ultimalinha.ao`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER`, **`SMTP_PASSWORD`** (segredo);
     - `EMAIL_FROM` (caixa @ultimalinha.ao), `EMAIL_REPLY_TO` (opcional).
   - Sem `SMTP_HOST`, os emails ficam na fila e nada se perde. Configurar mais tarde é seguro.
4. 🔐 **Merge da ul-platform** (`feature/pilot-readiness` → `master`, PR com CI). O Vercel e o Railway fazem o
   deploy automaticamente. Smoke tests:
   - `/v1/health` e `/v1/health/ready` dão 200;
   - `/v1/me` autenticado dá 200;
   - as rotas novas sem sessão dão 401;
   - `GET /v1/catalog/self-service` dá 200.
   - Nos logs do worker: `worker.started`; sem SMTP aparece `email.smtp.unconfigured`, que é esperado.
5. 🔐 **Merge da ul-console** e depois **da ul-client** (a ul-client depende do CORS e das rotas novas da API).
6. 🔐 **Carregar os dados comerciais** (só quando os valores forem aprovados para produção):
   - `npx tsx scripts/load-na-pista-growth.ts` (simulação);
   - depois `--apply --confirm-target=<host>`;
   - os termos ficam em **rascunho** e o plano aparece no catálogo mas **ainda não pode ser contratado**.
7. 🔐 **Aprovação jurídica dos termos**:
   - substituir `docs/commercial/terms/np-tos-001-draft.md` pelo texto aprovado;
   - correr `--apply --approve-terms --approved-by=<id do PLATFORM_ADMIN>`;
   - o script recusa se o texto ainda tiver marcas de rascunho;
   - a partir daqui o plano pode ser contratado.
8. **Na Pista e Na Pista Console**: só depois de existir destino (§6). Ordem: API Na Pista, depois a Console.

## 5. Plano de reversão

| Passo | Como reverter | Dados |
|---|---|---|
| Deploy da API ou do worker | Vercel → *Instant Rollback* para o deployment anterior; Railway → *Redeploy* do deployment anterior; ou `git revert -m 1 <merge>` em `master` | Intactos |
| Deploy da Console ou da Client | Vercel *Instant Rollback* | Intactos |
| Migrações 0022–0028 | **Não reverter o schema.** O código anterior ignora tabelas e colunas novas: são aditivas, e as colunas novas de tabelas existentes têm default ou aceitam null. O trigger de pagamentos alargado (0026) é compatível com o código da 0023 | Intactos |
| Dados aprovados (passo 6) | Enquanto os termos estiverem em rascunho e sem subscrições: `plans.purchase_mode='contractual'` (sai do catálogo) ou `plans.status='ARCHIVED'` | Sem perda |
| Variáveis SMTP | Remover `SMTP_HOST`: os emails voltam a ficar na fila | Sem perda |

**Último recurso, destrutivo e só com autorização explícita:** remover as tabelas novas, na ordem inversa
(0028 → 0022), num script revisto à parte. Não é necessário para reverter a aplicação.

**Critério para reverter:** erro 5xx persistente em `/v1/me` ou `/v1/health/ready`, falha de login,
`activation`/`payments` com 500, ou o worker em crash loop.

## 6. Bloqueios e pendentes antes de clientes reais

1. **A Na Pista não tem destino de produção** (nem a API nem a Console). O piloto vende a Na Pista: sem isto,
   o cliente paga e não tem onde usar. Decisão do dono: onde alojar (Railway ou Vercel), com a base de dados
   Na Pista (`jpwoyo…`) ou uma nova, mais domínio e DNS.
2. **Termos (Anexo A e B)** continuam em rascunho: campos `[…]`, A1 (identificação legal), A11 (dados), A13 e
   B10 (lei, foro), B6 (suporte). Precisam de revisão jurídica, tal como o texto de autorização da renovação
   (`renewalConsentText`, v1).
3. **SMTP das confirmações de conta (Supabase Auth em produção)**: sem SMTP próprio, o Supabase só envia cerca
   de 2 emails por hora. Para clientes reais é preciso configurar a caixa AngoWeb no dashboard do Supabase.
4. **Dados de pagamento** (IBAN, titular, banco, número Multicaixa Express) e **email do financeiro**: o dono
   fornece.
5. Pendentes que já existiam antes:
   - a API ainda aceita HS256 (`SUPABASE_JWT_SECRET`);
   - a rotação de segredos está fora do âmbito;
   - o Railway está no plano trial.

## 7. Verificação feita localmente (16/10/2026)

- **UL Platform**: 450/450, incluindo T11–T13 e os testes de concorrência e falhas do passo 4. Lint limpo.
- **UL Client**: 146/146; **UL Console**: 107/107; **Na Pista Console**: 172/172. Lint e build OK em todos.
- **Na Pista**: unitários 269/269 e integração 247/247, numa base de dados local descartável.
- **E2E no browser com login real**: 138/138, com o percurso completo:
  - convite por email até à aceitação;
  - comprovativo PDF: envio, abertura na Console, rejeição com email e reenvio;
  - renovação: autorização, preparação pelo worker, email com IBAN, comprovativo, confirmação na Console,
    período prolongado uma vez e retirada sem nova renovação;
  - expiração.
- **Autenticação**: 51/51.
- **E2E entre sistemas (UL e Na Pista com credencial gerida)**: 13/13.
  - O `products.max` é aplicado (3 + 1 recusado; arquivar liberta; reativar acima do limite recusado;
    4 em simultâneo todos recusados).
  - Subir e descer o limite no plano é seguido em ≤10 s.
  - Depois da expiração a resposta é 403 `ENTITLEMENT_REQUIRED`; antes da correção `0b4602d` era 503.

## 8. Pedidos de integração (PRs em rascunho) e ordem de merge

Todas as branches estão **0 commits atrás** da branch principal remota e fazem merge sem conflitos
(`git merge-tree`). Nenhuma contém `.env` com valores, segredos ou ficheiros fora do âmbito (verificado no
diff). Os ficheiros não rastreados do dono (`model_comercial_tec/`, `users_test.txt`) não foram enviados.

Ordem de merge (quando autorizado):
1. **ul-platform**: PRs empilhados, a fazer merge por esta ordem:
   - `fix/organization-creation-hardening` → master (0022);
   - `feature/commercial-payments-self-service` (0023/0024, limites de membros, métodos de pagamento);
   - `feature/team-invitations` (0025);
   - `feature/pilot-readiness` (0026–0028, consentimento, script, documentos).
   - **As migrações 0022–0028 são aplicadas em produção antes do merge do primeiro**, porque o Vercel e o
     Railway fazem deploy automático de `master`.
2. **ul-console**: `feature/manual-payment-confirmation` (precisa das rotas 0023–0027).
3. **ul-client**: #1 (2B) → #2 (2C, onboarding) → `feature/pilot-commercial-ui` (catálogo, pagamento,
   renovação, convites, "Abrir Na Pista"). Precisa do CORS e das rotas da API.
4. **na-pista**: `feature/plan-limits-products` (limite de produtos, 403 depois da expiração, proposta de
   alojamento). Só tem efeito quando houver alojamento.
5. **na-pista-console**: `feature/team-invitations`.

## 9. Matriz de testes — pagamentos, renovação, expiração e revogação

| Cenário | Onde | Resultado |
|---|---|---|
| Valor ou moeda errados (T06) | UT commercial-payments; E2E A10 | 409, nada gravado |
| Sem permissão (T07); PLATFORM_FINANCE só com as 3 permissões | UT | 403, nada gravado |
| Mesma chave → replay; a mesma chave com outro corpo dá 409; referência reutilizada dá 409 (T09/T17) | UT; E2E A10 | sem duplicação |
| Confirmações concorrentes (4 manuais e 3 ativações) (T10) | UT | 1 pagamento, 1 grant |
| Manual e integração em simultâneo no mesmo contrato | UT renewals-proofs | 1 pagamento |
| O mesmo pedido 5× em paralelo (mesma chave) | UT | 1 pagamento, replay limpo |
| A mesma referência em 2 contratos ao mesmo tempo | UT | 1 aceite |
| Organização suspensa: pagamento gravado, ativação bloqueada, depois ativada (T02) | UT; E2E N8 | ✓ |
| Comprovativo: só PDF real, 4 MB, OWNER da organização, mesmo ficheiro = 1, máx. 5; rejeição com email; aceitação na confirmação; rollback se o comprovativo não pertencer | UT; E2E P1–P6, R3–R4 | ✓ |
| T11: renovação autorizada fica a aguardar pagamento e não prolonga | UT; E2E R2 | ✓ |
| T12: renovação paga prolonga **uma vez** (contrato, grant, subscrição); replay e segunda confirmação recusados; por integração | UT; E2E R4 | ✓ |
| T13: retirada antes → sem renovação; depois da preparação → cancelada e não pagável | UT; E2E R5 | ✓ |
| Caducidade: sem pagamento no fim → `lapsed`, acesso termina | UT | ✓ |
| T14 expiração: worker persiste; acesso e subscrição revogados; a Na Pista recusa com 403 | UT; E2E SS8; LIM E1 | ✓ |
| Terminação pela UL revoga o acesso (T1) | E2E T1 | ✓ |
| Emails: na fila só se a transação confirmar; dedupe; tentativas e `failed`; workers concorrentes sem envio duplo | UT email-outbox | ✓ |

## 10. O que ainda precisa de validação em staging

Não existe hoje um ambiente de staging da UL Platform nem da Na Pista. Antes de clientes reais, validar num
ambiente igual ao de produção (BD de staging, mesmos poolers, mesmos hosts):

1. **Migrações 0022–0028 numa cópia** da BD de produção (restauro ou branch Supabase): tempo, bloqueios,
   avisos de truncagem de nomes.
2. **Pooler em modo transação (Vercel, `prepare:false`)** com o código novo: `FOR UPDATE SKIP LOCKED`,
   locks consultivos por transação (limites de membros e produtos), transações longas da ativação e da
   renovação.
3. **Envio do PDF pela função Vercel**: corpo até 4 MB, abaixo do limite de cerca de 4,5 MB; content-type
   `application/pdf` com o CORS real; `Content-Disposition` exposto à Console.
4. **SMTP AngoWeb a partir da Railway** (porta 465): entrega, SPF/DKIM alinhados, não ir para spam.
5. **Worker na Railway com Node 24 (Railpack)**: varreduras de expiração, renovação (1 h) e email (15 s)
   em simultâneo, e encerramento gracioso.
6. **Supabase Auth em produção** com SMTP próprio: registo e confirmação de um cliente real.
7. **Ciclo completo com a Na Pista alojada**: ativação → credencial gerida entregue pelo worker da Na
   Pista → "Abrir Na Pista" → produtos e limites → expiração.
8. **Previews Vercel** (`ul-client` usa valores públicos de produção no Preview): confirmar a proteção de
   deployment dos previews.

## 11. Registo de execução (16/10/2026, autorização do dono)

| Passo | Estado | Evidência |
|---|---|---|
| Backup da produção (schemas `public` e `drizzle`) | ✅ | `~/.ul-secrets/backups/ul-prod-2026-10-16-pre-0022.dump` (420 KB, 50 tabelas), fora dos repositórios |
| Ensaio das migrações numa cópia local do backup (substitui o staging, que não foi possível criar sem acesso válido ao Supabase) | ✅ | Pendentes = 0022–0028 exatamente; 190 ms; só inserções de catálogo esperadas; 8 tabelas novas com RLS; reaplicar não faz nada |
| **Migrações 0022–0028 em produção** | ✅ | Mesmo resultado do ensaio; 30 migrações registadas; 8/8 RLS; 0 permissões para anon/authenticated; `/v1/health` e `/ready` 200 |
| Variáveis Vercel `ul-platform` (Production): `PAYMENT_ACCOUNT_HOLDER`, `PAYMENT_IBAN`, `PAYMENT_MCX_EXPRESS_NUMBER`, `PAYMENTS_NOTIFY_EMAIL`, `UL_CLIENT_URL`, `UL_CONSOLE_URL` | ✅ | `vercel env ls` |
| CORS: acrescentar `https://napista.ultimalinha.ao` a `PLATFORM_ALLOWED_ORIGINS` | ⛔ bloqueado pelo controlo de segurança do agente | o dono altera na Vercel ou autoriza |
| Merge ul_platform #9 → master (deploy automático) | ⛔ bloqueado pelo controlo de segurança do agente ("merge sem revisão") | PR #9 pronto, base `master`, CI 451/451 |
| **Catálogo em produção** (termos `np-tos-001` em **rascunho**, plano `NA_PISTA_GROWTH`, entitlements, preço 25 000 Kz / 30 d) | ✅ | Script com confirmação de destino; reexecução sem alterações; **não pode ser contratado** até os termos serem aprovados |
| Na Pista: projetos Vercel `na-pista` (API) e `na-pista-console` (Next.js) ligados ao GitHub; domínios `api-napista.ultimalinha.ao` e `napista.ultimalinha.ao`; variáveis não secretas e chave de encriptação nova | ✅ | DNS por fazer (AngoWeb: `A … 76.76.21.21`) |
| Na Pista: BD de produção (backup, migração 0011, `NA_PISTA_DATABASE_URL`) | ⛔ | O URL da BD `jpwoyo…` não está disponível localmente (o `.env` aponta para uma BD local) |
