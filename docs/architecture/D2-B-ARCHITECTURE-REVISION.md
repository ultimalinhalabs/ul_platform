# D2-B Architecture Revision

**Na Pista — Secure Platform Credential Provisioning (UL Platform → Na Pista)**

## 1. Status

| Campo | Valor |
|---|---|
| Tipo | Revisão arquitetural (sem implementação) |
| Data | 2026-10-07 |
| Base | D2-B Architecture Audit (Block 2B Phase 2.3) — recomendação: Opção B |
| Código auditado | `ul-platform` 0790030 · `na-pista` 8b50f9e (`phase-6/ul-status-compat`) · `na-pista-console` 077a5f6 · `ul-client` 294b422 |
| Estado | **ARQUITETURA FECHADA** para as decisões D2B-01…D2B-15 (§18). Políticas operacionais em aberto listadas em §19 como **POLICY DECISION PENDING**. |
| Alterações feitas por este documento | Nenhuma. Nenhum código, schema, migration, branch, ambiente, segredo, chave ou dado de produção foi criado ou alterado. |

Localização: este ficheiro está em `projeto_ul/docs/architecture/` (pasta de staging, não é repositório). O
seu destino definitivo (proposto: `ul-platform/docs/architecture/`, já que a UL Platform é a autoridade do
provisioning) depende de autorização de commit.

## 2. Scope

**Dentro:** a credencial *platform-facing* que a Na Pista usa para chamar a UL Platform em nome de uma
organização (hoje: API key de organização `ulk_…` da aplicação `NA_PISTA`, scopes `usage.write`,
`event.publish`), desde o pedido até à revogação; a chave de plataforma usada pelo reconciliador da Na Pista;
a autorização em runtime dessas credenciais; os contratos de integração UL ↔ Na Pista necessários.

**Fora:** ver §20 (OUT OF SCOPE). Em particular: QD, credenciais assimétricas, deploy da Na Pista, UL Console.

Princípios fixos (não reinterpretar):

- **P1** — A UL Platform é a autoridade comercial e a única emissora de credenciais.
- **P2** — A Na Pista é a única detentora do segredo e guarda-o via F29A.
- **P3** — O segredo de uma credencial gerida nunca passa por browser, pessoa, ficheiro, URL, log ou chat.
- **P4** — Existência de uma credencial ≠ autorização dessa credencial. A autorização é avaliada em cada
  pedido, contra o estado comercial *efetivo* nesse instante. Nenhuma garantia de segurança depende de um
  worker ou de um job.
- **P5** — Feature flags não substituem autorização. Uma flag pode desligar uma funcionalidade nova;
  nunca pode relaxar uma verificação de autorização em produção.
- **P6** — Ausência de dados não é uma barreira de segurança: tabelas vazias hoje não justificam
  verificações ausentes.

## 3. Current Architecture Baseline

Factos verificados no código (referências entre parênteses).

### 3.1 UL Platform

| # | Facto | Referência |
|---|---|---|
| B1 | API keys `ulk_<id>.<secret>`, 256 bits, só SHA-256 persistido, segredo mostrado uma vez. | `modules/apiKeys/crypto.ts` |
| B2 | Chave de organização criada pelo OWNER (`api_key.manage`). G6: exige acesso efetivo à aplicação **na criação**. | `apiKeys/service.ts:67-86` |
| B3 | `verifyApiKeyToken` verifica hash, `ACTIVE`, `expiresAt`, aplicação `ACTIVE`; `authenticate` verifica organização ativa. **Não verifica acesso à aplicação nem grant em runtime.** | `apiKeys/service.ts:349-382`, `middleware/authenticate.ts:30-33` |
| B4 | Chaves de plataforma (`organization_id NULL`) existem e são criáveis por PLATFORM_ADMIN (`platform.credential.manage`). O comentário em `schema/apiKeys.ts:16-22` que diz o contrário está desatualizado. | `routes/v1/apiKeys.ts:99-133` |
| B5 | Rotas org-scoped de serviço exigem `req.service.organizationId === :organizationId` (e aplicação). Uma chave de plataforma não as pode usar. | `middleware/entitlementAccess.ts`, `requireServiceOrganizationMatch.ts` |
| B6 | Não há distinção estrutural entre tipos de API key (apenas `organization_id` nulo/não nulo). | `schema/apiKeys.ts` |
| B7 | Acesso efetivo = linha `organization_application_access` ativa, aplicação ativa, e **não** suportada por um grant ativo cujo `ends_at` já passou. Avaliado em leitura. | `entitlements/effectiveness.ts` |
| B8 | **Não existe job** que expire grants, subscriptions ou contratos. `contracts.status` continua `active` depois de `ends_at`. | `effectiveness.ts` (comentário), `activation.service.ts` |
| B9 | `terminateContract` / `cancelContract` / `revokeGrant` revogam grants, cancelam subscriptions e revogam o acesso na mesma transação. **Não tocam em API keys.** | `activation.service.ts:280-365` |
| B10 | PLATFORM_ADMIN pode conceder acesso manualmente, sem contrato. | `routes/v1/platform.ts:68` |
| B11 | `recordAuditEvent` engole erros de escrita. | `audit/service.ts:27-31` |
| B12 | Webhooks HMAC + worker de retries existem, mas não emitem eventos de acesso/contrato para produtos. | `modules/webhooks/*`, `worker.ts` |

### 3.2 Na Pista (F29A)

| # | Facto | Referência |
|---|---|---|
| N1 | Tabela `organization_platform_credentials`: envelope `v1:` AES-256-GCM, AAD = organização, máx. 1 `ACTIVE` por organização (índice parcial), `platform_api_key_id` UNIQUE, `REVOKED` nunca reativada. | `db/schema/platformCredentials.ts` |
| N2 | `provisionPlatformCredential`: introspeção na UL (`/service/me`), cifra antes da transação, idempotente (`UNCHANGED` / `CONFLICT` / `ROTATED` com `replaceActive`), auditoria na mesma transação. | `modules/platformCredentials/service.ts` |
| N3 | Resolver: falha fechada (503 genérico), cache de 10 s da **linha cifrada**, nunca do texto em claro. | `platformCredentials/resolver.ts` |
| N4 | Sem endpoint HTTP de provisioning, sem receptor de webhooks, sem worker. Único caminho: script `credentials:provision` (alvos loopback) a partir de uma fixture em texto claro. | `scripts/provision-platform-credentials.ts` |
| N5 | Autenticação de entrada aceita qualquer `ulk_` via introspeção na UL. | `middleware/authenticate.ts` |
| N6 | `NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS` tem default `"false"` e controla a verificação de acesso no caminho humano. | `config/env.ts:38`, `tenancy/tenantContext.ts` |
| N7 | Caches de autorização: entitlements 10 s, identidade 15 s, linha de credencial 10 s. | `platform/*.ts`, `resolver.ts` |

### 3.3 Fluxo atual (resumo)

OWNER cria a chave no browser (Na Pista Console ou UL Client) → copia o segredo → fixture em disco →
script → Na Pista. Em produção **não existe caminho**. Revogação e rotação são manuais e separadas nos dois
sistemas. Uma chave criada durante um contrato **continua a autenticar** depois do fim do contrato (B3 + B9).

## 4. Revised Architecture

Opção B mantida: **pull servidor-a-servidor iniciado pela Na Pista, autorizado pela UL**, com quatro
alterações estruturais em relação à auditoria:

1. O **Provisioning Request** persistido na UL é a autoridade contextual da emissão (§5). O endpoint de emissão
   não recebe `organizationId` nem `applicationId`.
2. A **Managed Credential** é uma classe estrutural própria de credencial, ligada a
   `Organization × Application × Integration Purpose` (§6).
3. A credencial emitida nasce **PENDING**: só serve para introspeção e confirmação de posse. Só se torna
   utilizável depois de a Na Pista confirmar que a guardou (§9).
4. A autorização de runtime de **toda** credencial org-scoped passa a incluir o acesso efetivo; a credencial
   gerida inclui também o grant contratual efetivo (§11).

```
Contrato ativado (UL) ─ mesma transação ─► Provisioning Request: REQUESTED
                                                     │
Na Pista reconciler (chave de plataforma, classe PROVISIONER)
   1. GET  pedidos abertos da SUA aplicação/finalidade
   2. POST issue(pedido, emissões_esperadas)
        UL: bloqueia o pedido; reavalia autorização comercial atual; emite credencial PENDING;
            guarda o hash; pedido → ISSUED; devolve o segredo UMA vez (corpo HTTPS)
   3. F29A: introspeção (/service/me) → cifra (AAD=org) → guarda localmente como PENDING (durável)
   4. POST confirm(pedido) autenticado COM A CREDENCIAL PENDING
        UL: prova de posse; reavalia autorização; credencial → ACTIVE; pedido → ACTIVE
   5. F29A: local PENDING → ACTIVE
Runtime: cada pedido da Na Pista à UL ─► autenticação + autorização comercial efetiva (P4)
```

## 5. Provisioning Request Model

### 5.1 Identidade

Um Provisioning Request (PR) identifica inequivocamente:

| Elemento | Origem | Mutável |
|---|---|---|
| Organization | Fixada na criação | Não |
| Application | Fixada na criação (primeiro consumidor: `NA_PISTA`) | Não |
| Integration Purpose | Fixado na criação (`platform_integration` — a credencial que o produto usa para chamar a UL pela organização) | Não |
| Kind | `initial` · `rotation` · `rekey` | Não |
| Predecessor | PR `ACTIVE` substituído (só `rotation` / `rekey`) | Não |
| Originating authority | Contrato + grant que justificaram a criação (registo para auditoria) | Não |
| Requested by | Ator (`system:contract_activation`, `user:<id>`, `platform_admin:<id>`, `service:<apiKeyId>`) | Não |
| Issue count | Número de credenciais emitidas para este PR | Só pela UL, monotónico |
| Current credential | Credencial emitida mais recente | Só pela UL |

### 5.2 Autoridade

- O PR é a **única** coisa que torna uma emissão possível. Uma chave de plataforma válida, sozinha, não
  autoriza nada (§7).
- A autorização é **reavaliada em cada transição** (criação, emissão, confirmação) contra o estado comercial
  **atual e efetivo**, não contra o estado registado na criação. O grant de origem é guardado para
  auditoria; uma renovação (novo grant efetivo para a mesma organização × aplicação) continua a autorizar.

### 5.3 Quem pode criar um PR

| Ator | Pode criar | Kinds | Condições adicionais |
|---|---|---|---|
| Ativação de contrato (sistema) | Sim | `initial` | Na mesma transação de `activateContract`, por cada grant ativado para uma aplicação que exige integração; só se não existir PR aberto nem `ACTIVE` para a mesma relação |
| OWNER | Sim | `initial` (reativar após desativação ou cancelamento), `rotation` | Membership ativa com permissão de gestão de integração (só OWNER) |
| PLATFORM_ADMIN | Sim | `initial`, `rotation`, `rekey` | Permissão de gestão de credenciais de plataforma; usado para recuperação |
| Reconciliador da aplicação | Sim, limitado | `rekey` (e `rotation` quando a política o determinar) | Só sobre um PR `ACTIVE` da sua própria aplicação e finalidade; nunca `initial` |
| ADMIN, MANAGER, STAFF, chaves de organização, credenciais geridas | Não | — | — |

### 5.4 Pré-condição mínima (avaliada em toda transição)

`AUTHZ(org, app, purpose)` é verdadeira se e só se todas as condições abaixo são verdadeiras **no instante da
transação**:

1. Organização `active`.
2. Aplicação `ACTIVE` e exige integração com esta finalidade.
3. Acesso efetivo da organização à aplicação (B7).
4. Existe um grant contratual efetivo (`active` e `ends_at` no futuro ou nulo) para a organização × aplicação
   que suporta esse acesso. O acesso manual sem contrato (B10) **não** satisfaz esta condição — ver §19
   (PDP-05).

Condições estruturais adicionais por operação:

- Criar `initial`: não existe PR aberto (`REQUESTED` / `ISSUED`) nem `ACTIVE` para a relação.
- Criar `rotation` / `rekey`: existe exatamente um PR `ACTIVE` (o predecessor) e nenhum PR aberto.
- Emitir: PR aberto, mais a contagem de emissões esperada (§9).
- Confirmar: PR `ISSUED`, credencial apresentada é a credencial atual do PR e está `PENDING`.

### 5.5 Estados do PR

| Estado | Significado | Aberto? |
|---|---|---|
| `REQUESTED` | Pedido válido, nenhuma credencial emitida ainda | Sim |
| `ISSUED` | Uma credencial `PENDING` existe para o PR; posse ainda não provada | Sim |
| `ACTIVE` | Posse provada; a credencial atual do PR está `ACTIVE` | Não (estável) |
| `SUPERSEDED` | Era `ACTIVE`; foi substituído por um PR `rotation` / `rekey` que ficou `ACTIVE` | Terminal |
| `CANCELLED` | Terminou antes de ficar `ACTIVE` (autorização perdida, cancelado por ator, expirado) | Terminal |
| `REVOKED` | Era `ACTIVE` e a integração foi desligada (desativação, terminação, comprometimento) | Terminal |

### 5.6 Invariantes

- **I1** — No máximo um PR aberto por (organização, aplicação, finalidade).
- **I2** — No máximo um PR `ACTIVE` por (organização, aplicação, finalidade).
- **I3** — Organização, aplicação, finalidade, kind e predecessor são imutáveis.
- **I4** — Estados terminais nunca saem de terminal.
- **I5** — Um PR nunca devolve um segredo a um ator humano nem a uma rota humana.
- **I6** — A contagem de emissões só aumenta.

I1 e I2 devem ser garantidas pela base de dados (unicidade), não só pelo código.

### 5.7 Comportamento perante eventos comerciais

| Evento | PR aberto | PR `ACTIVE` |
|---|---|---|
| Terminação de contrato | → `CANCELLED` na mesma transação da terminação (best effort); se não, recusado na próxima transição | → `REVOKED` na mesma transação; a credencial é imediatamente inutilizável pela regra de runtime (§11), independentemente disto |
| Revogação de acesso à aplicação | Igual | Igual |
| Fim temporal do grant/subscription (sem job, B8) | Recusado na próxima emissão ou confirmação → `CANCELLED` | Continua `ACTIVE` armazenado, mas a credencial é **não autorizada** em runtime; o housekeeping (quando existir) marca `REVOKED` — não é necessário para a segurança |
| Suspensão da organização | Recusado enquanto suspensa (fica aberto) | Mantém-se; não autorizada enquanto suspensa; volta a funcionar após reativação (suspensão é reversível) |
| PR obsoleto (stale) | `REQUESTED` sem progresso: inofensivo (sem segredo); `ISSUED` sem confirmação: a credencial `PENDING` expira pela janela de confirmação e deixa de servir mesmo para confirmar (§9). O limiar é PDP-03 | — |

## 6. Managed Credential Model

### 6.1 Classe de credencial

Toda API key passa a ter uma **classe** estrutural e imutável (não convenção de nome, não scope, não
comentário):

| Classe | Organização | Criada por | Finalidade |
|---|---|---|---|
| `ORGANIZATION` | Obrigatória | OWNER (fluxo atual) | Integrações do próprio cliente |
| `INTEGRATION_MANAGED` | Obrigatória | Só a UL, ao emitir um PR | `Organization × Application × Integration Purpose`, ligada ao PR |
| `PLATFORM_SERVICE` | Nula | PLATFORM_ADMIN | Identidade de serviço de um produto; inclui a sub-finalidade `PROVISIONER` (§7) |

Todas as chaves existentes hoje são `ORGANIZATION` (com organização) ou `PLATFORM_SERVICE` (sem
organização). A classificação é inequívoca a partir de `organization_id`, por isso a introdução da classe é
retrocompatível.

### 6.2 Regras de uma `INTEGRATION_MANAGED`

| Pergunta | Regra |
|---|---|
| Quem pode criar? | Só a UL, na operação `issue` de um PR. A rota genérica de criação de API keys nunca cria nem aceita esta classe. |
| Quem pode revogar? | Sistema (terminação, revogação de acesso, rotação, substituição de PENDING), PLATFORM_ADMIN (incluindo comprometimento), OWNER **apenas** através de "Desativar integração" (o PR passa a `REVOKED`). A rota genérica de revogação de API keys recusa (409). |
| Quem pode rodar? | Através de um PR `rotation` / `rekey` (§5.3). Nunca editando a credencial. |
| Quem pode ver? | Ninguém vê o segredo. Metadados (estado, datas, finalidade; nunca o segredo nem dados internos de cifra) visíveis ao OWNER/ADMIN na vista de integração e ao PLATFORM_ADMIN na vista de plataforma. |
| Aparece na lista normal de API keys? | Não (vista de integração própria). Ver PDP-07 sobre uma linha só de leitura. |
| Pode ser usada como credencial de integração do cliente? | Não. A Na Pista recusa credenciais `INTEGRATION_MANAGED` na autenticação de entrada; os seus scopes também não incluem operações de catálogo. |
| Pode ser reutilizada para outra aplicação ou organização? | Não. Organização, aplicação, finalidade e PR são imutáveis (garantido pela base de dados). |
| Pode ser recuperada ou exportada? | Não. A UL tem só o hash; a Na Pista só a decifra para uso imediato. |
| Scopes | Conjunto fixo por (aplicação, finalidade), definido pela UL; o pedido não os escolhe. Para `NA_PISTA` / `platform_integration`: o necessário para entitlements, usage e eventos (hoje `usage.write`, `event.publish`, mais a leitura de entitlements que já é concedida pela correspondência org/app). |

### 6.3 Estados da Managed Credential

| Estado | Significado | Pode autenticar em |
|---|---|---|
| `PENDING` | Emitida, posse ainda não provada; dentro da janela de confirmação | **Só** `/service/me` (introspeção F29A) e `confirm` do seu PR |
| `ACTIVE` | Posse provada | Rotas da aplicação, **sujeito a** `RUNTIME_AUTHZ` (§11) |
| `REVOKED` | Terminal, com motivo: `superseded_unconfirmed`, `rotated`, `integration_disabled`, `access_revoked`, `contract_terminated`, `admin_revoked`, `compromised`, `request_cancelled` | Nada |

A expiração (`expires_at`) é derivada em verificação, tal como hoje (B3): não é um estado persistido.

## 7. Platform Provisioning Authorization

### 7.1 A chave de provisioning

| Propriedade | Definição |
|---|---|
| Classe | `PLATFORM_SERVICE`, sub-finalidade `PROVISIONER`, organização nula, uma aplicação (`NA_PISTA`) |
| Scopes mínimos | Só `credential.provision` (novo): listar PRs abertos e emitir. Sem usage, eventos, catálogo ou entitlements. |
| Não pode | Chamar rotas org-scoped (B5); confirmar (a confirmação exige a credencial `PENDING`); criar PRs `initial`; ler segredos; revogar credenciais; ver PRs de outra aplicação ou finalidade |
| Pode | Listar PRs abertos **da sua aplicação e finalidade** (derivadas da própria chave, nunca de parâmetros); emitir para um PR aberto; criar `rekey` sobre um PR `ACTIVE` da sua aplicação (§5.3) |
| Criação | PLATFORM_ADMIN, operação auditada; uma por ambiente da Na Pista |
| Armazenamento | Segredo de deployment da Na Pista (gestor de segredos do host). Nunca em repositório, ficheiro de trabalho, log ou chat. |
| Exceção a P3 | É o **único** segredo que passa por um operador, uma vez por ambiente (bootstrap). Explicitamente aceite e auditado; a eliminação desta exceção é a evolução para credenciais assimétricas (fora do âmbito). |
| Lifetime | Sem TTL inventado (PDP-01). A arquitetura exige rotação sem interrupção: podem coexistir duas chaves de provisioning ativas para a mesma aplicação durante uma troca (criar nova → deploy → revogar antiga). |
| Revogação | Imediata (verificação por pedido). Corta novas emissões. Não afeta credenciais já `ACTIVE` (ver T3 e PDP-06). |
| Utilização | Exclusivamente servidor-a-servidor. Rotas de provisioning recusam autenticação humana (JWT). |

### 7.2 Regra de autorização da emissão

```
issue(pr, expected_issue_count) é PERMITIDO  ⇔
      chamador autenticado com uma chave PLATFORM_SERVICE/PROVISIONER ativa e não expirada
  ∧   a chave tem o scope credential.provision
  ∧   aplicação(chave) = aplicação(pr)  ∧  finalidade(chave) = finalidade(pr)
  ∧   pr está aberto (REQUESTED | ISSUED)
  ∧   pr.issue_count = expected_issue_count
  ∧   AUTHZ(org(pr), app(pr), finalidade(pr))   — avaliada agora, na mesma transação, com o pr bloqueado
caso contrário → DENY (sem emissão; recusa auditada)
```

O pedido HTTP identifica o PR (referência), nunca a organização ou a aplicação. Um id de PR sozinho não
autoriza nada (T11).

## 8. State Machines

### 8.1 A — Provisioning Request

```
                 create (ator §5.3, AUTHZ)
                          │
                          ▼
   ┌────────────► REQUESTED ──issue (provisioner, AUTHZ, count)──► ISSUED ◄─┐
   │                  │                                              │  │   │ issue (count atual):
   │                  │ cancel / AUTHZ perdida                       │  │   │ credencial PENDING anterior
   │                  ▼                                              │  └───┘ → REVOKED(superseded_unconfirmed)
   │              CANCELLED ◄──── cancel / AUTHZ perdida / janela ───┘
   │                                                                 │ confirm (credencial PENDING atual, AUTHZ)
   │                                                                 ▼
   │                                  rotation/rekey ativo        ACTIVE
   │                         SUPERSEDED ◄────────────────────────── │
   │                                                                 │ desativar / terminação / revogação de acesso / comprometimento
   │                                                                 ▼
   └──── (novo PR initial, nunca reabrir) ◄──────────────────────── REVOKED
```

| Estado atual | Ação | Próximo | Autorização exigida | Efeitos colaterais |
|---|---|---|---|---|
| — | create `initial` | `REQUESTED` | Ator §5.3 + `AUTHZ` + I1/I2 | Auditoria `requested` |
| `ACTIVE` (predecessor) | create `rotation` / `rekey` | novo PR `REQUESTED` | Ator §5.3 + `AUTHZ` + nenhum PR aberto | Auditoria `requested` (kind, predecessor) |
| `REQUESTED` | issue | `ISSUED` | §7.2 | Credencial `PENDING` criada (hash); contagem +1; segredo devolvido uma vez; auditoria `issued` |
| `ISSUED` | issue (contagem = atual) | `ISSUED` | §7.2 | Credencial `PENDING` anterior → `REVOKED(superseded_unconfirmed)`; nova `PENDING`; contagem +1; auditoria `superseded` + `issued` |
| `ISSUED` | issue (contagem ≠ atual) | `ISSUED` (inalterado) | — | Nenhuma emissão; 409 com o estado atual; log operacional |
| `ISSUED` | confirm | `ACTIVE` | Credencial apresentada = atual do PR, `PENDING`, dentro da janela + `AUTHZ` | Credencial → `ACTIVE`; se `rotation`/`rekey`: predecessor → `SUPERSEDED` e a sua credencial → retirada (§10); auditoria `confirmed` |
| `ACTIVE` | confirm (repetido, mesma credencial) | `ACTIVE` | Credencial = atual do PR, `ACTIVE` | Nenhum (idempotente) |
| `REQUESTED` / `ISSUED` | `AUTHZ` falha em qualquer transição | `CANCELLED` | — (sistema) | Credencial `PENDING` → `REVOKED(request_cancelled)`; auditoria `refused` |
| `REQUESTED` / `ISSUED` | cancelar (OWNER / PLATFORM_ADMIN) | `CANCELLED` | Ator §5.3 | Igual |
| `ACTIVE` | desativar integração (OWNER), revogar (PLATFORM_ADMIN), terminação, revogação de acesso | `REVOKED` | Ator ou evento comercial | Credencial → `REVOKED(motivo)`; auditoria `revoked` |
| `ACTIVE` | marcar comprometida (PLATFORM_ADMIN) | `REVOKED` + novo PR `rekey` | PLATFORM_ADMIN | Credencial → `REVOKED(compromised)`; auditoria |
| `ACTIVE` | sucessor fica `ACTIVE` | `SUPERSEDED` | (efeito do confirm do sucessor) | — |
| Terminal | qualquer | Inválido | — | 409 |

Transições inválidas (exemplos): `REQUESTED → ACTIVE` (sem posse), `CANCELLED/REVOKED/SUPERSEDED → *`,
`ACTIVE → ISSUED`, emissão com contagem desatualizada, confirmação com uma credencial que não é a atual.

### 8.2 B — Managed Credential

| Estado atual | Ação | Próximo | Autorização exigida | Efeitos colaterais |
|---|---|---|---|---|
| — | issue do PR | `PENDING` | §7.2 | Hash persistido; segredo devolvido uma vez |
| `PENDING` | confirm | `ACTIVE` | Autenticada com o próprio segredo + PR `ISSUED` com esta credencial atual + janela + `AUTHZ` | PR → `ACTIVE` |
| `PENDING` | nova emissão no PR | `REVOKED(superseded_unconfirmed)` | (efeito do issue) | — |
| `PENDING` | janela de confirmação esgotada | (inalterado no armazenamento) | — | Deixa de autenticar mesmo para confirmar (avaliado em verificação, sem worker) |
| `PENDING` | PR cancelado | `REVOKED(request_cancelled)` | (efeito) | — |
| `ACTIVE` | rotação concluída | retirada → `REVOKED(rotated)` | §10 | — |
| `ACTIVE` | desativação, terminação, revogação de acesso, revogação admin, comprometimento | `REVOKED(motivo)` | Ator ou evento | — |
| `REVOKED` | qualquer | Inválido | — | Nunca reativada |

## 9. Retry and Delivery Semantics

### 9.1 Separação de conceitos

| Conceito | Mecanismo | O que garante | O que **não** garante |
|---|---|---|---|
| Idempotência da emissão | PR bloqueado + `expected_issue_count` (concorrência otimista) | No máximo uma emissão por contagem; duplicados e concorrentes não emitem | Que o segredo chegou ao destino |
| Entrega da resposta | HTTPS, corpo da resposta, uma vez | Confidencialidade em trânsito | Que a Na Pista a recebeu (a UL não consegue observar a entrega) |
| Persistência da credencial | F29A: commit local `PENDING` antes de confirmar | Se a Na Pista confirma, guardou | — |
| Confirmação de posse | `confirm` autenticado com o próprio segredo | A UL sabe que o detentor do segredo o confirmou; só então `ACTIVE` | — |
| Recuperação após timeout | Releitura do estado do PR + estado local F29A | Decisão determinística: confirmar o que existe ou reemitir | — |
| Reconciliação | Ciclo periódico da Na Pista | Convergência de estados divergentes | Segurança (nunca depende dela, P4) |

Uma Idempotency-Key, sozinha, **não** resolve o problema: a UL não pode reenviar o segredo (só tem o hash),
por isso uma repetição da mesma operação não pode devolver a mesma resposta. A garantia vem da combinação
"credencial PENDING inutilizável + prova de posse + substituição explícita".

### 9.2 Escolha do modelo de estados

- **`DELIVERED` rejeitado**: a UL não consegue observar a entrega. Um estado que o sistema não consegue
  verificar seria uma afirmação falsa.
- **`CONFIRMED` e `ACTIVE` fundidos**: a confirmação de posse é o próprio ato de ativação. Não existe um
  segundo passo com significado de autorização diferente entre os dois.
- **Modelo mínimo escolhido**: PR `REQUESTED → ISSUED → ACTIVE`; credencial `PENDING → ACTIVE`.
  `PENDING` é necessário porque tem uma semântica de segurança distinta: emitida mas não utilizável.

### 9.3 Regra da Na Pista (reconciliador)

Para cada PR aberto da sua aplicação, por esta ordem:

1. Exclusão mútua local por PR (uma única execução por PR em todos os processos).
2. Ler o estado local F29A para (organização, PR).
3. Existe uma credencial local `PENDING` deste PR → **confirmar** com ela (nunca reemitir).
4. Existe uma credencial local `ACTIVE` deste PR, mas a UL ainda indica `ISSUED` → confirmar (idempotente).
5. Não existe nada local → **emitir** com `expected_issue_count` = a contagem lida na UL.
6. Depois de receber o segredo: introspeção → cifra → commit local `PENDING` → só depois confirmar.

### 9.4 Cenários

| Cenário | Estado do PR | Estado da credencial | Nova emissão? | Revogar a anterior? | A Na Pista pode usá-la? | Recuperação | Contra duas `ACTIVE` | Idempotência |
|---|---|---|---|---|---|---|---|---|
| **A** emite → chega → guarda → confirma | `ACTIVE` | `ACTIVE` | Não | — | Sim, depois de local `ACTIVE` | — | Só uma emitida | — |
| **B** emite → chega → **não** guarda → retry | `ISSUED` → `ISSUED` | K1 `PENDING` → `REVOKED(superseded_unconfirmed)`; K2 `PENDING` | Sim, com a contagem atual | Sim, na mesma transação | Não usava K1 (perdida); usa K2 após confirmar | Passo 5 | K1 nunca foi `ACTIVE` | A contagem impede duplicados |
| **C** emite → guarda → resposta perdida (a UL não sabe) → retry | `ISSUED` | K1 `PENDING` (local `PENDING`) | **Não** | Não | Sim, depois de confirmar | Passo 3: confirma K1 | — | Estado local decide; nenhuma emissão |
| **D** timeout antes da resposta | `REQUESTED` ou `ISSUED` (desconhecido para a Na Pista) | Talvez K1 `PENDING` não entregue | Sim, depois de reler a contagem | Se K1 existe: sim (substituição) | Usa K2 após confirmar | Reler o PR; passo 5 com a contagem lida | K1 nunca `ACTIVE` | A contagem lida torna a reemissão determinística |
| **E** dois issue concorrentes | `ISSUED` | Uma `PENDING` | Só o primeiro | — | — | O segundo recebe 409 + estado e segue a regra §9.3 | Bloqueio do PR + contagem | Concorrência otimista |
| **F** recebe, falha antes de confirmar | `ISSUED` | K1 `PENDING` | Se guardou: não. Se não guardou: sim | Só no caso "não guardou" | Após confirmar | Passo 3 ou 5 | — | — |
| **G** confirm processado, resposta perdida | `ACTIVE` | K1 `ACTIVE` | Não | Não | Sim | Passo 4: reconfirma (idempotente, 200); depois local `ACTIVE` | — | Confirm idempotente por estado |
| **H** terminação durante o provisioning | `CANCELLED` (aberto) ou `REVOKED` (`ACTIVE`) | `PENDING`/`ACTIVE` → `REVOKED(contract_terminated)` | Não | Sim | Não: a UL recusa no pedido seguinte (§11), independentemente da revogação física | Na Pista vê recusa ou 401 → marca local `REVOKED` | — | Bloqueio partilhado PR ↔ terminação serializa (§9.5) |
| **I** acesso revogado durante o provisioning | Igual a H | `REVOKED(access_revoked)` | Não | Sim | Não | Igual a H | — | Igual |

### 9.5 Concorrência com eventos comerciais

A emissão, a confirmação e os efeitos de terminação ou revogação de acesso sobre PRs adquirem o mesmo
bloqueio (o PR) por uma ordem fixa (primeiro a linha de acesso, depois o PR) para não haver deadlocks.
Qualquer que seja a ordem real, o segundo vê o resultado do primeiro. Se o efeito sobre o PR falhar ou for
omitido, a regra de runtime (§11) continua a impedir o uso: a segurança não depende desse efeito.

### 9.6 Janela de confirmação

Uma credencial `PENDING` só autentica dentro de uma janela de confirmação curta, avaliada em verificação
(sem worker). A **existência** da janela é decisão arquitetural; o **valor** é PDP-02.

## 10. Rotation and Expiration

### 10.1 Separação

| Camada | Estado |
|---|---|
| **A. Necessidade arquitetural de rotação** | **DECIDIDO**: a arquitetura tem de suportar rotação sem interrupção, a pedido (comprometimento, troca de chave de cifra, política) e agendada. |
| **B. Política operacional de rotação** (quando e com que frequência) | **POLICY DECISION PENDING** (PDP-01) |
| **C. TTL da credencial** | **POLICY DECISION PENDING** (PDP-01) |

### 10.2 Respostas

- **A arquitetura precisa obrigatoriamente de expiração?** Não. Precisa de *rotação*. A expiração é uma
  política que a arquitetura suporta (`expires_at` já existe e é avaliado em verificação, B3).
- **Uma credencial gerida pode existir sem expiry?** Sim, arquiteturalmente. Se é aceitável é PDP-01.
- **Quem inicia a rotação?** A UL é a autoridade da política e marca no PR `ACTIVE` que é preciso rodar
  (por política, comprometimento ou pedido OWNER/PLATFORM_ADMIN). A Na Pista (detentora) executa através de
  um PR `rotation`. O reconciliador também pode iniciar um `rekey` quando deteta que não tem a credencial
  local (§12.4).
- **Sobreposição (overlap)**: sequência sem interrupção:
  1. PR `rotation` → `ISSUED` (K2 `PENDING`); a Na Pista guarda K2 localmente `PENDING` e continua a usar K1.
  2. `confirm(K2)`: K2 → `ACTIVE`; o PR predecessor → `SUPERSEDED`; K1 passa a **retirada**: continua
     autorizada só até um prazo de retirada (`retire_after`).
  3. A Na Pista troca localmente numa transação (K2 `ACTIVE`, K1 `REVOKED`) e chama `retire` autenticada com
     K2 → a UL revoga K1 (`REVOKED(rotated)`).
  4. Se a Na Pista falhar entre 2 e 3: K1 continua válida até `retire_after`; o reconciliador retoma o passo 3.
     Passado `retire_after`, K1 é recusada em verificação (sem worker).
- **Janela segura de coexistência**: limitada por `retire_after`. A coexistência de duas credenciais
  `ACTIVE` só é permitida neste caso, com razão explícita (rotação) e prazo. O **valor** é PDP-04 (zero é uma
  política válida e aceita um 503 breve).
- **Como evitar downtime**: a Na Pista nunca troca a credencial local antes de a sucessora estar `ACTIVE` na
  UL, e a antecessora mantém-se válida até à troca local ou ao prazo.
- **Quando é revogada a antiga?** No `retire` explícito, ou implicitamente pelo prazo `retire_after`.
- **Na Pista offline durante a rotação**: nada avança. K1 continua válida até à sua expiração (se existir) ou
  até ao prazo de retirada (se a rotação já tiver sido confirmada). Se a credencial expirar, a organização
  fica a falhar fechada (503) até o reconciliador voltar e concluir a rotação. Um PR `rotation` não depende de
  a credencial atual ainda ser válida.
- **Deteção de credencial obsoleta (stale)**: a UL expõe nos metadados do PR (nunca no segredo) a
  credencial atual e se há rotação pedida; o reconciliador compara com o `platform_api_key_id` local. Um 401
  em runtime desencadeia uma verificação `/service/me`.
- **Credencial comprometida**: PLATFORM_ADMIN marca-a comprometida → `REVOKED(compromised)` imediato (efetivo
  no pedido seguinte) → PR `rekey` criado na mesma operação → o reconciliador reprovisiona. Sem
  sobreposição: a comprometida não ganha prazo de retirada.

## 11. Application Access and Fail-Closed Runtime Authorization

### 11.1 Decisão

**`NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS=false` não pode continuar a ser um default operacional em
produção.** A verificação de acesso comercialmente autorizado não pode depender de uma flag opcional (P5).

### 11.2 Regras de runtime na UL

Para **toda** credencial org-scoped, em cada pedido, a autenticação é bem-sucedida apenas se:

```
RUNTIME_AUTHZ_BASE(cred) ⇔
      hash válido ∧ cred ACTIVE ∧ não expirada
  ∧   organização active
  ∧   aplicação ACTIVE
  ∧   acesso efetivo da organização à aplicação (B7)          ← novo para ORGANIZATION
```

Para `INTEGRATION_MANAGED`, adicionalmente:

```
RUNTIME_AUTHZ_MANAGED(cred) ⇔ RUNTIME_AUTHZ_BASE(cred)
  ∧   PR da credencial em ACTIVE (ou, para a antecessora em rotação, retirada e antes de retire_after)
  ∧   existe um grant contratual efetivo para (organização, aplicação)
```

Para `PENDING`: só `/service/me` e `confirm`, dentro da janela de confirmação, com `AUTHZ` para `confirm`.

### 11.3 Escolha entre as três hipóteses

**Decisão: 1 + 3.** Toda API key org-scoped verifica acesso efetivo (hipótese 1), **e** existe uma distinção
estrutural explícita (hipótese 3) em que a credencial gerida verifica também a ligação ao PR e o grant
contratual.

Razão arquitetural da distinção: as duas classes têm **fontes de autoridade diferentes**.

- A autoridade de uma chave `ORGANIZATION` é "o OWNER decidiu, enquanto a organização tem acesso". É o G6
  (B2), que hoje só é verificado na criação. A verificação em runtime completa o G6 em vez de o mudar.
- A autoridade de uma `INTEGRATION_MANAGED` é "o contrato". Deve terminar exatamente quando o suporte
  contratual termina, mesmo que haja acesso concedido manualmente por outra via (B10).

Chaves `PLATFORM_SERVICE` não são org-scoped e não passam por rotas org-scoped (B5): sem alteração.

### 11.4 Onde se verifica

| Ponto | Verificação |
|---|---|
| Verificação de API key na UL (todas as rotas autenticadas) | `RUNTIME_AUTHZ_BASE` / `_MANAGED` / regra `PENDING` (fonte única) |
| Rotas de serviço da UL (entitlements, usage, eventos) | Já exigem correspondência org/app (B5); passam a herdar o runtime acima |
| Resolução de entitlements | Recusada se a credencial deixar de estar autorizada; a Na Pista falha fechada (503, N3) |
| Rotas de provisioning da UL | §7.2 e §5.4 |
| Runtime da Na Pista — caminho humano | Verificação de acesso obrigatória em produção. A variável deixa de poder desligá-la em produção (só pode relaxar harnesses de teste fora de produção) |
| Runtime da Na Pista — caminho de serviço de entrada | Recusa `INTEGRATION_MANAGED`; o restante é autorizado pela UL na introspeção |
| Runtime da Na Pista — chamadas de saída | O resolver nunca usa credenciais locais que não estejam `ACTIVE`; um 401 da UL leva a reconciliação (§12.4) |

### 11.5 Janela residual (caches)

Na UL, a decisão é imediata (no pedido seguinte; a verificação não tem cache). Na Pista, decisões já em cache
(entitlements e linha de credencial, 10 s; identidade, 15 s — N7) podem ainda aplicar-se até ao fim do TTL.
É a janela existente e aceite (OD-13); qualquer redução é PDP-08.

### 11.6 Consequência de compatibilidade

A verificação de acesso em runtime para chaves `ORGANIZATION` pode recusar chaves existentes cujas
organizações não têm linha de acesso (as chaves de validação manual / demo mencionadas em fases anteriores).
Isto **não** é resolvido com uma flag. É um **pré-requisito de implementação**: uma auditoria só de leitura
(autorizada separadamente) das chaves `ORGANIZATION` ativas sem acesso efetivo, seguida de decisão por chave
(conceder acesso de forma legítima ou revogar a chave) antes do deploy.

## 12. Na Pista F29A Integration Contract

### 12.1 Preservado sem alteração

AES-256-GCM; envelope `v1:`; AAD = organização; segredo só cifrado; no máximo 1 `ACTIVE` por organização;
`REVOKED` nunca reativada; `platform_api_key_id` único; resolver em falha fechada; cache só da linha cifrada.

### 12.2 Alterações de contrato necessárias (mínimas)

| # | Alteração | Razão |
|---|---|---|
| F1 | Estado local `PENDING` (guardado cifrado, **nunca** usado pelo resolver), no máximo 1 por organização | Persistir antes de confirmar (§9.3) e rotação sem downtime (§10.2) |
| F2 | Referência ao PR na linha local | Decidir "confirmar vs. reemitir" sem ambiguidade (cenários C, F, G) |
| F3 | Na introspeção, exigir classe `INTEGRATION_MANAGED`, a finalidade certa, a organização certa e o PR esperado | Impedir que se guarde uma credencial errada ou de outra classe |
| F4 | Ativação local atómica: `PENDING → ACTIVE` e `ACTIVE` anterior `→ REVOKED`, numa transação | Rotação, mantendo "máx. 1 `ACTIVE`" |
| F5 | Autenticação de entrada recusa `INTEGRATION_MANAGED` | §6.2 |
| F6 | Reconciliador (§9.3) com exclusão mútua por PR e identidade de serviço própria | Provisioning automático |
| F7 | Ator de auditoria do reconciliador (`service:<id da chave de provisioning>`), nunca a credencial | Auditoria |

O script `credentials:provision` mantém-se como ferramenta local de desenvolvimento (já limitado a loopback);
não é um caminho de produção.

### 12.3 UL `ACTIVE`, Na Pista sem credencial local

Causa: perda local (restauro de backup, troca da chave de cifra, falha de commit local depois da confirmação).
A Na Pista não pode recuperar o segredo (P2, só hash na UL). Comportamento: falha fechada para essa
organização (503) → o reconciliador cria um `rekey` sobre o PR `ACTIVE` → emissão e confirmação normais → a
credencial órfã é retirada sem sobreposição (ninguém a detém). Alerta operacional e evento de auditoria.

### 12.4 Na Pista com credencial local `ACTIVE`, UL `REVOKED` / não autorizada

Um 401 da UL a uma chamada com a credencial local leva a `/service/me` com essa credencial:

- **Inválida** (revogada ou expirada) → local `REVOKED` (auditado) → o reconciliador consulta o PR:
  - `rotation`/`rekey` em curso → segue §9.3;
  - PR `REVOKED` ou `CANCELLED` → nada (a organização deixou de estar autorizada);
  - PR `ACTIVE` com outra credencial atual → `rekey`.
- **Válida mas não autorizada comercialmente** (acesso ou grant ausente) → **não** revogar localmente (pode
  ser suspensão temporária); falha fechada e nova verificação mais tarde.

Nunca se marca `REVOKED` com base num 401 que não tenha sido confirmado por introspeção (evita revogações
induzidas por falhas transitórias).

## 13. Termination and Revocation

**Existência ≠ autorização.** A revogação física (estado `REVOKED`) é escrita sempre que possível na mesma
transação do evento, mas a segurança assenta na regra de runtime (§11), que não precisa de nenhum worker.

| Evento | Credencial gerida inutilizável quando | Efeito no PR | Efeito físico na credencial | Reversível |
|---|---|---|---|---|
| Cancelamento de contrato (`pending_activation`) | — (nunca houve grant ativo; PR não criado) | — | — | — |
| Terminação de contrato | Pedido seguinte à UL (grant revogado → `AUTHZ` falso) | `ACTIVE → REVOKED`, abertos `→ CANCELLED` | `REVOKED(contract_terminated)` | Não (novo contrato → novo PR) |
| Fim temporal do grant/subscription | No primeiro pedido depois de `ends_at` (predicado em leitura) | Inalterado até ao housekeeping | Inalterado até ao housekeeping | Renovação = novo grant efetivo → volta a autorizar o mesmo PR |
| Revogação de acesso à aplicação | Pedido seguinte | Como na terminação | `REVOKED(access_revoked)` | Não |
| Suspensão da organização | Pedido seguinte (já verificado hoje) | Inalterado | Inalterado | Sim |
| Revogação manual (OWNER desativa / PLATFORM_ADMIN) | Pedido seguinte | `REVOKED` | `REVOKED(integration_disabled \| admin_revoked)` | Não (novo PR `initial`) |
| Comprometimento | Pedido seguinte | `REVOKED` + PR `rekey` | `REVOKED(compromised)` | — |

Na Na Pista, a inutilização efetiva acontece no pedido seguinte à UL, mais a janela de cache em §11.5.

## 14. Audit and Observability

### 14.1 Separação

| Camada | Onde | Conteúdo | Garantia |
|---|---|---|---|
| **Auditoria de segurança** | UL `audit_logs` (e auditoria F29A na Na Pista) | Mudanças de estado e recusas de autorização | Escrita **na mesma transação** da mudança; uma falha de escrita aborta a operação. Para estes eventos não se aceita o comportamento atual de engolir erros (B11). |
| **Logs operacionais de reconciliação** | Logs estruturados da Na Pista | Ciclos, tentativas, falhas transitórias, latências | Best effort; nunca fonte de verdade |

### 14.2 Eventos mínimos

| Evento | Camada | Quando |
|---|---|---|
| `integration.credential.requested` | Auditoria UL | PR criado (inclui `kind`, predecessor) |
| `integration.credential.issue_started` | **Operacional** (Na Pista) | Antes de chamar `issue`. Não é auditoria: a emissão é atómica e não há estado intermédio. |
| `integration.credential.issued` | Auditoria UL | Credencial `PENDING` emitida (inclui a contagem de emissões) |
| `integration.credential.superseded` | Auditoria UL | `PENDING` anterior revogada por nova emissão |
| `integration.credential.confirmed` | Auditoria UL e Na Pista | Prova de posse aceite; credencial e PR `ACTIVE` |
| `integration.credential.activation_failed` | Auditoria UL | Confirm recusado (credencial não é a atual, janela esgotada, `AUTHZ` falsa) |
| `integration.credential.rotated` | Auditoria UL | Antecessora retirada |
| `integration.credential.revoked` | Auditoria UL e Na Pista | Qualquer revogação, com motivo |
| `integration.credential.refused` | Auditoria UL | `issue` ou criação de PR recusada (motivo em código) |
| `integration.credential.reconcile_failed` | Operacional Na Pista (+ contador) | Ciclo falhou; repetido N vezes → alerta |

### 14.3 Campos

`provisioningId` · `organizationId` · `applicationKey` · `purpose` · `kind` · `credentialId` (o id público da
API key) · `actor` (`type` + id; para serviço, o id público da chave que autenticou) · `correlationId` (=
request id) · `issueCount` · `result` (`ok` \| `refused` \| `error`) · `reasonCode` · `timestamp`.

### 14.4 Nunca registar

Segredo em claro, segredo cifrado, token `ulk_…` completo, header `Authorization`, corpo da resposta de
`issue`, chave de cifra, ou qualquer derivado reversível. Os testes de fuga (§20) verificam logs, auditoria,
eventos e respostas humanas.

## 15. Authorization Matrix

Legenda: ✅ permitido · ❌ negado · condições na coluna.

| Ator / credencial | Request provisioning | Issue | Confirm | Revoke | Rotate | List provisioning (aberto) | Read integration state | Use application API | Recover after failure |
|---|---|---|---|---|---|---|---|---|---|
| **OWNER** (JWT) | ✅ `initial` (reativar) e `rotation`; membership ativa + `AUTHZ` | ❌ | ❌ | ✅ só "Desativar integração" | ✅ pedir `rotation` | ❌ | ✅ própria organização | n/a | ✅ "Tentar novamente" = novo PR se o anterior foi cancelado |
| **ADMIN** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ própria organização (só leitura) | n/a | ❌ |
| **MANAGER** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | n/a | ❌ |
| **STAFF** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | n/a | ❌ |
| **PLATFORM_ADMIN** | ✅ `initial` / `rotation` / `rekey` (+ `AUTHZ`) | ❌ (nunca vê segredo) | ❌ | ✅ incluindo comprometimento | ✅ | ✅ (metadados) | ✅ todas | n/a | ✅ cancelar, re-pedir, `rekey` |
| **Reconciliador Na Pista** (chave `PROVISIONER`) | ✅ só `rekey` sobre PR `ACTIVE` da sua aplicação | ✅ §7.2 | ❌ (exige a credencial `PENDING`) | ❌ | ✅ só `rekey` | ✅ só a sua aplicação e finalidade | ❌ | ❌ (não é org-scoped) | ✅ via §9.3 |
| **Chave `ORGANIZATION`** (OWNER) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ se `RUNTIME_AUTHZ_BASE` e scopes | ❌ |
| **`INTEGRATION_MANAGED` `PENDING`** | ❌ | ❌ | ✅ só o seu PR, na janela, com `AUTHZ` | ❌ | ❌ | ❌ | ❌ | ❌ (só `/service/me`) | ❌ |
| **`INTEGRATION_MANAGED` `ACTIVE`** | ❌ | ❌ | ✅ idempotente (cenário G) | ❌ | ❌ | ❌ | ❌ | ✅ se `RUNTIME_AUTHZ_MANAGED` e scopes fixos | ✅ `retire` da antecessora durante a rotação |

## 16. Threat Model

| # | Ameaça | Superfície | Proteção | Deteção | Recuperação |
|---|---|---|---|---|---|
| T1 | OWNER tenta obter a credencial gerida pelo browser | Rotas humanas, UI | Nenhuma rota humana devolve segredos; `issue` recusa JWT; a classe é excluída das rotas genéricas de API keys; só existe o hash | Recusa auditada (`refused`) | — |
| T2 | OWNER pede provisioning para uma aplicação sem acesso | Criação de PR | `AUTHZ` (acesso efetivo + grant contratual) na criação e em cada transição | `refused` | — |
| T3 | Chave de provisioning comprometida | API de provisioning | Só PRs **abertos** da sua aplicação; não confirma sozinha; scope único; revogável de imediato. **Risco residual**: o atacante pode correr contra o reconciliador, emitir e confirmar uma credencial para um PR aberto, ficando com uma credencial org-scoped com scopes fixos (`usage.write`, `event.publish`) dessa organização. | O reconciliador encontra o PR `ACTIVE` sem credencial local (§12.3); `issued`/`confirmed` com origem inesperada; contagens de emissão anómalas | Revogar a chave de provisioning; `rekey` de todos os PRs que mudaram de estado na janela suspeita; política de rotação geral em PDP-06; restrição de rede em PDP-09 |
| T4 | Credencial da Na Pista comprometida | Rotas de serviço da UL | Scopes fixos mínimos; ligada a uma organização; `RUNTIME_AUTHZ_MANAGED`; AAD | Uso fora do padrão (logs da UL) | Marcar comprometida → `REVOKED` + `rekey` |
| T5 | Replay de `issue` | `issue` | `expected_issue_count` + bloqueio; replay com contagem antiga → 409 sem emissão; replay com a contagem atual exige a chave de provisioning (T3) | 409 em log | — |
| T6 | Replay de `confirm` | `confirm` | Autenticado pela própria credencial; depois de `ACTIVE` é no-op; com credencial substituída ou revogada → 401 | `activation_failed` | — |
| T7 | Emissões concorrentes duplicadas | `issue` | Bloqueio do PR + contagem; I1 na base de dados | 409 | Segunda chamada segue §9.3 |
| T8 | Resposta perdida depois de a Na Pista guardar | Rede | Estado local `PENDING` + regra "confirmar antes de reemitir" (cenário C) | Logs operacionais | Confirmação |
| T9 | Contrato terminado durante o provisioning | Corrida comercial | `AUTHZ` sob bloqueio em `issue`/`confirm`; runtime §11 | `refused` / `activation_failed` / `revoked` | Nenhuma (fim legítimo) |
| T10 | Acesso revogado durante o provisioning | Igual | Igual | Igual | Igual |
| T11 | Id de PR divulgado | Logs, UI, suporte | O id não é segredo nem autoridade: `issue` exige a chave de provisioning; `confirm` exige a credencial | — | — |
| T12 | Id de API key divulgado | Metadados | Público por desenho (B1): a pesquisa usa-o, a autenticação exige o segredo | — | — |
| T13 | Base de dados da Na Pista comprometida | BD | Só cifrado; AAD por organização; a chave de cifra está fora da BD | Auditoria de acesso à BD (infra) | Rodar a chave de cifra (envelope versionado) + `rekey` de todas as organizações |
| T14 | Credencial local obsoleta | Resolver | A UL recusa (runtime); a Na Pista confirma por introspeção antes de marcar `REVOKED` | 401 → introspeção; comparação com a credencial atual do PR | §12.4 |
| T15 | Credencial antiga depois da rotação | Rotação | `retire` explícito + prazo `retire_after` verificado em runtime; a comprometida não tem prazo | `rotated` em falta após o prazo | Revogação imediata pelo PLATFORM_ADMIN |

## 17. Failure and Recovery Matrix

| Falha | Efeito para o cliente | Recuperação | Segurança afetada? |
|---|---|---|---|
| UL disponível, Na Pista indisponível | "Configuração em curso" | O PR espera; o reconciliador retoma quando a Na Pista volta | Não |
| Na Pista disponível, UL indisponível | Na Pista falha fechada (503) | Retry com backoff | Não |
| Resposta de `issue` perdida (não guardada) | Atraso | Cenário B/D | Não (`PENDING` inutilizável) |
| Resposta perdida depois de guardar | Atraso | Cenário C | Não |
| Resposta de `confirm` perdida | Atraso | Cenário G | Não |
| Timeout | Atraso | Reler + §9.3 | Não |
| Pedido duplicado | Nenhum | 409 + estado | Não |
| Terminação ou revogação de acesso durante o provisioning | "Acesso revogado" | Nenhuma (legítimo) | Não (falha fechada) |
| Janela de confirmação esgotada | "Erro / em curso" | Nova emissão (substituição) | Não |
| Credencial comprometida | "Configuração em curso" durante o `rekey` | §10.2 | Contida |
| Chave de provisioning comprometida | Possível emissão indevida para PRs abertos | T3 | Contida (scopes fixos, deteção) |
| Perda local (backup ou troca de chave de cifra) | 503 até ao `rekey` | §12.3 | Não |
| Reconciliador falha repetidamente | "Erro" após o limiar | Alerta; PLATFORM_ADMIN cancela e recria | Não |

## 18. Decisions

| ID | Decisão | Status | Rationale | Consequência de implementação |
|---|---|---|---|---|
| D2B-01 | Opção B — pull servidor-a-servidor | **CLOSED** | O segredo nunca passa por pessoas nem pelo browser; a Na Pista não ganha superfície de entrada; a UL mantém a autoridade; mantém as duas camadas de isolamento (rejeita D) | Endpoints de serviço na UL; reconciliador na Na Pista |
| D2B-02 | Um PR é obrigatório antes de emitir | **CLOSED** | O PR é a autoridade contextual; a emissão nunca recebe org/app como autoridade | Modelo PR (§5), I1/I2 na base de dados |
| D2B-03 | A chave de plataforma não autoriza emissões arbitrárias | **CLOSED** | §7.2: chave + PR aberto + `AUTHZ` atual + aplicação e finalidade derivadas da chave | Classe `PLATFORM_SERVICE/PROVISIONER`, scope `credential.provision` |
| D2B-04 | Credencial gerida estruturalmente distinta da chave do OWNER | **CLOSED** | Fontes de autoridade diferentes (§11.3); evita revogação acidental e uso indevido como credencial de entrada | Classe de credencial imutável + ligação imutável ao PR; rotas genéricas recusam |
| D2B-05 | O segredo nunca é exposto a browser, pessoa ou ficheiro | **CLOSED** (exceção única: bootstrap da chave de provisioning, §7.1) | P3 | Só o corpo de `issue` (servidor-a-servidor) transporta segredos |
| D2B-06 | Acesso à aplicação em falha fechada em produção | **CLOSED** | P5; a flag não pode relaxar produção | Na Pista: verificação incondicional em produção; UL: acesso efetivo em runtime para toda chave org-scoped |
| D2B-07 | Autorização da credencial verificada em runtime | **CLOSED** | P4; B8 (não há jobs) | `RUNTIME_AUTHZ_BASE` / `_MANAGED` na verificação de API keys |
| D2B-08 | Semântica de retry/timeout | **CLOSED** | §9: contagem de emissões + `PENDING` inutilizável + "confirmar antes de reemitir" | Contagem otimista, bloqueio do PR, regra §9.3 |
| D2B-09 | Semântica de confirmação | **CLOSED** | Prova de posse pela própria credencial; idempotente; confirmar = ativar (sem `DELIVERED`/`CONFIRMED` separados) | Endpoint `confirm` autenticado pela credencial `PENDING` |
| D2B-10 | Arquitetura de rotação | **CLOSED** | PR `rotation`/`rekey` + retirada com prazo + `retire` explícito | §10.2 |
| D2B-11 | Política de TTL | **POLICY DECISION PENDING** (PDP-01) | Sem fundamento para um valor; a arquitetura funciona com ou sem expiração | `expires_at` opcional e configurável por (aplicação, finalidade) |
| D2B-12 | Semântica de terminação/revogação | **CLOSED** | §13: existência ≠ autorização; a revogação física é feita na mesma transação quando possível | Efeitos em `revokeGrantInTx` + regra de runtime |
| D2B-13 | F29A continua a ser o armazenamento da Na Pista | **CLOSED** | Já cumpre cifra, AAD, unicidade e não-reativação | Só as alterações F1–F7 (§12.2) |
| D2B-14 | Modelo de auditoria/eventos | **CLOSED** | §14: auditoria transacional vs. logs operacionais | Variante de auditoria que não engole erros para estes eventos |
| D2B-15 | Ciclo de vida da chave de provisioning | **CLOSED** (arquitetura); valores em PDP-01/PDP-06/PDP-09 | §7.1 | Classe e scope próprios; coexistência de duas chaves durante a troca |

## 19. Policy Decisions Pending

| ID | Decisão de política | Porque não é arquitetural | Default seguro até decidir |
|---|---|---|---|
| PDP-01 | TTL das credenciais geridas e da chave de provisioning; frequência da rotação agendada | Depende de risco e de capacidade operacional; nenhum valor está fundamentado | Sem rotação agendada; rotação a pedido e por comprometimento disponível |
| PDP-02 | Valor da janela de confirmação de `PENDING` | Valor operacional | A implementação não pode avançar sem um valor; deve ser curto (minutos, não dias) |
| PDP-03 | Limiar de PR "obsoleto" (alertas e cancelamento automático de `REQUESTED`) | Operacional | Só alerta; nenhum cancelamento automático |
| PDP-04 | Valor de `retire_after` na rotação | Compromisso entre downtime e coexistência | Exige valor antes de implementar a rotação; zero é aceitável |
| PDP-05 | Acesso manual sem contrato (B10, pilotos) pode ter credenciais geridas? | Decisão comercial | **Não** (falha fechada) |
| PDP-06 | Perante uma chave de provisioning comprometida: `rekey` só dos PRs afetados ou de todas as organizações | Custo operacional vs. risco | `rekey` dos PRs que mudaram de estado na janela suspeita |
| PDP-07 | Mostrar as credenciais geridas como linha só de leitura na lista de API keys do OWNER? | UX/transparência | Ocultas da lista genérica; visíveis na vista de integração |
| PDP-08 | Reduzir os TTL de cache da Na Pista (janela residual §11.5)? | Desempenho vs. latência de revogação | Manter 10/15 s (OD-13) |
| PDP-09 | Restrição de rede (allowlist de origem) para a chave de provisioning | Depende da infraestrutura de deploy da Na Pista | Nenhuma (não é condição de segurança da arquitetura) |
| PDP-10 | Destino das chaves `ORGANIZATION` existentes sem acesso efetivo (§11.6) | Decisão por chave, com dados reais | Bloqueia o rollout de D2B-07 até estar decidido |

## 20. Implementation Boundary

### READY FOR IMPLEMENTATION (sujeito a autorização de implementação)

- Classe de credencial (`ORGANIZATION` / `INTEGRATION_MANAGED` / `PLATFORM_SERVICE`, com sub-finalidade
  `PROVISIONER`) e ligação imutável da credencial gerida ao PR.
- Modelo de PR: estados, transições, invariantes I1–I6, `AUTHZ` em cada transição, criação na ativação do
  contrato, efeitos em terminação/revogação.
- Endpoints de serviço: listar PRs abertos, `issue` (com contagem esperada), `confirm`, `retire`; endpoints
  humanos de estado/pedido/desativação; endpoints PLATFORM_ADMIN de recuperação.
- `RUNTIME_AUTHZ_BASE` / `_MANAGED` / regra `PENDING` na verificação de API keys.
- Na Pista: F1–F7, reconciliador, verificação de acesso incondicional em produção.
- Auditoria transacional para os eventos §14; logs operacionais no reconciliador.
- Testes (mínimo): todos os cenários A–I; matriz §15 linha a linha; T1–T15; concorrência (N emissões
  simultâneas → 1); testes de fuga do segredo (logs, auditoria, eventos, respostas humanas, browser via
  harness E2E); mutation tests em cada guarda: `AUTHZ` na emissão, aplicação da chave = aplicação do PR,
  scope, contagem/bloqueio, prova de posse, regra `PENDING`, runtime de acesso, runtime do grant, efeitos de
  terminação, AAD, recusa de entrada de `INTEGRATION_MANAGED`.

Pré-requisitos antes do deploy: auditoria só de leitura das chaves `ORGANIZATION` ativas sem acesso efetivo
(PDP-10, autorização própria); valores de PDP-02 e PDP-04.

### POLICY DECISIONS STILL PENDING

PDP-01 … PDP-10 (§19).

### OUT OF SCOPE

- QD e outras aplicações (o modelo é genérico por aplicação e finalidade, mas só Na Pista é implementada).
- Credenciais assimétricas (`private_key_jwt`) — evolução que eliminaria a exceção de bootstrap e a entrega
  de segredos.
- Deploy e infraestrutura de produção da Na Pista; gestor de segredos concreto.
- UL Console (operação comercial) — Phase 2.4.
- Migrations SQL detalhadas, nomes definitivos de tabelas/colunas, comandos de produção.
- Rotação da chave de cifra F29A (o envelope já é versionado; o procedimento é um tema próprio).
- Faturação, aspetos jurídicos ou fiscais.

## 21. Final Recommendation

Avançar com a **Opção B revista**:

> **Pull servidor-a-servidor, iniciado pela Na Pista, autorizado por um Provisioning Request persistido na
> UL, que emite uma credencial gerida estruturalmente distinta, nascida `PENDING` e ativada só por prova de
> posse, cuja autorização é reavaliada em cada pedido contra o estado comercial efetivo.**

Em resumo:

- A existência de uma credencial deixa de equivaler à sua autorização.
- Uma chave de plataforma deixa de poder obter credenciais sem um pedido legítimo.
- Os retries deixam de poder produzir duas credenciais `ACTIVE`.
- O F29A mantém-se como está, com sete alterações de contrato pequenas.

As decisões D2B-01…D2B-10 e D2B-12…D2B-15 estão fechadas. D2B-11 (TTL) fica explicitamente como **POLICY
DECISION PENDING**. A implementação só pode começar depois de:

1. revisão deste documento;
2. decisão de PDP-02 e PDP-04;
3. autorização de implementação;
4. para o rollout de D2B-07: a auditoria PDP-10.
