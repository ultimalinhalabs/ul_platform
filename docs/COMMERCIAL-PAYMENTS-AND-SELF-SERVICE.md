# Pagamentos e contratação self-service — UL Platform

> 15/10/2026 · migrações `0023_commercial_payments` e `0024_self_service_catalog` · branch
> `feature/commercial-payments-self-service` (sobre `fix/organization-creation-hardening`).
> **Não publicado.** Nenhuma migração foi aplicada em produção.

## 1. Regras aprovadas (dono, 15/10/2026)

Um pacote só é ativado quando, **cumulativamente**:

1. a organização está ativa;
2. os termos aplicáveis foram aceites e a aceitação ficou registada (o contrato só existe a partir de uma aceitação);
3. o pagamento está confirmado e registado.

A ativação **nunca** ignora o pagamento: não existe flag que o dispense. A confirmação manual é exclusiva de
administradores autorizados, com evidência e auditoria. O canal assistido e o self-service usam a **mesma**
infraestrutura: proposta → aceitação → contrato → pagamento → `activateContract`.

## 2. Arquitetura (alteração mínima)

```
catálogo (plans: purchase_mode, price_minor, currency, period_days, terms_template_id)
   │ self-service: POST /v1/organizations/:id/self-service/contracts   (OWNER, email verificado, Idempotency-Key)
   ▼
proposta channel=self_service, congelada (snapshot + SHA-256, termos aprovados)   ← assistido: proposta da UL
   │ POST /v1/proposals/:id/acceptance  (o mesmo endpoint, as mesmas regras)
   ▼
contrato pending_activation (+ itens com duration_days ou duration_months)
   │ pagamento confirmado:
   │   manual      POST /v1/platform/contracts/:id/payments        (platform.payment.confirm)
   │   integração  POST /v1/service/payments/confirmations         (PLATFORM_SERVICE MICHA_EXPRESS, payment.confirm)
   ▼
activateContract — reverifica as 3 condições; tenta automaticamente após a confirmação
   ▼
grant + subscrição + acesso  →  expira (worker) / termina / cancela
```

- **Sem motor paralelo:** o self-service gera uma proposta a partir do catálogo, com os mesmos triggers de
  imutabilidade, e reutiliza a aceitação e o contrato. O cliente nunca envia preço, período ou limites.
- **Pagamento ≠ fatura:** `commercial_payments` regista apenas *que* uma fonte confiável confirmou o valor do
  contrato. A UL Platform não movimenta dinheiro, não guarda credenciais de pagamento e não emite faturas.

## 3. Pagamentos (`commercial_payments`, migração 0023)

| Campo | Regra |
|---|---|
| `contract_id`, `organization_id` | O contrato; a organização tem de ser a do contrato (trigger) |
| `amount_minor`, `currency` | **Iguais** ao total e moeda do contrato (serviço + trigger). Sem pagamentos parciais nesta fase |
| `source` | `manual` (exige `confirmed_by_user_id`) ou `integration` (exige `confirmed_by_api_key_id`) |
| `method` | Código curto (`bank_transfer`, …). Na integração é a própria aplicação (`micha_express`), nunca um campo do pedido |
| `external_reference` | Única por fonte: a mesma referência nunca confirma dois contratos |
| `received_at`, `confirmed_at` | Data de receção (não pode ser futura) e de registo |
| `evidence_reference` | Ponteiro interno para a evidência (nunca o documento nem dados pessoais); não sai para o cliente nem para a auditoria |
| `idempotency_key` | Obrigatória; mesma chave + mesmo conteúdo = replay (200), conteúdo diferente = 409 |

Garantias: no máximo **um** pagamento confirmado por contrato (índice único parcial); só um contrato
`pending_activation` aceita confirmação; a tabela é *append-only* (UPDATE/DELETE/TRUNCATE recusados); RLS ligado e
sem acesso pela Data API. Erros: `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_ALREADY_CONFIRMED`,
`PAYMENT_REFERENCE_IN_USE`, `CONTRACT_NOT_PAYABLE` (409).

Depois de registar, a plataforma chama `activateContract`. Se houver um impedimento (ex.: organização suspensa),
o pagamento fica registado, o contrato continua pendente e a resposta indica o impedimento.

**Ator da ativação:** administrador (rota explícita ou confirmação manual) → `entitlement_grants.activated_by`;
integração → ator `system` com `activated_by_api_key_id` (nova coluna; o check de ativação aceita um dos dois).

### Contrato de entrada para a Micha Express (definido pela UL)

Não existe API da Micha Express no workspace (lacuna G-MX1, ADR-067 do Na Pista). Este endpoint define apenas **o que a UL
aceita**; o lado Micha Express (intenção de pagamento, webhooks, reconciliação) está por especificar com essa equipa.

```
POST /v1/service/payments/confirmations
Authorization: Bearer ulk_…     (PLATFORM_SERVICE da aplicação MICHA_EXPRESS, scope payment.confirm)
Idempotency-Key: <8–200 [A-Za-z0-9._:-]>
{ "contractId": "uuid", "amountMinor": "2500000", "currency": "AOA", "externalReference": "…", "receivedAt": "ISO-8601" }
→ 201 { payment, replayed: false, activation: { activated, alreadyActive, blocker } }   |   200 em replay
```

O scope `payment.confirm` só pode ser atribuído a credenciais da aplicação `MICHA_EXPRESS` (allowlist). Credenciais
de organização, sessões humanas e outras aplicações são recusadas.

## 4. Catálogo self-service (migração 0024)

| Campo em `plans` | Uso |
|---|---|
| `purchase_mode` | `contractual` (padrão) ou `self_service` |
| `price_minor`, `currency` | Preço por período, em unidades mínimas |
| `period_days` | Período em dias ("30 dias, não mês civil"); vai para `duration_days` do item |
| `terms_template_id` | Modelo contratual aplicável; tem de estar **aprovado** para contratar (`TERMS_NOT_APPROVED`) |

Configuração: `PUT /v1/platform/plans/:applicationKey/:planKey/commercial` (`platform.proposal.manage`, auditado).
Leitura: `GET /v1/catalog/self-service[?applicationKey=]` (qualquer utilizador autenticado). O preço, o período e os
termos são **copiados** para a proposta e o contrato congelados; mudar o catálogo nunca altera um contrato aceite.

Não confundir com `SELF_SERVICE_PLANS` (`modules/subscriptions/selfService.ts`), que é subscrição direta **sem**
contrato e continua vazia.

## 5. Expiração persistida

O acesso já terminava na leitura (`entitlements/effectiveness.ts`). O worker (`src/worker.ts`) passa agora, a cada
`CONTRACT_EXPIRY_SWEEP_INTERVAL_MS` (padrão 5 min), os contratos ativos cujo fim passou para `expired`: grants
`expired`, subscrições `canceled`, acesso revogado (se nenhum outro grant ativo o suporta), eventos e auditoria com
ator `system`. Usa um lock por contrato (`SKIP LOCKED`) e é idempotente.

## 6. Valores e decisões pendentes (não inventados aqui)

- **Catálogo real:** os valores Na Pista Crescimento (25 000 AOA / 30 dias, 500 produtos, 5 utilizadores) são da
  especificação de trabalho v1.0 e **não estão aprovados**. Só foram usados como dados de teste locais. Nenhum plano
  foi criado por migração ou seed.
- **Termos:** NP-TOS-001 (Anexo A) e o acordo de piloto (Anexo B) são rascunhos sem aprovação jurídica; o texto
  oficial de consentimento (`consent.ts`) continua por aprovar, pelo que a aceitação está bloqueada em produção.
- **Limites (produtos, utilizadores):** são emitidos como direitos do plano; a aplicação efetiva cabe ao Na Pista.
  O limite de utilizadores por organização (memberships na UL) **não** está implementado.
- **Renovação:** não implementada (o spec admite renovação condicionada; requer decisão comercial e jurídica).
- **Identificação legal do cliente** (NIF, representante) no self-service: não recolhida nesta fase.
- **Métodos de pagamento manual aceites** e **evidência mínima exigida**: procedimento a definir pela UL.
- **Papel dedicado** para confirmar pagamentos (hoje só `PLATFORM_ADMIN` tem `platform.payment.confirm`).
- **Validade da oferta self-service:** `SELF_SERVICE_OFFER_VALIDITY_HOURS` (24 h por omissão) é um parâmetro técnico.
- **Integração Micha Express:** especificação do lado Micha (intenção, webhook assinado, reconciliação, estornos).
