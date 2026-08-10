# Roadmap — próximos itens comprometidos

Ordem de implementação decidida. Cada item já foi ponderado no backlog e trouxe pra cá por razão explícita.
Regra: no máximo 5-7 itens comprometidos por vez — se algo entra aqui, algo sai (ou volta pro backlog).

Convenções:
- **Custo:** S (≤ 1 dia) · M (2-5 dias) · L (semana +)
- **Por que agora:** a razão explícita — evita entrar por impulso

---

## Fila comprometida

### 1. Charts/tables mais agressivos no coach
- **Custo:** S
- **Por que agora:** os tools `render_chart` / `render_table` JÁ existem e são underused. Prompt tuning de meia hora vira o ativo mais visual do coach imediatamente. Willian mencionou que sente falta de comunicação visual e não sabia que já tinha.
- **Escopo:** editar `app.js` system prompt para "MANDATORY trigger" mais claro (comparações ≥ 2 categorias, séries temporais ≥ 3 pontos, listas de 3+ atributos). Verificar em produção que Erica dispara em uma pergunta comparativa.
- **Sai daqui quando:** telemetria mostra ≥1 chart ou table em 20%+ das respostas com mais de 2 números.

### 2. Emojis por default no tom da Erica
- **Custo:** S
- **Por que agora:** custo trivial, valor de comunicação humano alto. Willian pediu explicitamente ("as pessoas usam no WhatsApp"). Deve vir antes de imagens/GIFs.
- **Escopo:** persona prompt de cada framework recebe orientação — 1-2 emojis por turno, colocados nos beats emocionais (não decorativos). Erica leva mais que os coaches diretivos.
- **Sai daqui quando:** shipped + verificado no simulador que a voz da coach ficou humana sem virar cringe.

### 3. Admin de conteúdo (course + quiz + vector store) — nível apresentável
- **Custo:** M
- **Por que agora:** Eric vai pedir isso — ele é o dono do conteúdo pedagógico e precisa administrar sem tocar em CLI/Railway. O que existe hoje (`/admin/courses` list + editor markdown + botão re-index) começa a função, mas está **insatisfatório para mostrar**: sem preview, sem separação clara entre course markdown e quiz Q&A, sem upload de arquivo (docx/pdf), sem visão de "última vez que rodou re-index e quantos arquivos", sem edição de quiz feedback estruturado, sem sanidade que confirme "essa mudança já chegou à Erica em produção".
- **Escopo (o que faz virar apresentável para Eric):**
  - Preview lado-a-lado do markdown enquanto edita
  - Upload de `.docx` / `.md` como source → converte + faz overlay (Eric não vive em markdown)
  - Editor específico de quiz (perguntas, opções ✓/✗, feedback correto/incorreto) em vez de só um textarea
  - Painel "sync status" no topo da lista: última re-index com timestamp, contagem de arquivos, indicação se overlay é diferente do que está no vector store agora
  - Diff visual overlay vs default por unidade
  - Delete/rename operações claras
  - Undo (revert to previous overlay version) — usa audit log
- **Sai daqui quando:** Eric consegue subir uma docx nova, editar quiz feedback, re-indexar e ver a Erica respondendo com o novo conteúdo — tudo sem ajuda.

### 4. Bug: widgets do co-worker somem no reload
- **Custo:** S
- **Por que agora:** confirmado por Willian. Degradação de confiança no Studio já na primeira vez que o usuário recarrega a página com histórico do co-worker aberto — todo insight visual (chart/table) vira transiente. Enquanto não fixar, o co-worker rico parece um chat comum na segunda visita.
- **Escopo:**
  - Verificar como o histórico do co-worker está sendo serializado no armazenamento (localStorage / sessionStorage / server) — hipótese: array de objetos `{role, content}` só com texto, perdendo o tipo de bloco.
  - Se blocos são só strings, migrar pro modelo `{type: 'text' | 'chart' | 'table', data}` e persistir dessa forma. Hidratar cada block no page-load chamando o mesmo renderer que criou originalmente.
  - Se blocos já têm tipo mas o renderer não é chamado no boot, adicionar hook de hidratação no mount da página.
  - Testar caminho completo: co-worker renderiza chart → reload → chart continua visível idêntico.
- **Sai daqui quando:** reload da página do Studio preserva 100% dos widgets (chart + table) em pelo menos 3 sessões diferentes do volume.

### 5. Visibilidade da camada de raciocínio (Erica) — admin + simulador
- **Custo:** S
- **Por que agora:** era uma das prioridades declaradas pra essa versão. Hoje a infra do `deepThink` já pede `reasoning.effort: 'medium'` mas NÃO pede `summary: 'auto'`, e nada é persistido em session log. Resultado: admin abre `/admin/sessions/:id` e não vê nenhum reasoning da Erica — só o reasoning do próprio co-worker do Studio (que é outra coisa). Falta pouco código pra fechar o loop.
- **Escopo:**
  - `lib/vectorStore.deepThink()`: adicionar `summary: 'auto'` no bloco `reasoning`. Retornar o summary junto com `reasoning` + `answer` no payload.
  - `/api/deep-think` no server: propagar o summary de volta pro cliente.
  - Client (app.js): quando recebe deep_think result, POSTa `session-log { kind: 'event', name: 'reasoning_summary', meta: { source: 'deep_think', summary, effort, model } }`. Não bloquear resposta.
  - Client (app.js): tentar `reasoning: { effort: 'medium', summary: 'auto' }` no `session.update` do Realtime. Escutar reasoning nos `response.done` events; se aparecer, POSTa `session-log { kind: 'event', name: 'reasoning_summary', meta: { source: 'realtime', summary } }`. Se a API rejeitar o config, log warning e não quebrar o coach.
  - `lib/sessionLog`: reconhecer `event.name === 'reasoning_summary'` sem cap de tamanho (ou mover pra arquivo separado dedup se ficar grande, mesmo padrão dos prompt snapshots).
  - `/admin/sessions/:id`: renderizar bloco expansível "Reasoning ▸" na linha do tool_call (deep_think) OU do turn (Realtime), com destaque visual distinto — borda âmbar, ícone 🧠, source label ("deep_think" vs "realtime") visível.
  - Simulador (`/admin/simulator`): quando rodar pipeline completo com deep_think ativado, mostrar o reasoning summary num painel lateral abaixo da resposta simulada.
  - `/admin/metrics`: adicionar `% de sessões com reasoning capturado` e `avg summary length` na tabela existente.
- **NÃO faz:** expor reasoning pro usuário final (botão "por que você disse isso?"). Só admin. Também não altera `reasoning.effort` — fica em `medium`.
- **Sai daqui quando:** Willian abre 3 sessões recentes no admin e vê reasoning summary da Erica renderizado em pelo menos 1 turn de cada; simulador com pipeline completo mostra reasoning ao lado da resposta.

### 6. Interação contextual em nível de elemento
- **Custo:** M
- **Por que agora:** o simulador já mostra o cenário site-embeds-coach funcionando. Prova de conceito madura. Próximo salto de valor é a coach saber *o que o usuário está olhando/marcando na página*, não só a página inteira.
- **Escopo:** bridge.js escuta `selectionchange` / `focusin` / click em elementos com `data-erica-hint` no site → posta `PAGE_ELEMENT_FOCUS` para o iframe. Coach system prompt aprende a citar o elemento marcado.
- **Sai daqui quando:** no simulador (quiz-report host), user seleciona uma linha da tabela de scores e Erica responde citando aquela linha especificamente.

---

## Removido / rejeitado (histórico de decisão)

- **Upload de imagem pelo usuário no coach** — não vai. Uso não claro no contexto individual, decidido dia 2026-08-09.
- **GIFs / memes** — voltou pro backlog: só depois de emojis + imagens terem métricas positivas.
- **Módulo extraído do co-worker do Studio** — recusado agora, acoplamento com sessionLog/audit/contentStore alto, valor de reuso não claro.
- **V2 rotate keys + migração pra env-var** — não pertence a este projeto (é v2 no Wix). Willian trata direto.
- **Robustecer barge-in de voz** — barge-in funciona. Fica como wishlist no backlog só se voltar a falhar.

---

_Última revisão: 2026-08-09._
