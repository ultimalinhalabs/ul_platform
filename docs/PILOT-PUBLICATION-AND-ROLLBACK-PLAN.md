# Plano de publicação e reversão — piloto Na Pista Crescimento

> Preparado a 16/10/2026 (passo 5). **Nada foi publicado.** Cada passo marcado com 🔐 precisa de autorização
> explícita do dono no momento, conforme o §15 do CLAUDE.md. Estado da produção verificado só em leitura
> (`BEGIN READ ONLY`, apenas contagens).

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
6. 🔐 **Carregar os dados aprovados**:
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
