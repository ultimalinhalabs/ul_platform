# Lista consolidada para revisão jurídica e contratual — piloto Na Pista Crescimento

> 16/10/2026. O plano **Na Pista Crescimento (25 000 Kz / 30 dias, 500 produtos, 5 utilizadores)** está como
> **valores propostos, não aprovados para produção.** Nada foi carregado nem aprovado em produção.
> Texto em revisão: `docs/commercial/terms/np-tos-001-draft.md` (Anexo A + Anexo B, transcritos tal como estão
> na especificação). O script `scripts/load-na-pista-growth.ts` **recusa aprovar** enquanto o texto tiver as
> marcas assinaladas abaixo.

## 1. Termos padrão (Anexo A)

| # | Cláusula | O que falta ou tem de ser decidido |
|---|---|---|
| A0 | Cabeçalho | Remover "RASCUNHO PARA REVISÃO COMERCIAL E JURÍDICA…" quando aprovado |
| A1 | Partes — Prestador | O texto diz "Airton Alexandre, Lda." e "identificação legal a completar". O registo usado nos contratos (`legalIdentity.ts`, a partir do Pacto e do NIF) diz **"AIRTON ALEXANDRE - PRESTAÇÃO DE SERVIÇOS, (SU), LDA.", NIF 5002819481, sede em Luanda, Maianga, Cassenda, Rua 3, casa 13; gerente único.** Confirmar a denominação a usar e a relação da marca Na Pista / Última Linha com a sociedade |
| A1 | Partes — Cliente | Campos `[denominação legal]`, `[identificação fiscal/legal]`, `[endereço]`, `[nome/função]`, `[ID]`. Decidir se a cláusula passa a remeter para "a organização identificada no resumo contratual". **Lacuna de produto:** a contratação self-service **não recolhe o NIF nem a morada** do cliente (o campo NIF é opcional e só existe no canal assistido). É obrigatório? |
| A3 | Plano, preço, período | "Limites propostos… sujeitos a confirmação técnica". A confirmação técnica está feita (500 produtos aplicados pela Na Pista e 5 utilizadores pela UL Platform; testes ponta a ponta). Falta a **aprovação comercial final** do preço e dos limites. Indicar se os 25 000 Kz **incluem IVA** |
| A5/A6 | Ativação e pagamento | Coerente com o sistema: organização ativa + termos + pagamento confirmado por administrador ou integração. Confirmar a redação "pagamento integral" (não há pagamentos parciais) |
| A7 | Renovação | Validar o mecanismo implementado: autorização expressa e revogável a qualquer momento; o período seguinte é preparado 7 dias antes do fim, com pagamento pendente; caduca sem pagamento. Definir **avisos prévios**, **prazo de retirada** e **tratamento de falhas de pagamento**. Rever o texto de autorização v1 (§3) |
| A8 | Obrigações do Cliente | Sem campos em falta. Confirmar a redação |
| A9 | Obrigações do Prestador | Remete para "políticas aprovadas e comunicadas" de disponibilidade, suporte, manutenção, exportação e conservação. **Estas políticas não existem** |
| A10 | Duração, expiração, cancelamento | Definir a **política de reembolso** (inexistente), a conservação e exportação dos dados depois do fim, e o que significa "cancelamento" (hoje o cliente retira a renovação e o acesso termina no fim do período; a terminação antecipada é só feita pela UL) |
| A11 | Dados e confidencialidade | "devem ser definidos antes do uso real". Definir papéis (a UL/Na Pista como **subcontratante** dos dados dos clientes finais da empresa), subcontratantes técnicos (Supabase, Vercel, Railway, AngoWeb), **transferência internacional** (servidores fora de Angola), conformidade com a Lei n.º 22/11 (Proteção de Dados Pessoais) e eventual comunicação à APD |
| A12 | Alterações | Coerente: cada contrato guarda a versão e o hash aceites |
| A13 | Lei e conflitos | "serão definidas por assessoria jurídica": lei aplicável, foro ou arbitragem, identificação legal completa, cláusulas obrigatórias |
| A14 | Resumo contratual | Os campos `[…]` são preenchidos pela plataforma (a página do contrato mostra cliente, plano, preço, período, versão dos termos, n.º do contrato, aceitante e data, estado do pagamento e ativação). Confirmar se a **referência do pagamento** tem de aparecer ao cliente (hoje aparece o estado e a data) |

## 2. Acordo de participação no piloto (Anexo B)

| # | Cláusula | O que falta ou tem de ser decidido |
|---|---|---|
| B0 | Cabeçalho | Remover "RASCUNHO…" quando aprovado |
| B1 | Partes | `[Cliente]`, `[nome/função]`, com a mesma questão do A1 |
| B2 | Preço | "confirmado por administrador autorizado da UL". Alinhar com o A5 (também por integração autorizada) |
| B4 | Natureza experimental | Rever a limitação de responsabilidade face à lei angolana |
| B6 | Suporte e feedback | "Canal, horário e prazo… serão definidos no resumo". Definir o **suporte prioritário** prometido no plano (canal, horário, prazo) |
| B7 | Dados e marketing | Consentimento separado para nome, marca e testemunhos (não há fluxo no sistema; documento à parte) |
| B9 | Fim do piloto | Exportação e conservação: tal como no A10 |
| B10 | Lei e disposições finais | Identificação legal, lei, conflitos, proteção de dados e cláusulas obrigatórias por validar |
| B11 | Resumo e aceitação | Campos preenchidos pela plataforma |

## 3. Textos de consentimento

| Texto | Estado | Ação |
|---|---|---|
| Aceitação: "Declaro que tenho poderes… só é ativado após a confirmação do pagamento." (`consent.ts`, v1, só para termos `np-tos-*`) | Aprovado pelo dono a 15/10/2026 | Validação jurídica recomendada |
| Autorização de renovação (`renewalConsentText`, v1) | **Não aprovado** | Revisão jurídica (§A7). Mudar o texto cria uma nova versão; os registos passados não mudam |

## 4. Fiscal e faturação

- A UL Platform **não emite faturas nem recibos**. Quem emite a **fatura/recibo** de cada pagamento, com que
  software certificado (requisitos da AGT) e em que prazo?
- Tratamento do **IVA** no preço (incluído ou acrescido) e nos textos.
- NIF do cliente: obrigatório para faturar? Hoje não é recolhido no self-service (ver A1).

## 5. Conteúdo comercial

- O plano é vendido **sem relatórios avançados** (decisão de 15/10). A especificação e o resumo ainda falam de
  "relatórios avançados" e "visão consolidada". Substituir por "painel operacional".
- "Suporte prioritário durante o piloto" precisa de definição (B6).

## 6. Políticas da plataforma (não existem)

- Termos de utilização da conta Última Linha e política de privacidade (ligadas no registo da UL Client).
- Política de conservação de dados, incluindo os **comprovativos PDF**: hoje são guardados de forma imutável
  e sem prazo de eliminação. Definir quanto tempo se guardam.
- Aviso de cookies, se aplicável (as apps usam cookies de sessão).

## 7. Pedidos ao jurista (resumo)

1. Texto final dos Anexos A e B, sem marcas de rascunho, com a identificação legal e as cláusulas A11, A13 e B10.
2. Política de reembolso, cancelamento, avisos de renovação e falhas de pagamento.
3. Proteção de dados: papéis, subcontratantes, transferência internacional, APD.
4. Validação dos dois textos de consentimento.
5. Faturação, IVA e NIF do cliente (com o contabilista).
6. Termos de utilização da conta e política de privacidade.
