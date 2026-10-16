# Ciclo completo do cliente — estado verificável

> 16/10/2026. Objetivo: uma empresa percorre, de forma segura,
> **conhecer a oferta → criar a organização → contratar → aceitar os termos → pagar → obter acesso à Na Pista →
> gerir a operação → renovar ou terminar.**
> Evidência = testes executados nesta data, todos locais (nada em produção).
>
> Siglas das evidências:
> - **E2E** — `~/.ul-dev/ul-auth-local/harness/e2e-commercial.mjs` (138 verificações), browser real com
>   Supabase Auth local, UL Platform, UL Client, UL Console e worker;
> - **LIM** — `~/.ul-dev/limits-e2e/limits.mjs` (13), UL Platform e Na Pista com credencial gerida;
> - **UT** — suites de cada repositório.

| # | Etapa | O que existe | Evidência | Falta (bloqueia ✋ / melhora ➕) |
|---|---|---|---|---|
| 1 | **Conhecer a oferta** | Landing da Na Pista (produto e módulos; botões para "começar" e login, configuráveis). Página "Contratar plano" na UL Client: preço, período, limites, termos, "pagamento antes da ativação" | E2E SS2–SS3 | ✋ A landing **não mostra o plano nem o preço**. A página de catálogo só aparece **depois** do registo e da criação da organização. ➕ Apontar o "começar" da landing para o registo da UL Client; publicar a oferta quando os valores forem aprovados. A landing da Na Pista não tem projeto Vercel |
| 2 | **Criar a organização** | Registo, confirmação de email, login, criação com Idempotency-Key, janela de 10/24 h, email verificado obrigatório | E2E A1–A7; Auth E2E 51/51 | ✋ SMTP próprio do Supabase Auth em produção (cerca de 2 emails/h sem ele) |
| 3 | **Contratar** | Self-service: o catálogo gera uma oferta congelada; o cliente não consegue mudar preço nem limites. Assistido: proposta da UL com link público | E2E SS3 (preço adulterado → 400), A8; UT self-service T15/T17 | ✋ Carregar o catálogo em produção (precisa de aprovação) |
| 4 | **Aceitar os termos** | Aceitação pelo OWNER verificado; hash da versão; consentimento aprovado para termos `np-tos-*`; o contrato fica a aguardar pagamento | E2E A9, SS4; UT acceptance | ✋ **Termos em rascunho** (lista jurídica). Sem termos aprovados, o plano aparece mas **não pode ser contratado**: está bloqueado de propósito |
| 5 | **Pagar** | Instruções (IBAN e Express configuráveis), envio do PDF, aviso ao financeiro, abertura auditada na Console, rejeição com motivo, confirmação manual (só transferência e Express, com recibo interno) ou por integração | E2E P1–P6, A10, SS5–SS6; UT T05–T10, T18–T20, concorrência e repetição | ✋ Dados IBAN/Express/financeiro e SMTP do worker. ➕ Faturação (lista jurídica §4) |
| 6 | **Obter acesso à Na Pista** | Ativação com as 3 condições; grant, subscrição e acesso; pedido de credencial gerida; a Na Pista recebe a credencial e responde; botão **"Abrir Na Pista"** (novo, `8729290`) | E2E A10/SS6–SS7; LIM C.* | ✋ **A Na Pista não está alojada** (proposta em `na-pista/docs/PRODUCTION-HOSTING-PROPOSAL.md`). ✋ `NEXT_PUBLIC_NA_PISTA_CONSOLE_URL` e a origem no CORS e no Supabase |
| 7 | **Gerir a operação** | Na Pista: catálogo, stock, pedidos, clientes, serviços, marcações, painel. Equipa: convites por email (UL Client e Na Pista Console), limite de 5 utilizadores, suspensão. Limite de 500 produtos | E2E I1–I6; LIM L1–L5; UT Na Pista 269/247, Console 172 | ➕ Relatórios avançados fora do piloto (decidido). ➕ Suporte prioritário por definir |
| 8a | **Renovar** | Autorização expressa e revogável; o worker prepara o período 7 dias antes; email com IBAN e referência `-R1`; PDF; confirmação na Console; prolonga uma vez | E2E R1–R5; UT T11–T13, caducidade, suspensão, concorrência | ✋ Validação jurídica da renovação (A7, texto v1) |
| 8b | **Terminar** | Retirar a renovação faz o acesso terminar no fim do período; expiração persistida pelo worker (grant, subscrição e acesso revogados); a Na Pista recusa com 403 `ENTITLEMENT_REQUIRED`; terminação pela UL com revogação imediata | E2E SS8, T1, R5; LIM E1; UT T14 | ➕ Não há cancelamento antecipado pelo cliente nem reembolso: decisão comercial e jurídica. ➕ **Não há exportação de dados** no fim (A10/B9) |

## Resumo

- **Pronto e provado localmente:** etapas 2–8, ponta a ponta, com login real e as duas aplicações (UL
  Platform e Na Pista) ligadas pela credencial gerida.
- **Impede clientes reais hoje:**
  1. alojamento da Na Pista;
  2. termos aprovados juridicamente;
  3. dados de pagamento e SMTP;
  4. SMTP do Supabase Auth;
  5. publicação autorizada (migrações 0022–0028, merges, carregamento do catálogo).
- **Melhorias recomendadas antes de escalar:**
  - oferta pública com preço;
  - exportação de dados no fim;
  - faturação;
  - suporte definido.
