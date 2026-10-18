# Configuração de pagamentos e comunicações — piloto

> 16/10/2026. **Nenhum segredo neste documento nem no chat.** Os valores são colocados pelo dono diretamente
> nos painéis da Vercel e da Railway. Nada foi configurado em produção.

## 1. Dados necessários

| Dado | É segredo? | Variável | Onde configurar | Para quê |
|---|---|---|---|---|
| Nome do banco | Não | `PAYMENT_BANK_NAME` | Vercel `ul-platform` **e** Railway `worker` | Instruções na página do contrato e no email de renovação |
| Titular da conta (denominação legal) | Não | `PAYMENT_ACCOUNT_HOLDER` | Vercel e Railway | idem |
| IBAN (AO06…) | Não (dado de pagamento público), mas tratar com cuidado | `PAYMENT_IBAN` | Vercel e Railway | idem. Sem IBAN, a transferência não é oferecida |
| Número Multicaixa Express | Não | `PAYMENT_MCX_EXPRESS_NUMBER` | Vercel e Railway | idem. Sem número, o Express não é oferecido |
| Email do financeiro | Não | `PAYMENTS_NOTIFY_EMAIL` | Vercel `ul-platform` (o email é posto na fila quando o cliente envia o PDF) | Aviso "comprovativo recebido" |
| Caixa de envio (ex.: nao-responder@ultimalinha.ao) | Não | `EMAIL_FROM` (e opcional `EMAIL_REPLY_TO`) | Railway `worker` | Remetente dos emails |
| Servidor SMTP | Não | `SMTP_HOST=mail.ultimalinha.ao`, `SMTP_PORT=465`, `SMTP_SECURE=true` | Railway `worker` | Envio |
| Utilizador SMTP | Não | `SMTP_USER` | Railway `worker` | Autenticação |
| **Palavra-passe SMTP** | **Sim** | `SMTP_PASSWORD` | **Só no painel da Railway** | Autenticação |
| URLs públicas | Não | `UL_CLIENT_URL=https://platform.ultimalinha.ao`, `UL_CONSOLE_URL=https://console.ultimalinha.ao` | Vercel e Railway | Links nos emails |

Sem `SMTP_HOST`, os emails ficam na fila (`email_outbox`) e nada se perde. Ao configurar mais tarde, o worker
envia os que estão pendentes.

**DNS do email (já verificado a 13/10):** MX na AngoWeb, SPF inclui o servidor AngoWeb, DKIM `default`
publicado, DMARC `p=none`. Ao enviar pela própria caixa AngoWeb, a entrega fica alinhada.

**Separado, no dashboard do Supabase:** SMTP próprio para os emails de **confirmação de conta** (Auth →
SMTP). Sem isto, o Supabase só envia cerca de 2 emails por hora e os registos de clientes reais falham.

## 2. Como verificar sem segredos (staging ou produção autorizada)

1. `GET /v1/organizations/:org/contracts/:id/payment-instructions` como OWNER de um contrato de teste
   pendente: aparecem o banco, o titular, o IBAN e o número Express configurados.
2. Enviar um PDF de teste: o financeiro recebe "Comprovativo recebido — UL-C-…". Nos logs do worker aparece
   `email.delivery` com `sent ≥ 1`, sem endereços.
3. Convidar um email de teste: chega "Convite para a equipa de …".

## 3. Papel `PLATFORM_FINANCE` (preparado, sem membros)

- **Permissões, confirmadas por teste** (`tests/renewals-proofs.test.ts`, "PLATFORM_FINANCE holds exactly…"):
  - `platform.commercial.read`;
  - `platform.payment.confirm`;
  - `platform.payment_proof.read`.
- **Pode:** ler contratos, listar e abrir comprovativos, confirmar e rejeitar pagamentos.
- **Recebe 403 em:**
  - ativar e cancelar contratos;
  - criar propostas;
  - gerir administradores e credenciais;
  - suspender organizações;
  - aplicar renovações.
- **Antes de atribuir a alguém:**
  1. A atribuição já é possível pela API: `POST /v1/platform/admins` com `{ userId, platformRoleKey:
     "PLATFORM_FINANCE" }`, por um PLATFORM_ADMIN com `platform.platform_admin.manage`, e fica auditada.
     Confirmar se a UL Console já permite escolher o papel; se não, fazer pela API.
  2. `GET /v1/platform/me` devolve `platformAdmin: true` para **qualquer** papel da plataforma. A UL Console
     deixaria entrar um membro de finanças, que veria ações que depois dão 403. Ajustar a Console para mostrar
     só o que o papel permite (trabalho pequeno, quando for preciso).

## 4. Proteção dos comprovativos PDF

| Medida | Onde |
|---|---|
| Só o OWNER da organização envia, e só para um contrato ou renovação da sua organização com pagamento pendente | Rotas da UL Client + `resolveTarget` |
| Tipo `application/pdf` obrigatório, assinatura `%PDF-` verificada, até 4 MB, no máximo 5 à espera de revisão, limite de 20 envios por 10 min por utilizador | `paymentProofs.service.ts`, rota |
| Guardados na BD (`payment_proof_files`, bytea), **fora** da Data API do Supabase (RLS sem políticas, `REVOKE` para anon/authenticated), imutáveis por trigger | Migração 0027 |
| Abrir o PDF exige `platform.payment_proof.read`; cada abertura é **auditada** (`platform.commercial.payment_proof.read`) | Rota da plataforma |
| Download com `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`: nunca é mostrado inline na origem da API | Rota da plataforma |
| O comprovativo **não confirma nada**: só um administrador (ou a integração) regista o pagamento | Serviço de pagamentos |
| Os emails de aviso não levam o PDF nem dados pessoais do cliente | Modelos de email |

**Limites conhecidos (a decidir):**
- não há análise antivírus dos PDFs; o download como anexo reduz o risco;
- não há prazo de conservação nem eliminação (ver a lista jurídica §6);
- o cliente não pode descarregar de novo o próprio PDF (só vê os metadados).
