---
name: update-upstream
description: Atualiza a main deste fork com upstream/main, resolve conflitos e adapta a integração com o T3 Code preservando o contrato público e os plugins existentes. Use para executar uma sincronização com upstream; uma consulta de novidades ou pedido para editar esta skill não inicia a sincronização.
---

# Atualizar o fork com upstream

Integre upstream/main à main do fork, valide e publique em origin/main. A invocação
para executar a atualização autoriza esse fluxo completo, sem pedir confirmação a
cada etapa. Respeite pedidos de somente análise ou trabalho local. Não publique no
upstream, não crie PR sem pedido e não atualize a instalação em uso.

## Limite de compatibilidade

T3 original ↔ API pública ↔ plugin.

O upstream pode mudar o T3 Code. Adapte o host e a implementação da API para
absorver essas mudanças, mantendo o mesmo contrato visto pelos plugins.

- Não altere o contrato público, nem mesmo para adicionar recursos, nesta atualização.
  Evoluir esse contrato exige um pedido separado de Gabriel para funcionalidade de plugins.
- Preserve assinaturas, exports, versões de API/UI, manifests aceitos, formatos,
  erros observáveis, permissões, lifecycle, cancelamento, observação e semântica das
  operações. Compilar com os mesmos tipos não basta para provar compatibilidade.
- Não modifique fontes, manifests, dependências ou testes dos plugins para fazê-los
  aceitar o novo host. Não exija reinstalação, migração ou reconstrução dos plugins
  como solução para uma incompatibilidade introduzida pela atualização.
- Corrija a adaptação na camada do T3 Code ou na implementação da API, preservando
  as funcionalidades do fork. Não substitua mudanças do fork indiscriminadamente
  pelo upstream nem esconda quebras desativando plugins ou enfraquecendo testes.
- Se não houver solução que mantenha o contrato, preserve o trabalho na branch
  de integração e explique a incompatibilidade concreta. Não publique uma main
  quebrada nem invente uma nova versão do contrato para contornar o problema.

## Preparar e escolher a estratégia

1. Leia AGENTS.md e CLAUDE.md aplicáveis. Confira status, remotes, worktrees e
   operações Git em andamento. Preserve alterações alheias; não use reset, clean,
   stash automático ou commits que capturem arquivos não relacionados.
2. Faça fetch de main em upstream e origin. Registre os SHAs de main, origin/main
   e upstream/main e fixe o SHA upstream alvo para esta execução. Confira a
   divergência, o ancestral comum e as mudanças próprias do fork. Não assuma que
   o nome de um remote garante que ele aponta para o repositório correto.
3. Trabalhe numa branch de integração em um worktree limpo ao lado do checkout,
   conforme as instruções locais. Comece de uma base que contenha a main local e
   a main publicada; investigue divergências antes de incorporá-las. Preserve o
   checkout do usuário. Se já houver uma integração desta tarefa, inspecione e
   retome em vez de duplicar o trabalho.
4. Prefira um merge do SHA upstream alvo completo, preservando a ancestralidade.
   Use fetch + merge explícito em vez de um pull que dependa da configuração de
   rebase ou misture a branch errada. A quantidade de commits, sozinha, não
   justifica fragmentação. Não faça squash, rebase da main publicada ou uma série
   de cherry-picks para simular a sincronização.
5. Integre por marcos apenas quando uma migração ou refatoração identificada
   permitir resolver e validar dependências separadamente. Escolha SHAs ancestrais
   do alvo em ordem, preferencialmente no first-parent, e justifique os marcos.
   O resultado só está completo quando inclui todo o SHA upstream alvo.

## Inventariar e integrar

Antes do merge, registre a base do fork e o comportamento público que deve
permanecer. Confira os caminhos atuais; estes são os pontos de partida:

- `packages/plugin-api/src/index.ts`: contrato fornecido ao plugin, incluindo versões.
- `packages/plugin-api/package.json`: exports e identidade do pacote.
- `packages/contracts/src/plugins.ts`: schemas de integração; diferencie transporte
  interno de formatos e comportamento expostos ao plugin.
- `apps/server/src/plugins/`: host, ativação e validação de operações.
- `apps/server/src/mcp/toolkits/plugins/`: acesso por agentes.
- `packages/client-runtime/src/state/plugins.ts`, `apps/web/src/state/plugins.ts`,
  `apps/web/src/components/plugins/` e a rota de Settings: integração dos clientes.
- `plugins/`: consumidores existentes, especialmente `obsidian-tickets`, que devem
  continuar funcionando sem alterações.

Leia também os pontos de registro, RPC, permissões, persistência e lifecycle que
esses arquivos usam. Identifique o que o upstream mudou nessas dependências.
Mantenha evidências temporárias fora do repositório e dados de teste isolados.

Faça o merge, resolva os conflitos entendendo as duas versões e adapte as chamadas
internas necessárias. Revise também os merges automáticos: ausência de conflito
textual não garante que um componente, serviço, evento ou sequência de lifecycle
continue compatível. Evite novas abstrações sem necessidade concreta.

## Provar compatibilidade

Siga os comandos e limites de validação do AGENTS.md vigente, incluindo
`scripts/local-validation.py`, setup e limpeza de recursos. Não rode checks globais.

- Compare a API pública e os arquivos dos plugins com a base anterior à integração.
  Explique qualquer mudança interna em arquivos compartilhados e confirme que não
  alterou o contrato. Não aceite mudança de versão como prova de compatibilidade.
- Execute os testes focados existentes do host, ativação, schemas, handlers MCP e
  plugins afetados. Para uma regressão de lógica encontrada, reproduza a falha
  antes da correção e estenda o teste na camada mais baixa que a demonstra.
- Valide tipos dos pacotes afetados e dependentes e execute `vp run check:changed`
  antes de publicar. Confira o intervalo coberto pelo comando: um merge já
  commitado ou uma árvore limpa não pode fazer a validação ignorar a integração.
- Use `test-t3-app` para uma passagem integrada com dados isolados e o plugin
  existente, sem editar seu pacote. Quando houver artefato anterior disponível,
  use-o para verificar que o novo host aceita o mesmo plugin. Cubra ativação,
  contribuições de UI, queries/commands, atualização de views e desativação nos
  caminhos atingidos; verifique dados persistidos quando o host correspondente mudou.
- Considere entradas alternativas, desktop, mobile, providers, MCP, permissões e
  conexões remotas conforme o impacto. Não declare suporte de uma superfície que
  o projeto ainda não oferece nem apresente execução não realizada como validada.
- Leia `evals/README.md` se a integração alterar texto voltado ao modelo e execute
  os casos aplicáveis. Não afrouxe verificações para conseguir um resultado verde.

Se uma verificação necessária falhar ou estiver indisponível, registre a evidência
e deixe a integração pendente; não declare sucesso nem publique como concluída.
Encerre servidores e abas da tarefa assim que terminar a validação.

## Publicar e encerrar

Após validar, faça commits somente do trabalho desta integração. Reconfira
origin/main e a main local: se avançaram, incorpore as mudanças e revalide o que
foi afetado. Não force push nem sobrescreva trabalho concorrente.

Integre o resultado validado à main e publique em origin/main. Se o checkout da
main tiver mudanças locais, não as mova ou descarte automaticamente. Use uma
atualização segura que as preserve; se isso não for possível, deixe a branch
validada pronta e informe exatamente o que impede concluir a integração local.
Não confunda publicação remota com atualização do checkout local.

Faça fetch de origin/main e confirme por ancestralidade que contém o SHA upstream
alvo e os commits de adaptação. Só então remova worktree e branch temporários da
tarefa, preservando qualquer trabalho não publicado. Se houver ticket explícito,
registre evidências e entrega pelo fluxo de tickets aplicável.

Informe: alvo integrado, adaptações feitas, evidências de contrato e plugins
preservados, verificações e limitações, estado da main local e de origin/main e
limpeza dos recursos. Se o alvo já estava integrado e não havia trabalho pendente,
informe isso sem criar commits vazios.
