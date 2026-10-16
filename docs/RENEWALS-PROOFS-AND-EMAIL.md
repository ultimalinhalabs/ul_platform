# Renovação, comprovativo de pagamento e emails (migrações 0026–0028)

> 16/10/2026 — branch `feature/pilot-readiness` (local, não publicada). Complementa
> `COMMERCIAL-PAYMENTS-AND-SELF-SERVICE.md`.

## 1. Decisões do dono (16/10/2026)

| Tema | Decisão |
|---|---|
| Pagamento pelo cliente | IBAN (transferência) **ou** Multicaixa Express, e depois o envio do comprovativo em **PDF** |
| Quem confirma | Continua a ser qualquer `PLATFORM_ADMIN`; fica preparada a estrutura para uma função de finanças |
| Renovação | Implementar (T11–T13) |
| Convites de equipa | Email **automático** |

## 2. Renovação (migração 0026)

- **Autorização expressa** (`contract_renewal_authorizations`): só o OWNER, num contrato ativo e renovável
  (um único item `application_plan` com período em dias). O servidor mostra o texto exato (preço, período,
  como funciona, como retirar). O cliente devolve o hash desse texto, que fica gravado com o preço e o
  período. O registo é histórico: só pode ser retirado, uma vez.
  - `POST /v1/organizations/:org/contracts/:id/renewal-authorization` (`Idempotency-Key`, `{consent, consentSha256}`)
  - `POST …/renewal-authorization/withdrawal`
- **Preparação (T11)**: `RENEWAL_LEAD_DAYS` (7) dias antes do fim, o worker (ou logo na autorização, se já
  estiver dentro da janela) cria `contract_renewals` com o estado `awaiting_payment`, o período seguinte e o
  valor autorizado, e envia um email aos OWNERs com as instruções. Nada é prolongado antes do pagamento.
- **Pagamento (T12)**: `POST /v1/platform/contracts/:id/payments` com `renewalId` (ou a integração com
  `renewalId`). Só há um pagamento por renovação. Ao confirmar, a renovação é aplicada uma única vez:
  contrato, grants ativos e subscrições passam a terminar em `period_ends_at`. Se a organização estiver
  suspensa, o pagamento fica gravado e a aplicação é bloqueada. Depois aplica-se com
  `POST /v1/platform/renewals/:id/activation`.
- **Retirada (T13)**: sem autorização, não há renovação. Uma renovação preparada e ainda não paga é
  cancelada. Uma já paga não é cancelada.
- **Sem pagamento**: no fim do período, a varredura de expiração marca a renovação como `lapsed` e o acesso
  termina.
- **Por validar juridicamente**: o texto da autorização (`renewalConsentText`, v1). Mudar o texto muda o
  hash, mas nunca altera os registos passados.

## 3. Comprovativo de pagamento (migração 0027)

- `GET /v1/organizations/:org/contracts/:id/payment-instructions[?renewalId=]`: devolve o valor, a
  referência (`UL-C-…` ou `UL-C-…-R<n>`) e só os métodos configurados (`PAYMENT_IBAN`, `PAYMENT_BANK_NAME`,
  `PAYMENT_ACCOUNT_HOLDER`, `PAYMENT_MCX_EXPRESS_NUMBER`).
- `POST /v1/organizations/:org/contracts/:id/payment-proofs?method=&reference=&fileName=[&renewalId=]`:
  - o corpo é o PDF em bruto (`application/pdf`, até 4 MB, abaixo do limite da Vercel);
  - o servidor verifica a assinatura `%PDF-`;
  - o mesmo ficheiro conta como um só comprovativo;
  - há no máximo 5 à espera de revisão;
  - é enviado um email à equipa UL (`PAYMENTS_NOTIFY_EMAIL`).
- O comprovativo **não confirma nada**. O admin:
  - abre o PDF: `GET /v1/platform/payment-proofs/:id/file` (permissão `platform.payment_proof.read`; fica auditado);
  - rejeita-o com um motivo: `POST …/rejection` (o OWNER recebe email);
  - ou confirma o pagamento com `proofId`, e o comprovativo passa a `accepted` na mesma transação.
- O PDF fica em `payment_proof_files` (bytea), uma tabela separada que as listagens nunca carregam. É
  imutável (trigger) e está fechado à Data API.
- **Função de finanças preparada**: `PLATFORM_FINANCE` = `platform.commercial.read` +
  `platform.payment.confirm` + `platform.payment_proof.read`. Ainda ninguém a tem.

## 4. Emails transacionais (migração 0028)

- `email_outbox`: a mensagem é escrita na mesma transação do facto que a origina, e `dedupe_key` garante
  que não se repete. O worker envia por SMTP:
  - os pedidos são reservados com `SKIP LOCKED` e um prazo;
  - em caso de falha tenta de novo, com espera de 1 min a 6 h;
  - fica `failed` depois de 8 tentativas.
- Sem `SMTP_HOST`, as mensagens ficam à espera e nada se perde. Os logs nunca incluem o destinatário nem o
  corpo da mensagem.
- Mensagens atuais:
  - convite de equipa (para o email convidado);
  - renovação preparada (para os OWNERs);
  - comprovativo recebido (para a equipa UL);
  - comprovativo rejeitado (para os OWNERs).
- Configuração: `SMTP_HOST/PORT/SECURE/USER/PASSWORD` (segredo), `EMAIL_FROM`, `EMAIL_REPLY_TO`,
  `UL_CLIENT_URL`, `UL_CONSOLE_URL`. Em produção, a caixa AngoWeb (`mail.ultimalinha.ao:465`). O SPF já
  inclui o IP e a DKIM está publicada.

## 5. Testes

- `tests/renewals-proofs.test.ts` (21):
  - T11, T12 (manual e integração), T13 (antes e depois da preparação);
  - caducidade, organização suspensa;
  - concorrência na renovação e proteções da BD;
  - instruções, envio (PDF real, 4 MB, OWNER, mesmo ficheiro, limite), revisão (download auditado,
    rejeição com email), aceitação na confirmação;
  - passo 4: confirmação manual e integração em simultâneo, o mesmo pedido repetido em paralelo, e a
    mesma referência usada em dois contratos.
- `tests/email-outbox.test.ts` (6):
  - modelos de mensagem, idempotência e rollback;
  - email do convite;
  - tentativas repetidas e `failed`;
  - workers em concorrência.
