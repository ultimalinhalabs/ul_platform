/**
 * Migration 0028 — the transactional email texts (Portuguese, pt-AO). Plain
 * text is the source; the HTML is the same text, escaped, with the link as a
 * button. Links point to the UL apps and never carry a secret: an invitation
 * is bound to the invited, verified email; contract pages require the OWNER's
 * session.
 */
export interface EmailMessage {
  subject: string;
  text: string;
  html?: string;
}

const ROLE_LABELS: Record<string, string> = { OWNER: "Proprietário", ADMIN: "Administrador", MANAGER: "Gestor", STAFF: "Colaborador" };
export const roleLabel = (key: string) => ROLE_LABELS[key] ?? key;

const TIME_ZONE = "Africa/Luanda";
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-PT", { day: "numeric", month: "long", year: "numeric", timeZone: TIME_ZONE }).format(date);
}

/** "25 000,00 Kz" from minor units (AOA has two decimals). */
export function formatMoney(amountMinor: bigint | string, currency: string): string {
  const minor = BigInt(amountMinor);
  const units = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const cents = (minor % 100n).toString().padStart(2, "0");
  return currency === "AOA" ? `${units},${cents} Kz` : `${units},${cents} ${currency}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function render(subject: string, paragraphs: string[], action?: { label: string; url: string }): EmailMessage {
  const footer = "Última Linha — esta mensagem foi enviada automaticamente. Se não esperava recebê-la, pode ignorá-la.";
  const text = [...paragraphs, ...(action ? [`${action.label}: ${action.url}`] : []), "", footer].join("\n\n");
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1E1E1E;max-width:560px">`,
    ...paragraphs.map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`),
    action
      ? `<p style="margin:20px 0"><a href="${escapeHtml(action.url)}" style="background:#1E1E1E;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p><p style="margin:0 0 14px;font-size:13px;color:#555">${escapeHtml(action.url)}</p>`
      : "",
    `<p style="margin:24px 0 0;font-size:12px;color:#777">${escapeHtml(footer)}</p>`,
    `</div>`,
  ].join("");
  return { subject, text, html };
}

export function invitationEmail(input: { organizationName: string; roleKey: string; expiresAt: Date; acceptUrl: string }): EmailMessage {
  return render(
    `Convite para a equipa de ${input.organizationName}`,
    [
      "Olá,",
      `Foi convidado para fazer parte da equipa de ${input.organizationName} na Última Linha, como ${roleLabel(input.roleKey)}.`,
      "Para aceitar, entre (ou crie a sua conta) com este endereço de email, confirme-o e abra a página dos seus convites. O convite só pode ser aceite por quem tiver sessão iniciada com este email.",
      `O convite é válido até ${formatDate(input.expiresAt)}.`,
    ],
    { label: "Ver o convite", url: input.acceptUrl },
  );
}

export interface PaymentInstructionsText {
  bankTransfer?: { bankName?: string; accountHolder?: string; iban: string };
  multicaixaExpress?: { number: string };
}

function instructionLines(i: PaymentInstructionsText, reference: string): string[] {
  const lines: string[] = [`Referência a indicar no pagamento: ${reference}`];
  if (i.bankTransfer) {
    lines.push(
      [
        "Transferência bancária:",
        i.bankTransfer.bankName ? `Banco: ${i.bankTransfer.bankName}` : null,
        i.bankTransfer.accountHolder ? `Titular: ${i.bankTransfer.accountHolder}` : null,
        `IBAN: ${i.bankTransfer.iban}`,
        `Descritivo: ${reference}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (i.multicaixaExpress) lines.push(`Multicaixa Express: ${i.multicaixaExpress.number} (indique ${reference})`);
  if (lines.length === 1) lines.push("Os dados de pagamento estão na página do contrato.");
  return lines;
}

export function renewalCreatedEmail(input: {
  organizationName: string;
  contractNumber: string;
  reference: string;
  amountMinor: bigint;
  currency: string;
  periodStartsAt: Date;
  periodEndsAt: Date;
  instructions: PaymentInstructionsText;
  contractUrl: string;
}): EmailMessage {
  return render(
    `Renovação do contrato ${input.contractNumber} — pagamento pendente`,
    [
      "Olá,",
      `Conforme a autorização de renovação de ${input.organizationName}, preparámos o próximo período do contrato ${input.contractNumber}: de ${formatDate(input.periodStartsAt)} a ${formatDate(input.periodEndsAt)}, no valor de ${formatMoney(input.amountMinor, input.currency)}.`,
      "Isto não é uma cobrança automática. O novo período só fica ativo depois de a Última Linha confirmar o pagamento. Sem pagamento confirmado até ao fim do período atual, o acesso termina nessa data.",
      ...instructionLines(input.instructions, input.reference),
      "Depois de pagar, envie o comprovativo em PDF na página do contrato. Pode também retirar a autorização de renovação nessa página; se esta renovação ainda não estiver paga, é cancelada.",
    ],
    { label: "Abrir o contrato", url: input.contractUrl },
  );
}

export function proofSubmittedEmail(input: { organizationName: string; contractNumber: string; renewalSequence: number | null; method: string; consoleUrl: string }): EmailMessage {
  const what = input.renewalSequence ? `renovação n.º ${input.renewalSequence} do contrato ${input.contractNumber}` : `contrato ${input.contractNumber}`;
  return render(
    `Comprovativo recebido — ${input.contractNumber}`,
    [
      `${input.organizationName} enviou um comprovativo de pagamento (${input.method === "multicaixa_express" ? "Multicaixa Express" : "transferência bancária"}) para a ${what}.`,
      "Verifique que o valor foi efetivamente recebido antes de confirmar o pagamento na UL Console. O comprovativo, por si só, não confirma nada.",
    ],
    { label: "Abrir na UL Console", url: input.consoleUrl },
  );
}

export function proofRejectedEmail(input: { organizationName: string; contractNumber: string; reason: string; contractUrl: string }): EmailMessage {
  return render(
    `Comprovativo não aceite — ${input.contractNumber}`,
    [
      "Olá,",
      `O comprovativo de pagamento enviado por ${input.organizationName} para o contrato ${input.contractNumber} não foi aceite.`,
      `Motivo: ${input.reason}`,
      "Pode enviar um novo comprovativo na página do contrato.",
    ],
    { label: "Abrir o contrato", url: input.contractUrl },
  );
}
