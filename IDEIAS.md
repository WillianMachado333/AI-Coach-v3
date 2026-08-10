# Backlog — ideias possíveis, não comprometidas

Lista viva de tudo que já discutimos como futuro possível para o AI Coach (Erica) + Coach Studio.
O objetivo aqui é deliberação, não execução — se um item ainda não pesa "vai render valor real vs. só um impulso bonitinho", ele fica aqui.

Convenções:
- **[💡]** ideia crua, ainda não foi pesada
- **[📋]** já tem alguma especificação (memória, doc, prompt anterior)
- **[🔨]** parcialmente construído em algum lugar
- **[✋]** decisão adiada / esperando outra coisa antes
- **[⚠️]** valor incerto — pode ser impulso bonitinho
- **[🐛]** bug observado que precisa investigação — não é wishlist

---

## Comunicação do coach (visual + tom)

- **[📋] Emojis por default no tom da coach** — 1-2 bem colocados por turno. Persona prompt precisa encorajar. Custo baixo, valor alto (absorção humana).
- **[📋] Imagens ilustrativas geradas / buscadas** — coach escolhe imagem que ilustra o conceito. DALL·E on-demand, biblioteca curada, ou híbrido. Custo médio, valor alto — "uma imagem vale mais que mil palavras" real.
- **[📋] Charts/tables mais agressivos** — os tools `render_chart` / `render_table` existem mas subusados. Prompt tuning + gatilhos mais explícitos. Custo baixo, valor alto.
- **[⚠️] GIFs / memes** — cultura WhatsApp-style, mais informal. Risco: meme errado destrói confiança rápido. Precisa lib source (Giphy / curated). Segurança: NÃO liberar antes de emojis + imagens terem telemetria positiva.
- **[💡] Ícones inline** — ícones semânticos em respostas (📊 para dados, 🎯 para objetivos, 💭 para reflexão). Meio caminho entre emoji e ilustração.
- **[💡] Cor / destaque temático por seção da resposta** — bloco de "reflexão", bloco de "próximos passos", bloco de "cuidado com" com cor sutil de fundo.

## Multimodal de entrada

- **[📋] Input de sinais faciais / corporais** — câmera opcional lê expressão / postura / atenção → coach adapta ritmo e tom. Ninguém no espaço TT-relevante está fazendo. Vetor de vantagem grande.
- **[✋] Upload de imagem pelo usuário** — colar print, foto, screenshot. Decidido: **não agora** — uso não claro no contexto do coach individual.
- **[✋] Anotação de imagem** — se o upload for feito, permitir marcações em vermelho antes de mandar. Já existe no Studio, portado do daily-report.
- **[💡] Voz do usuário como sinal emocional** — não só ASR, mas prosody (tom, ritmo, pausas) alimentam o modelo. Erica reage à ansiedade, hesitação, animação da voz.

## Contexto e integração com o site

- **[📋] Interação contextual em nível de elemento** — foco/seleção/click em elemento do report vira contexto do coach. Já parcial (page-context via bridge), falta granularidade element-level.
- **[📋] Value pre-open** — surfaces coaching antes da pessoa abrir o coach, direto na landing / report / journey. Usa activity signals do CleverTap. Nada implementado ainda.
- **[💡] Coach proativa com interjeições espontâneas** — hoje reativa (usuário clica, ela responde). Willian: quer que a Erica note movimentação/contexto (scroll numa seção do report, dwell prolongado numa página, quiz abandonado no meio, retorno a uma página vista antes) e emita uma **interjeição espontânea** — balão de fala saindo do ícone com frase curta ("percebi que você voltou aqui — quer conversar sobre X?"). Valor: entrega insight ANTES do usuário abrir o chat, transforma o ícone de affordance passiva em presença ativa. Requer: (a) sinais de comportamento em tempo real do lado do bridge (scroll / dwell / element focus / navegação), (b) regra ou LLM pequeno decidindo QUANDO interromper — cuidado enorme com barulho / spam ("Clippy vibes" mata a experiência), (c) UI de balão flutuante que fecha sozinho após N segundos OU expande pra chat completo se o usuário engajar. Relacionado a [[ai-coach-pre-open-value]] (irmão) — pre-open value pode ser cards estáticos ou contextual snippets; interjeição é a coach FALANDO espontaneamente. Não sobrepor os dois na mesma tela.
- **[📋] Deep-links from coach → site** — quando Erica cita "Unit 3.2 do curso", a resposta contém link clicável que abre o Wix na página certa (não só menciona).
- **[💡] Coach como copilot do site** — usuário navegando, coach sugere "não deixa de olhar o gráfico de Empatia" contextualmente. Requer telemetria de scroll / hover no site.
- **[🔨] Iframe flutuante em vez de lightbox Wix** — arquitetura já mapeada em [ai-coach-floating-iframe-architecture]. Permite persistência entre navegações, pré-warm, integração DOM-level.

## UX / vida do coach

- **[🔨] Corner-icon-first** — ícone pequeno de canto que expande no click. Parcialmente feito (bridge injeta), pode refinar.
- **[📋] Hover-glimpse pills** — hover no ícone minimizado revela sugestões flutuantes. Bing-style pre-open discovery.
- **[📋] Voz natural por default, muted por default** — voz sempre gerada (para animação), mas playback muted; um click desmuta.
- **[💡] Replay do último turno da voz** — botão pra ouvir de novo o que Erica falou.
- **[💡] Skip forward na voz** — pular pedaços do turno atual (útil quando ela repete algo).
- **[💡] Multi-language switch** — hoje detecta idioma auto, mas dá pra ter toggle explícito.
- **[💡] Save / name a coaching session** — usuário nomeia e volta a uma conversa específica depois ("Semana da decisão do trabalho").
- **[💡] Seta discreta de minimizar no topo do chat** — hoje só tap na Erica minimiza (e funciona bem). Willian: intuição visual pede uma seta pra baixo discreta no top-right do chat expandido, perto do menu `⋮`. Ambas afordâncias em paralelo — tap na Erica continua funcionando, seta é reforço visual pra quem não descobriu o gesto.

## Voz / Realtime

- **[⚠️] Barge-in robusto** — hoje funciona segundo Willian testou, mas VAD threshold=0.95 e handler sem `response.cancel` explícito. Se voltar a falhar, root cause já mapeado em [ai-coach-voice-barge-in-broken].
- **[💡] Detectar silêncio prolongado → pergunta suave** — se user parou de falar por N segundos sem intenção clara, coach faz uma pergunta gentil ao invés de esperar.
- **[🐛] Ícone em animação falante o tempo todo no modo voz** — ao entrar no modo voz, o ícone da Erica fica em animação "ela-está-falando" permanentemente, mesmo quando ela está em silêncio (escutando o usuário, esperando, ou entre turnos). Deveria animar SÓ enquanto áudio da Erica está sendo emitido. Impacto: cue visual perde sentido — pra usuário parece que ela ficou congelada num loop de fala. Conflita diretamente com a intenção descrita em [[ai-coach-voice-natural-by-default]] (animação = "ela está falando"). Hipótese: state machine no bridge/app.js entra em `speaking` no `session.updated` e não sai; ou não escuta `response.audio.done` / `output_audio_buffer.stopped`. Investigar handlers de eventos Realtime em `app.js` e classes CSS aplicadas no ícone.
- **[💡] Karaoke highlight — sublinhar palavra que a Erica está falando agora** — Willian viu no WhatsApp: quando transcreve um áudio, a UI destaca a palavra atual em sync com o playback, o usuário lê e ouve ao mesmo tempo. Replicar aqui: enquanto Erica fala, a palavra correspondente no balão de texto ganha highlight (background sutil ou peso/cor). Valor: (a) acessibilidade — usuário lê no ritmo dela sem precisar decidir "leio ou ouço?", (b) confia mais no coach quando vê que texto e áudio batem, (c) fica óbvio onde pausar/pular. Implementação: Realtime API já emite `response.audio_transcript.delta` token-a-token quase em sync com `response.audio.delta`; guardar timestamp de cada delta no client e casar com `AudioContext.currentTime` do playback pra descobrir a posição atual. Complicação: TTS pode adiantar/atrasar em relação ao transcript — precisar tolerância ±150ms. Não bloquear nada se o sync falhar, degrada pra "texto sem highlight".

## Coach Studio (observatório + editor)

- **[📋] Promover os 3 tiles "planned" do Injected Data pra editores reais** — Willian (2026-08-10): "acho que dá pra promover canonical courses / quizzes / safety pra mostrar estrutura de edição no Coach Studio". Hoje esses tiles em `/admin/injected-data` estão como `planned` (chip cinza, sem link). Valor de promover: (a) evidencia pro Eric o quanto o Studio já é administrável de verdade, (b) começa a exercitar a fronteira entre hard data (URL/ID/nome canônico) e soft data (semântica no vector store) — ver [[ai-coach-hard-vs-soft-data]], (c) cria o gancho para migrar essas listas do Wix pro Studio quando for hora (AFAZERES #3 segunda camada). Escopo mínimo por tile:
  - **Canonical courses** — tabela com {course_id, canonical_name, wix_url, short_description}. Persiste em `/data/injected/canonical-courses.json` (padrão overlay-shadowing como coursesStore); read consulta esse arquivo; write via form no admin com audit. Ao boot da preparation, o servidor injeta o array como bloco `=== CANONICAL COURSES ===` no system prompt (curto — nome + URL, sem descrição pra não estourar contexto). Fica claro pra Erica: "quando você citar um curso, use o nome e URL desta lista, nunca invente".
  - **Canonical quizzes** — mesmo shape, `/data/injected/canonical-quizzes.json`. Bloco `=== CANONICAL QUIZZES ===`.
  - **Safety / refusal rules** — lista rankeada de {rule_id, trigger_hint, prescribed_response}. Persiste `/data/injected/safety-rules.json`. Bloco `=== SAFETY RULES ===` no system prompt. Cada regra tem toggle on/off individual (padrão Real Time).
  - Nos três: hub tile deixa de ter `planned:true`, ganha `count` real, aponta pra `/admin/injected-data/{canonical-courses|canonical-quizzes|safety-rules}`. Editor renderiza tabela + botão "adicionar linha" + save direto ao overlay.
  - Ganha um pequeno indicador em `/admin/realtime` de "quantos chars cada bloco injected está adicionando ao system prompt" — reforça a mensagem "cada palavra custa contexto".
- **Custo:** M (2 dias — modelo de armazenamento é trivial, custo real é o editor de tabela em HTML puro + integração no fluxo de preparation + testes de que o novo bloco não empurra o prompt pra cima de limite razoável).
- **Manutenção que cria:** três novos arquivos JSON no volume (backup implícito via audit log), três novos endpoints admin, um novo trecho no system prompt sempre que o coach inicia. Se alguém encher a safety-rules com 200 entradas, o system prompt infla — vai precisar de cap ou alerta. Também: quando chegar a migração Wix→Studio, essas listas passam a ser a fonte única de verdade, ou seja, o Wix vai precisar consumir daqui via API — cria dependência inversa.
- **Por que não fazer agora nesta sessão:** promoção + implementação na mesma sessão viola a regra do CLAUDE.md. Fica esperando você promover explicitamente na próxima; quando promover, quebro em três PRs (um por tile) pra reduzir blast radius.
- **[💡] Save / name / bookmark de conversa no simulador** — Willian rodou algo interessante, quer voltar amanhã.
- **[💡] Simulator rodando no site real da Talent Transformation, não em host pages mock** — hoje o simulador embeda a coach num punhado de páginas mock (quiz-report, homepage-fake, etc). Funciona, mas força suposições sobre o que o site "de verdade" injeta em runtime. Willian quer: apontar o simulador pra uma URL real do site TT (curso X, relatório Y, artigo Z), a coach carrega ali dentro com toda a preparação real, e o admin observa o comportamento contra o conteúdo autêntico da página. Valor: testa a configuração contra o que a Erica *realmente vê* — DOM real, dados reais do usuário logado (ou seed de usuário-teste), scroll real, elementos real. Elimina inteira uma camada de "será que a mock representa fielmente o site?". Casa diretamente com a área `Real Time` do AFAZERES #3 — o simulador vira o lugar canônico onde admin exercita exatamente o que chega em produção. Implementação: precisa de um modo "simulator harness" carregável em qualquer página do site (via query-param, cookie ou toggle admin) que ativa gravação/inspeção + swap de persona sem tocar em usuário real. Cuidado: garantir que sessões de simulador rodando no site real sejam sempre marcadas `caller: simulator` no session log (já é convenção — ver [ai-coach-hard-vs-soft-data]) pra não contaminar métricas.
- **[💡] Comparação side-by-side de duas runs** — mesma seed, dois prompts diferentes, ver drift em paralelo.
- **[💡] Bulk actions no /admin/sessions** — deletar tester sessions em massa, tag em lote, filtro salvo.
- **[💡] Alertas por regra** — "avisa quando rage-close > 3 em um dia" via email/webhook.
- **[💡] Editor de framework / curso com preview live** — enquanto edita o markdown, mostra render do lado.
- **[💡] Diff visual entre versões** — hoje mostra hunk texto; poderia ser side-by-side proper.
- **[💡] Session bookmarks para Varsha/Eric** — marca sessão como "exemplar" / "problema" com nota, aparece na home.
- **[💡] Cost tracking** — quanto cada sessão custou em OpenAI tokens (aproximado). Ajuda a decidir modelos.

## Segurança / operação

- **[🔨] V2 key rotation + migração pra env-var** — v2 no Wix ainda usa as chaves antigas expostas via endpoint compartilhado. Ainda precisa: rotar as chaves antigas depois de trocar v2.
- **[💡] Repo privado** — AI-Coach-v3 é público. Vale privatizar depois da limpeza de segurança.
- **[💡] Audit log exportável** — hoje só via UI. Poderia ter download signed .txt/CSV.
- **[💡] STORE_MESSAGE_TEXT=raw como toggle por sessão** — mode "debug" onde admin pode ler user text de UMA sessão específica com approval registrado.
- **[💡] Rate limit por objectId** — evitar consumo abusivo de user anônimo.

## Debug / dev

- **[💡] "Modo verboso" no coach** — devs veem tool calls + prompts + latência em UI escondida (Alt+Shift+D).
- **[💡] Replay de sessão real no simulator** — pega uma sessão, roda em outro persona, compara.
- **[💡] Cheat sheet de prompts eficazes** — Varsha vai acumulando frases que funcionam bem, ficam num painel de reuso.

---

_Última revisão: 2026-08-09._
