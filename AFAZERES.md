# Roadmap — próximos itens comprometidos

Ordem de implementação decidida. Cada item já foi ponderado no backlog e trouxe pra cá por razão explícita.
Regra: no máximo 5-7 itens comprometidos por vez — se algo entra aqui, algo sai (ou volta pro backlog).

_Status batch 2026-08-10 (Willian sprint "faz 1,2,3,5,6"): #1 shipped e verificado, #2 shipped, #4 já resolvido no batch anterior, #5 shipped (com fallback pra org não verificada — ver commit 8297371), #3 primeira camada shipped (nav + Real Time + hubs), #6 shipped e verificado ponta-a-ponta no simulador (score row → PAGE_ELEMENT_FOCUS → coach prompt injection)._

_Boost 2026-08-11 (pré-call Eric): Boost A "Coach identity card" na Home shipado — mostra persona ativa, chars por bloco do system prompt (measured/reported/estimated), Real Time channels, contagens semantic store. Boost B "Session bookmarks + notas" shipado — ⭐/⚠️ + nota na lista de sessões, filtros All/Marked/Exemplars/Problems, bloco na Home. Ambos verificados live. Commits c44fdf1, 7019a3c, 2afcdc1, 6cdbb82._

_Pós-review Willian 2026-08-11 (3 ondas antes da call): Onda 1 Sessions QoL — ⭐/⚠️ no detail, semantic labels na lista + Home, human date format, fix STORE_MESSAGE_TEXT=redacted skip pra sessões synthetic (51b0409). Onda 2 promoted editors — 3 áreas Injected Data funcionais (canonical courses/quizzes/safety rules) com persistência + system prompt preview + audit; Semantic Store ganhou Company + Website tiles com editor markdown completo (10011c8). Onda 3 polish do card — tooltips por bloco, rename "Knowledge grounding" → "Coach tool + visual widget rules", "Wix preparation preamble" → "External prep from Wix (rules + user report)", notas expandidas explicando primacy/recency (0502bc1). Fix bônus: genSessions destructure bug + endpoint /api/admin/dev/purge-empty-sessions pra limpeza (a76c53e, 5e20505)._

_Promoção pós-call Eric 2026-08-11 (feedback assimilado do doc `2026-08-10-eric-transcript.md`): promovidos 4 itens curtos que endereçam os dois defeitos que Eric viveu no demo (echo chamber + wrong-link) + fix persona pacing que ele confirmou como config._

Convenções:
- **Custo:** S (≤ 1 dia) · M (2-5 dias) · L (semana +)
- **Por que agora:** a razão explícita — evita entrar por impulso

---

## Fila comprometida

### 1. Fix echo chamber — page context é situational, source é o Semantic Store
- **Custo:** S
- **Por que agora:** Eric identificou como defeito principal do demo. *"This is living in an echo chamber. What you've done is you've distilled something to key points, and then you're asking her about the key points, you're showing the key points to the individual. She should have a wider scope of knowledge. She's going to be shallow."* O comportamento observado: coach responde do conteúdo destilado do report renderizado na página, ficando fluente e rasa ao mesmo tempo. Mesma forma da falha da conversa de crise no caso da conta apagada — profundidade da fonte é o fix, não tom.
- **Escopo:**
  - Editar a instrução no system prompt (`app.js`, bloco de PAGE CONTEXT injetado por `_syncPageContextIntoPrompt`) — hoje é `Ground your next reply in the following page context. Reference specific parts naturally`. Mudar pra algo tipo:
    ```
    Page context tells you WHERE the user is right now — nothing more.
    For SUBSTANCE, call search_knowledge against the semantic store
    (frameworks, courses, quizzes, company). Never source facts from
    the page. You may cross-reference the page ("what you see on
    the report says X") but the depth of your reply comes from
    the store, not from the page.
    ```
  - Reforçar no bloco de tools que `search_knowledge` é a fonte default, não fallback. Adicionar exemplo negativo ("do NOT answer from the report you can see").
  - Verificar em produção: repetir o cenário do demo (usuário no report EI, pergunta específica sobre self-regulation) — a Erica deve chamar `search_knowledge` ANTES de responder, e a resposta deve trazer conteúdo do framework, não do report.
- **NÃO faz:** não altera o canal `page_context` do Real Time (continua toggle ligado por default). Não bloqueia cross-reference com a página — só demove a página como fonte de substância.
- **Sai daqui quando:** telemetria mostra ≥80% das respostas em páginas de report chamam `search_knowledge` antes de responder (hoje é ~0 nas conversas do demo), e amostra manual de 5 sessões mostra que Erica cita framework/curso quando pergunta é sobre substância.

### 2. Popular competency frameworks
- **Custo:** S (mecânico) — o corpo do trabalho é escrever conteúdo semântico, não código
- **Por que agora:** Eric marcou como causa mecânica do echo chamber. Hoje 7 das 8 personas têm framework file vazio; só *Understanding Traits Skills* tem conteúdo real. Sem esse corpo semântico, `search_knowledge scope=frameworks` retorna pouco e a Erica responde da página (Item #1 acima falha se este não for feito). Sem os frameworks populados o fix do echo chamber não termina de fechar.
- **Escopo:**
  - Uma passada por framework file no `/admin/frameworks` — a estrutura já existe (competências, comportamentos, contra-exemplos). Preencher o corpo real de cada persona, mesmo que curto — melhor curto e verdadeiro que longo e genérico.
  - Ordem sugerida por peso na experiência do usuário: Supportive (Erica default) → Directive → Discovery → Empowering → resto.
  - Cada write vai automático pro overlay `/data/frameworks/`, então é ao vivo.
  - **Dependência estratégica:** decisão CP-01 (multi-persona vs Erica-única + 8 vozes) ainda em aberto. Se decidir "Erica única", o conteúdo semântico é um só, não 8×. Vale conversar com Eric ANTES de escrever 8 versões — talvez o trabalho seja escrever 1 framework rico + 7 stubs de "voz". Marcado no comment de CP-01 no IDEIAS.
- **NÃO faz:** não escreve framework do zero se Varsha for a autora natural desse conteúdo — colocar rascunho, marcar pra ela revisar. Não muda o vector store até re-indexar (endpoint já existe).
- **Sai daqui quando:** os 8 frameworks têm pelo menos 1000 chars de conteúdo próprio, `search_knowledge scope=frameworks` num tópico como "self-regulation" traz chunks de 3+ frameworks distintos, e o Item #1 (echo chamber fix) passa no seu critério de saída.

### 3. Popular canonical courses + canonical quizzes
- **Custo:** S
- **Por que agora:** Eric identificou wrong-link como defeito separado do echo chamber. Os editores Injected Data que shipei na Onda 2 pós-review estão no ar mas com as listas vazias. Sem populado, Erica não consegue relacionar nome, ID ou URL — inventa e alucina. Causa mecânica; fix mecânico.
- **Escopo:**
  - Extrair a lista canônica de cursos do `knowledge-base/courses/` (36 já existem) — cada um vira uma linha em `/admin/injected-data/canonical-courses` com `course_id`, `name`, `url` (a URL Wix real), `one_line` (10-15 palavras).
  - Mesmo com quizzes do `knowledge-base/quizzes/` (~20) — vira `/admin/injected-data/canonical-quizzes`.
  - URLs Wix reais podem ser puxadas do Wix dashboard ou de um export existente — se lista de URLs não tá em mãos, marcar `url` vazio e priorizar `name` + `one_line` (Erica ainda consegue citar o nome canonical, só não linka).
  - Depois de populado, `computeSystemPromptBlock('canonical-courses')` no `promptBudget` vai mostrar chars reais adicionados ao prompt — Home identity card deve refletir.
- **NÃO faz:** não inclui description longa nesses tiles (isso é semantic store, não injected data). Não wire-up ainda no boot do coach — precisa passar de "storage OK" pra "sistema prompt realmente inclui os blocks" (Item futuro, separado).
- **Sai daqui quando:** ambas as listas populadas na UI (contagem visível no hub) e a Erica em teste responde a "quais cursos vocês têm sobre X?" citando nomes canônicos + URLs corretas.

### 4. Fix persona pacing — "enough with the pauses"
- **Custo:** S (edit de persona file, sem código)
- **Por que agora:** Eric disse no demo *"that can all be changed by instructions and the configuration of the coach"* após ter que pedir "sê mais diretiva". Willian confirmou *"enough with the pauses"*. É config edit; deve subir imediatamente. Fica desconfortável demonstrar de novo com Erica pausando entre cada frase — dá impressão de coach lenta, não coach calma.
- **Escopo:**
  - Abrir `/admin/frameworks/framework_Supportive` no editor. Encontrar linhas que empurram pausa por default ("slow down", "take a breath", "let's pause") e reduzir a beats emocionais claros — não uso ambiental.
  - Adicionar diretiva: "acalma quando o usuário está em desregulação evidente (ansiedade, urgência, medo); mantém ritmo normal em conversas exploratórias ou de decisão pragmática".
  - Verificar no simulador com preset "Rita career decision" que Erica responde em ritmo normal, e com preset de crise/desregulação que ela ainda desacelera.
- **NÃO faz:** não muda outros personas (Directive/Discovery/etc — cada um tem seu ritmo próprio). Não mexe no VAD ou barge-in (aquilo é técnico do voice mode, não tom).
- **Sai daqui quando:** simulador mostra 3 conversas com preset "decisão pragmática" onde Erica não usa "let's pause" ou "take a breath" em turnos que não são crise.

### 5. Wire-up dos canonical blocks no system prompt
- **Custo:** S
- **Por que agora:** o storage está pronto e populado (55 canonical entries, 6.379 chars agregados) mas nenhum consumer chama `injectedDataStore.computeSystemPromptBlock`. Erica ainda não vê as listas — os link errors que Eric mencionou continuam abertos. Fechar o loop leva ~1h; sem isso as duas horas gastas no #3 ficaram só como demo de storage.
- **Escopo:**
  - No boot da preparation ou em `configureSession` (app.js), montar 3 blocks: canonical courses, canonical quizzes, safety rules (só regras `enabled`). Injetar depois do bloco de knowledge grounding, antes da language detection.
  - Cada bloco vem via `injectedDataStore.computeSystemPromptBlock(kind)`. Se retorno vazio, não injeta o header vazio.
  - Adicionar diretiva perto dos blocos: "Quando citar um curso ou quiz, use EXCLUSIVAMENTE o nome e URL destas listas canônicas. Nunca invente URL. Se URL vazio, cita só o nome e diz 'posso te mandar o link — verifica no sistema'."
  - Client-side `promptBudget` já reporta `blocks.canonical` via `injectedDataStore.computeChars()` no home card — bônus visível.
- **NÃO faz:** não indexa em vector store — canonicals são hard data, ficam sempre no prompt (injected data). Não re-invade lista Wix — se URL vazio, coach ainda ajuda com nome.
- **Sai daqui quando:** conversa de teste sobre "quais cursos vocês têm sobre X" traz nomes exatos da lista canônica e nunca inventa URL. Card home mostra chars measured no bloco Injected Data.

### 6. Language rule — nunca "score" → "results"
- **Custo:** S
- **Por que agora:** Eric explicitamente na call: *"As soon as you put in score, people think, oh, I need to be 100% extrovert or I need to be 100% conscientious."* Sem essa mudança o coach continua reforçando a moldura normativa que Eric disse ser o principal risco. Também aplica ao label chart e header do render_chart. Ficaria melhor fechar antes de próxima demo.
- **Escopo:**
  - System prompt de todo persona (arquivo `framework_*.md`): adicionar regra explícita "Nunca use 'score'. Use 'result', 'profile' ou 'pattern'. Nunca sugira normativo — o mais alto não é 'bom', só 'mais presente aqui'."
  - VISUAL WIDGETS block (app.js): label default do render_chart passa de "Score" pra "Result" ou "Level".
  - Sub-item bloqueado — **discutir com Varsha se termos alternativos precisam ser mais específicos por contexto (traits vs values vs biases)**. Enquanto ela não decide, roda com "result".
- **NÃO faz:** não muda o wording nos reports do Wix — cross-project. Não bane label completamente (Eric marcou como armadilha em ambas direções — bane só "score").
- **Sai daqui quando:** amostra de 5 respostas do coach em quiz-report não mostra "score", e chart labels default estão em "Result".

### 7. Preferir visuais proporcionais a barras quando dimensões são de perfil
- **Custo:** S
- **Por que agora:** Eric no demo: bars convidam ranking (*"eu sou 78, ela é 82"*), radar mostra proporção sem impor ordem. AFAZERES antigo #1 shipou charts agressivos mas sem preferência de tipo. Sem isso, coach continua puxando bar chart em EI, valores, personalidade — todos casos onde radar é semanticamente melhor.
- **Escopo:**
  - Adicionar bloco no VISUAL WIDGETS do system prompt: "Prefer radar / windmill quando as dimensões são de PERFIL do usuário (traits, EI facets, values, personality dimensions, communication styles). Use bar quando as dimensões são inerentemente rankeáveis (tempo, contagem, dinheiro, comparação de itens externos)."
  - Se `render_chart` já suporta `type: 'radar'` — verificar. Se não, adicionar como opção com fallback pra bar quando N<3 dimensões.
- **NÃO faz:** não muda o widget do Wix (cross-project). Não força radar em todo caso — só onde apropriado.
- **Sai daqui quando:** conversa sobre EI results num quiz-report mostra radar, não bar. Bar continua aparecendo em séries temporais e comparações rankeáveis.

---

## Concluído — histórico do sprint 2026-08-10

Preservado pra rastreabilidade. Detalhes do escopo original de cada um no commit history.

- **Charts/tables mais agressivos no coach** — shipped 2026-08-10 (commit `67db27c`).
- **Emojis por default no tom da Erica** — shipped 2026-08-10 no mesmo batch.
- **Reorganizar Coach Studio em três áreas + migrar persona/guardrails do Wix** — primeira camada shipped (nav + Real Time + hubs). Migração Wix→Studio segue como AFAZERES futuro quando decisão CP-01 (multi-persona) fechar.
- **Bug: widgets do co-worker somem no reload** — resolvido em batch anterior; verificado no ourobouros de 2026-08-10.
- **Visibilidade da camada de raciocínio (Erica) — admin + simulador** — shipped 2026-08-10 (commit `8297371` inclui fallback para org OpenAI não verificada). Renderização do 🧠 Reasoning verificada live em sessão de deep_think.
- **Interação contextual em nível de elemento** — shipped 2026-08-10 e verificado ponta-a-ponta (score row → `PAGE_ELEMENT_FOCUS` → coach prompt injection).

---

## Removido / rejeitado (histórico de decisão)

- **Upload de imagem pelo usuário no coach** — não vai. Uso não claro no contexto individual, decidido dia 2026-08-09.
- **GIFs / memes** — voltou pro backlog: só depois de emojis + imagens terem métricas positivas.
- **Módulo extraído do co-worker do Studio** — recusado agora, acoplamento com sessionLog/audit/contentStore alto, valor de reuso não claro.
- **V2 rotate keys + migração pra env-var** — não pertence a este projeto (é v2 no Wix). Willian trata direto.
- **Robustecer barge-in de voz** — barge-in funciona. Fica como wishlist no backlog só se voltar a falhar.

---

_Última revisão: 2026-08-11 — 4 itens promovidos de IDEIAS pós-call Eric. Sprint 2026-08-10 movido para "Concluído"._
