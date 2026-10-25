# Inventário de credenciais (`GET /v1/platform/credentials/inventory`)

> 23/10/2026, auditoria de credenciais da Na Pista. Implementado e testado só localmente (branch
> `feature/credential-inventory`), sem nada em produção.

**Acesso.** O pedido exige um PLATFORM_ADMIN humano com `platform.credential.read`: é a mesma permissão de
`GET /platform/credentials` e não foi criada nenhuma permissão nova. Chaves de serviço e papéis de organização
recebem 403; um pedido anónimo recebe 401. Cada leitura fica auditada como `platform.credential.inventory_read`,
com o ator, os filtros e o número de itens devolvidos.

**Filtros:** `applicationKey`, `organizationId`, `credentialClass`, `status` (`ACTIVE`, `PENDING`, `REVOKED`,
`EXPIRED`), `scope`, `limit` (≤ 100, por omissão 50) e `cursor`. A paginação é keyset `(createdAt, id)`, do mais
recente para o mais antigo. Parâmetros desconhecidos dão 400.

**Cada item devolve:**
- `keyIdPrefix`, mascarado;
- `application`, `credentialClass`, `purpose`;
- `status` efetivo (`EXPIRED` derivado de `expiresAt`), `createdAt`, `expiresAt`, `revokedAt`;
- `scopes`;
- `organization`: `id`, `name`, `status` e `activeApplications`;
- `consumer: null` e `lastUsedAt: null`, porque estes dados **não são registados**.

**O que nunca devolve:** o segredo, o hash do segredo e o id completo da chave. A revogação continua nas rotas
existentes.

**Lacunas declaradas em cada resposta (`knowledge`):**
- quem usa a chave não é registado;
- o último uso não é registado;
- não é possível saber se uma chave ainda está em uso.

**Custo:** constante por pedido, seja qual for o tamanho da página. São 8 idas à base, das quais 4 de autenticação
e autorização, 3 do inventário (página, scopes em lote, acessos em lote) e 1 de auditoria. Nenhum outro pedido é
afetado.

**Exemplo de consulta de exposição:** encontrar chaves de outra aplicação com `catalog.read` em organizações que têm
Na Pista:
`?scope=catalog.read&status=ACTIVE`, depois manter os itens com `application ≠ NA_PISTA` e `NA_PISTA` em
`organization.activeApplications`.
