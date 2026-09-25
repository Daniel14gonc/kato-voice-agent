// Kato panel: PCM playback, conversation history and the text composer.
// Mic capture happens in the extension host (VS Code blocks getUserMedia in
// extension webviews), so this page plays TTS audio and renders state.
(function () {
  const vscode = acquireVsCodeApi();

  const headerEl = document.getElementById('header');
  const statusEl = document.getElementById('status');
  const vuEl = document.getElementById('vu-bar');
  const historyEl = document.getElementById('history');
  const emptyEl = document.getElementById('empty');
  const composerEl = document.getElementById('composer');
  const askEl = document.getElementById('ask');
  const hintEl = document.getElementById('hint');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const clearEl = document.getElementById('clear');
  const unlockEl = document.getElementById('audio-unlock');
  const agentEl = document.getElementById('agent');
  const agentNameEl = document.getElementById('agent-name');
  const agentModeEl = document.getElementById('agent-mode');
  const agentStateEl = document.getElementById('agent-state');
  const agentTimeEl = document.getElementById('agent-time');
  const agentTaskEl = document.getElementById('agent-task');
  const agentProgressEl = document.getElementById('agent-progress');
  const agentProgressBarEl = document.getElementById('agent-progress-bar');
  const agentStepsEl = document.getElementById('agent-steps');
  const agentLogSummaryEl = document.getElementById('agent-log-summary');
  const agentLogRowsEl = document.getElementById('agent-log-rows');
  const setupEl = document.getElementById('setup');
  const agentNowEl = document.getElementById('agent-now');
  const agentStreamEl = document.getElementById('agent-stream');
  const agentAskEl = document.getElementById('agent-ask');
  const agentAskTitleEl = document.getElementById('agent-ask-title');
  const agentAskDetailEl = document.getElementById('agent-ask-detail');
  const agentAskHintEl = document.getElementById('agent-ask-hint');
  const emptyTitleEl = document.querySelector('#empty .empty-title');

  // The panel speaks the language of the conversation: the extension sends
  // 'lang' with VS Code's display language first, then whatever the user talks in.
  const STRINGS = {
    en: {
      status: { idle: 'Idle — Ctrl+; to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' },
      agentState: {
        starting: 'starting…',
        working: 'working',
        exploring: 'exploring the code',
        waiting_approval: 'waiting for your OK',
        ready: 'done',
        closed: 'closed',
        idle: '',
      },
      agent: 'Agent',
      actions: (n) => n + (n === 1 ? ' action' : ' actions'),
      activity: 'Activity',
      seeOutput: '(click: see the output)',
      askTitle: (what) => 'Let it ' + what + '?',
      askHint: 'Ctrl+; and say "yes", "no", or "yes to all" so it stops asking.',
      pasted: (n) => n + (n === 1 ? ' line pasted' : ' lines pasted'),
      placeholder: 'Type or paste here… (Enter sends, Esc closes)',
      pasteValue: 'Paste the value here…',
      emptyTitle: 'Press <b>Ctrl+;</b> and talk',
      hint: '<kbd>Ctrl+;</kbd> talk · <kbd>Ctrl+Shift+;</kbd> type or paste',
      unlock: '🔊 Click to enable audio',
      clear: 'Clear',
      send: 'Send',
      setup: 'Set up Kato',
      examples: 'Try: “give me a tour of this repo” · “take me to the main function” · “add validation to the login form”',
    },
    es: {
      status: { idle: 'En espera — Ctrl+; para hablar', listening: 'Escuchando…', thinking: 'Pensando…', speaking: 'Hablando…' },
      agentState: {
        starting: 'arrancando…',
        working: 'trabajando',
        exploring: 'explorando el código',
        waiting_approval: 'espera tu OK',
        ready: 'terminó',
        closed: 'cerrado',
        idle: '',
      },
      agent: 'Agente',
      actions: (n) => n + (n === 1 ? ' acción' : ' acciones'),
      activity: 'Actividad',
      seeOutput: '(click: ver la salida)',
      askTitle: (what) => '¿Le doy permiso para ' + what + '?',
      askHint: 'Ctrl+; y di "sí", "no", o "sí a todo" para que no vuelva a preguntar.',
      pasted: (n) => n + (n === 1 ? ' línea pegada' : ' líneas pegadas'),
      placeholder: 'Escribe o pega aquí… (Enter envía, Esc cierra)',
      pasteValue: 'Pega el valor aquí…',
      emptyTitle: 'Pulsa <b>Ctrl+;</b> y habla',
      hint: '<kbd>Ctrl+;</kbd> hablar · <kbd>Ctrl+Shift+;</kbd> escribir o pegar',
      unlock: '🔊 Click para habilitar el audio',
      clear: 'Limpiar',
      send: 'Enviar',
      setup: 'Configurar Kato',
      examples: 'Prueba: «dame un tour por este repo» · «llévame a la función main» · «agrega validación al formulario de login»',
    },
  };
  let T = STRINGS.en;

  const SAMPLE_RATE = 24000;
  const MAX_TURNS = 120;

  let audioContext = null;
  let nextPlayTime = 0;
  let activeSources = new Set();
  let reportedPlaybackStart = false;

  function post(msg) {
    vscode.postMessage(msg);
  }

  function diag(message) {
    post({ type: 'diag', message });
  }

  // ---------- history ----------

  let liveUserTurn = null; // partial transcript, still being spoken
  let katoBubble = null; // bubble the current answer is revealed into

  // Tracked from the scroll event, not measured after appending: by then the
  // new content has already grown the scroll height and we'd never stick.
  let stickToBottom = true;
  historyEl.addEventListener('scroll', () => {
    stickToBottom = historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight < 80;
  });

  function scrollToEnd(force) {
    if (force || stickToBottom) {
      historyEl.scrollTop = historyEl.scrollHeight;
      stickToBottom = true;
    }
  }

  function trim() {
    while (historyEl.children.length > MAX_TURNS) {
      historyEl.removeChild(historyEl.firstChild);
    }
  }

  // Spoken text says "main dot py" so TTS pronounces it well; on screen that
  // reads terribly, so identifiers and URLs are written back to normal form.
  const SPOKEN_SUFFIX =
    /^(py|js|ts|tsx|jsx|json|md|txt|yml|yaml|toml|cfg|ini|lock|sql|sh|env|css|html|go|rs|java|rb|php|com|org|net|io|dev|ai|co|app)$/i;

  function prettify(text) {
    return text
      .replace(/\b([\w-]+)\s+(?:dot|punto)\s+([A-Za-z]{1,5})\b/g, (match, head, tail) =>
        SPOKEN_SUFFIX.test(tail) ? head + '.' + tail : match,
      )
      .replace(/\b([a-z][\w-]*)\s+(?:slash|barra)\s+([a-z][\w-]*)\b/gi, '$1/$2');
  }

  function addParagraph(bubble, text) {
    const paragraph = document.createElement('p');
    paragraph.textContent = prettify(text);
    bubble.appendChild(paragraph);
    return paragraph;
  }

  const PASTE_LINES = 4;
  const PASTE_CHARS = 320;

  /** Long pasted blocks collapse to a chip so they don't bury the thread. */
  function addPasteBlock(bubble, text) {
    const lines = text.split('\n').length;
    const chip = document.createElement('div');
    chip.className = 'paste-chip';
    chip.textContent = '📋 ' + T.pasted(lines);
    const body = document.createElement('div');
    body.className = 'paste-body';
    body.textContent = text;
    chip.addEventListener('click', () => {
      chip.classList.toggle('open');
      body.classList.toggle('open');
      scrollToEnd();
    });
    bubble.appendChild(chip);
    bubble.appendChild(body);
  }

  function addTurn(who, text, live) {
    if (emptyEl && emptyEl.parentNode) {
      emptyEl.remove();
    }
    const wrap = document.createElement('div');
    wrap.className = 'turn ' + who + (live ? ' live' : '');
    const label = document.createElement('div');
    label.className = 'who';
    label.textContent = who === 'user' ? 'You' : 'Kato';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (text && who === 'user' && (text.split('\n').length > PASTE_LINES || text.length > PASTE_CHARS)) {
      addPasteBlock(bubble, text);
    } else if (text) {
      addParagraph(bubble, text);
    }
    wrap.appendChild(label);
    wrap.appendChild(bubble);
    historyEl.appendChild(wrap);
    trim();
    scrollToEnd(true);
    return { wrap: wrap, bubble: bubble };
  }

  function addActivity(text) {
    if (emptyEl && emptyEl.parentNode) {
      emptyEl.remove();
    }
    const line = document.createElement('div');
    line.className = 'activity';
    line.textContent = text;
    line.title = text;
    historyEl.appendChild(line);
    trim();
    scrollToEnd();
  }

  function showTranscript(text) {
    if (!liveUserTurn) {
      liveUserTurn = addTurn('user', text, true);
    } else {
      liveUserTurn.bubble.textContent = text;
      scrollToEnd();
    }
  }

  /** Reveals one spoken sentence as its own paragraph, in sync with the audio. */
  function revealSentence(text, startsNewBubble) {
    if (startsNewBubble || !katoBubble) {
      katoBubble = addTurn('kato', '').bubble;
    }
    addParagraph(katoBubble, text);
    scrollToEnd();
  }

  function freezeUserTurn() {
    if (liveUserTurn) {
      liveUserTurn.wrap.classList.remove('live');
      liveUserTurn = null;
    }
  }

  // ---------- audio ----------
  //
  // Everything playable goes through ONE queue drained by ONE loop. Chunks used
  // to be handed straight to an async playChunk() from the message handler:
  // while the AudioContext was still suspended by the autoplay policy those
  // calls all parked on resume(), and the backlog was replayed *after* whatever
  // arrived during the unlock — so the beginning of the first answer played
  // after its middle. Queueing sentence markers alongside the audio keeps the
  // revealed text attributed to the right chunk too.

  const playQueue = [];
  let draining = false;
  let chunkCount = 0;
  let pendingSentence = null;
  let reportedLockError = false;

  async function ensureAudioContext() {
    if (!audioContext) {
      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (audioContext.state === 'suspended') {
      // Autoplay policy can leave resume() hanging forever; fail loudly so the
      // pipeline doesn't get stuck waiting for playback that never starts.
      await Promise.race([
        audioContext.resume(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('AudioContext suspended (autoplay policy)')), 1500),
        ),
      ]);
    }
    if (audioContext.state !== 'running') {
      throw new Error('AudioContext state: ' + audioContext.state);
    }
    return audioContext;
  }

  function enqueuePlayback(item) {
    playQueue.push(item);
    void drainPlayback();
  }

  async function drainPlayback() {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (playQueue.length > 0) {
        let ctx;
        try {
          ctx = await ensureAudioContext();
        } catch (err) {
          // Still locked: leave the queue intact and untouched in order. The
          // user's click calls drainPlayback() again and it resumes here.
          unlockEl.style.display = 'block';
          if (!reportedLockError) {
            reportedLockError = true;
            post({ type: 'playbackError', message: String((err && err.message) || err) });
          }
          return;
        }
        const item = playQueue.shift();
        if (item.sentence) {
          pendingSentence = item.sentence;
        } else {
          scheduleChunk(item.chunk, ctx);
        }
      }
    } finally {
      draining = false;
    }
  }

  function scheduleChunk(b64, ctx) {
    chunkCount++;
    if (chunkCount === 1 || chunkCount % 50 === 0) {
      diag('chunk #' + chunkCount + ' scheduled, ctx=' + ctx.state);
    }
    const int16 = base64ToInt16(b64);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 0x8000;
    }
    const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.03, nextPlayTime);
    // Reveal the sentence text (and notify the host, which syncs code
    // highlights) at the exact moment its audio starts playing.
    if (pendingSentence) {
      const sentence = pendingSentence;
      pendingSentence = null;
      setTimeout(
        () => {
          revealSentence(sentence.text, sentence.newBubble);
          if (sentence.id !== undefined && sentence.id !== null) {
            post({ type: 'sentenceStarted', id: sentence.id });
          }
        },
        Math.max(0, (startAt - ctx.currentTime) * 1000),
      );
    }
    source.start(startAt);
    nextPlayTime = startAt + buffer.duration;
    activeSources.add(source);
    source.onended = () => {
      activeSources.delete(source);
      if (activeSources.size === 0 && playQueue.length === 0) {
        post({ type: 'playbackEnded' });
      }
    };
    if (!reportedPlaybackStart) {
      reportedPlaybackStart = true;
      post({ type: 'playbackStarted' });
    }
  }

  // A single user gesture unlocks WebAudio for the lifetime of this page.
  async function tryUnlock() {
    if (audioContext && audioContext.state === 'running') {
      void drainPlayback();
      return;
    }
    try {
      const ctx = await ensureAudioContext();
      unlockEl.style.display = 'none';
      reportedLockError = false;
      diag('audio unlocked, state=' + ctx.state);
      void drainPlayback();
    } catch (err) {
      diag('unlock failed: ' + String((err && err.message) || err));
    }
  }
  document.body.addEventListener('click', tryUnlock);

  function base64ToInt16(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
  }

  function stopAudio() {
    playQueue.length = 0;
    pendingSentence = null;
    for (const source of activeSources) {
      try {
        source.stop();
      } catch (_) {
        /* already stopped */
      }
    }
    activeSources.clear();
    nextPlayTime = 0;
    reportedPlaybackStart = false;
    reportedLockError = false;
  }

  // ---------- composer ----------

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  function openComposer(options) {
    const opts = options || {};
    composerEl.classList.add('open');
    composerEl.classList.toggle('awaiting', Boolean(opts.awaiting));
    hintEl.style.display = 'none';
    askEl.textContent = opts.question || '';
    inputEl.placeholder = opts.placeholder || T.placeholder;
    if (opts.value !== undefined) {
      inputEl.value = opts.value;
    }
    inputEl.focus();
    autoGrow();
  }

  function closeComposer() {
    composerEl.classList.remove('open', 'awaiting');
    hintEl.style.display = '';
    inputEl.value = '';
    askEl.textContent = '';
    autoGrow();
  }

  function submit() {
    const text = inputEl.value.trim();
    if (!text) {
      closeComposer();
      return;
    }
    closeComposer();
    freezeUserTurn();
    addTurn('user', text);
    post({ type: 'userInput', text: text });
  }

  sendEl.addEventListener('click', submit);
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeComposer();
    }
  });

  // Typing or pasting anywhere in the panel summons the composer.
  document.addEventListener('paste', (event) => {
    if (composerEl.classList.contains('open')) {
      return;
    }
    const pasted = event.clipboardData && event.clipboardData.getData('text');
    if (pasted) {
      event.preventDefault();
      openComposer({ value: pasted });
    }
  });
  document.addEventListener('keydown', (event) => {
    if (composerEl.classList.contains('open') || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key.length === 1) {
      openComposer({ value: event.key });
      event.preventDefault();
    }
  });
  clearEl.addEventListener('click', () => {
    historyEl.textContent = '';
    liveUserTurn = null;
    katoBubble = null;
  });

  // ---------- agent ----------
  //
  // A delegated task runs for minutes. The card at the top shows who is
  // working, on which step, for how long, and what it needs from you. Every
  // tool call lives in the collapsible "Actividad" log inside the card; the
  // conversation only gets milestones, so it stays readable.

  const agentRows = new Map(); // tool id -> log row
  const MAX_LOG_ROWS = 80;
  let agentRunningId = null;
  let agentStreamText = '';
  let agentStatus = null;
  let agentTimer = null;

  function clock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function renderAgentTime() {
    if (!agentStatus || !agentStatus.startedAt) {
      agentTimeEl.textContent = '';
      return;
    }
    const end = agentStatus.finishedAt || Date.now();
    agentTimeEl.textContent =
      clock(end - agentStatus.startedAt) + (agentStatus.toolCount ? ' · ' + T.actions(agentStatus.toolCount) : '');
  }

  function renderAgentStatus(msg) {
    agentStatus = msg;
    agentEl.classList.toggle('open', Boolean(msg.active));
    if (!msg.active) {
      clearInterval(agentTimer);
      agentTimer = null;
      agentRunningId = null;
      agentStreamText = '';
      agentStreamEl.textContent = '';
      agentNowEl.textContent = '';
      return;
    }
    agentEl.dataset.state = msg.state;
    agentNameEl.textContent = msg.provider;
    agentStateEl.textContent = msg.state in T.agentState ? T.agentState[msg.state] : msg.state;
    agentModeEl.textContent = msg.modeLabel || '';
    agentTaskEl.textContent = msg.task || '';
    agentTaskEl.title = msg.task || '';
    const hasSteps = Boolean(msg.stepCount);
    agentProgressEl.classList.toggle('indeterminate', !hasSteps && msg.state !== 'ready');
    if (hasSteps) {
      const done = agentStepsEl.querySelectorAll('li[data-status="completed"]').length;
      agentProgressBarEl.style.width = Math.round((done / msg.stepCount) * 100) + '%';
    } else {
      agentProgressBarEl.style.width = '';
    }
    renderAgentTime();
    const running = msg.state !== 'ready' && msg.state !== 'closed';
    if (running && !agentTimer) {
      agentTimer = setInterval(renderAgentTime, 1000);
    } else if (!running) {
      clearInterval(agentTimer);
      agentTimer = null;
    }
    if (msg.state === 'ready') {
      // The turn is over: its running prose is stale, and leaving it up reads
      // as if the agent were still mid-thought.
      agentNowEl.textContent = '';
      agentStreamText = '';
      agentStreamEl.textContent = '';
      agentRunningId = null;
    }
  }

  function renderAgentTodos(todos) {
    agentStepsEl.textContent = '';
    for (const todo of todos) {
      const li = document.createElement('li');
      li.dataset.status = todo.status;
      li.textContent = todo.status === 'in_progress' && todo.activeText ? todo.activeText : todo.text;
      agentStepsEl.appendChild(li);
    }
    if (agentStatus) {
      renderAgentStatus(agentStatus);
    }
  }

  function clearAgentLog() {
    agentRows.clear();
    agentLogRowsEl.textContent = '';
    agentLogSummaryEl.textContent = T.activity;
  }

  function renderAgentTool(msg) {
    let row = agentRows.get(msg.id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'activity';
      row.addEventListener('click', () => {
        if (row.dataset.output === '1') {
          post({ type: 'command', command: 'kato.showAgentOutput' });
        }
      });
      agentLogRowsEl.appendChild(row);
      agentRows.set(msg.id, row);
      while (agentLogRowsEl.children.length > MAX_LOG_ROWS) {
        agentLogRowsEl.removeChild(agentLogRowsEl.firstChild);
      }
      renderLogSummary();
    }
    row.dataset.state = msg.state;
    row.dataset.output = msg.hasOutput ? '1' : '';
    row.textContent = msg.label;
    row.title = (msg.detail || msg.label) + (msg.hasOutput ? '\n' + T.seeOutput : '');
    agentLogRowsEl.scrollTop = agentLogRowsEl.scrollHeight;
    if (msg.state === 'running') {
      agentRunningId = msg.id;
      agentNowEl.textContent = msg.label;
      agentNowEl.title = msg.detail || msg.label;
    } else if (agentRunningId === msg.id) {
      agentRunningId = null;
      agentNowEl.textContent = '';
    }
  }

  function renderAgentText(delta) {
    agentStreamText = (agentStreamText + delta).slice(-400);
    agentStreamEl.textContent = agentStreamText;
  }

  function renderLogSummary() {
    agentLogSummaryEl.textContent = T.activity + (agentRows.size ? ' (' + agentRows.size + ')' : '');
  }

  let agentPermission = null;

  function renderAgentPermission(request) {
    agentPermission = request;
    if (!request) {
      agentAskEl.classList.remove('open');
      agentAskDetailEl.textContent = '';
      return;
    }
    agentAskEl.classList.add('open');
    agentAskTitleEl.textContent = T.askTitle(request.title);
    // The raw command, verbatim: this is what the user is actually approving.
    agentAskDetailEl.textContent = request.detail || '';
    agentAskHintEl.textContent = T.askHint;
  }

  function addMilestone(text) {
    if (emptyEl && emptyEl.parentNode) {
      emptyEl.remove();
    }
    if (text.startsWith('▶')) {
      // A new task: the previous one's log would only confuse.
      clearAgentLog();
    }
    const line = document.createElement('div');
    line.className = 'milestone';
    line.textContent = text;
    line.title = text;
    historyEl.appendChild(line);
    trim();
    scrollToEnd();
  }

  // ---------- setup checklist (empty state) ----------

  function renderSetup(items) {
    setupEl.textContent = '';
    if (!items || items.length === 0) {
      return;
    }
    let missingRequired = false;
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'setup-item';
      row.dataset.ok = item.ok ? '1' : '0';
      row.dataset.optional = item.optional ? '1' : '';
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = item.ok ? '✓' : item.optional ? '○' : '✗';
      const body = document.createElement('span');
      body.textContent = item.label;
      if (item.hint && !item.ok) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = item.hint;
        body.appendChild(hint);
      }
      row.appendChild(mark);
      row.appendChild(body);
      setupEl.appendChild(row);
      if (!item.ok && !item.optional) {
        missingRequired = true;
      }
    }
    if (missingRequired) {
      const button = document.createElement('button');
      button.className = 'setup-button';
      button.textContent = T.setup;
      button.addEventListener('click', () => post({ type: 'command', command: 'kato.setup' }));
      setupEl.appendChild(button);
    } else {
      const examples = document.createElement('div');
      examples.className = 'setup-examples';
      examples.textContent = T.examples;
      setupEl.appendChild(examples);
    }
  }

  let panelState = 'idle';

  /** Re-renders every piece of fixed text after a language change. */
  function applyLanguage(lang) {
    T = STRINGS[lang] || STRINGS.en;
    document.documentElement.lang = lang;
    statusEl.textContent = T.status[panelState] || panelState;
    if (emptyTitleEl) {
      emptyTitleEl.innerHTML = T.emptyTitle;
    }
    hintEl.innerHTML = T.hint;
    unlockEl.textContent = T.unlock;
    clearEl.textContent = T.clear;
    sendEl.textContent = T.send;
    if (!composerEl.classList.contains('awaiting')) {
      inputEl.placeholder = T.placeholder;
    }
    renderLogSummary();
    if (agentStatus) {
      renderAgentStatus(agentStatus);
    } else {
      agentNameEl.textContent = T.agent;
    }
    if (agentPermission) {
      renderAgentPermission(agentPermission);
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'playAudio':
        enqueuePlayback({ chunk: msg.chunk });
        break;
      case 'answerStart':
        stopAudio();
        freezeUserTurn();
        katoBubble = null;
        pendingSentence = null;
        break;
      case 'sentenceStart':
        // Queued, not applied straight away: it must land on the chunk that
        // actually follows it, not on whatever is playing right now.
        enqueuePlayback({ sentence: { text: msg.text, id: msg.id, newBubble: msg.newBubble } });
        break;
      case 'stopAudio':
        stopAudio();
        break;
      case 'activity':
        addActivity(msg.text);
        break;
      case 'requestInput':
        openComposer({
          placeholder: msg.placeholder || T.pasteValue,
          question: msg.question,
          awaiting: true,
        });
        break;
      case 'level':
        vuEl.style.width = Math.min(100, Math.round(msg.value * 300)) + '%';
        break;
      case 'status':
        panelState = msg.state;
        statusEl.textContent = T.status[msg.state] || msg.state;
        statusEl.dataset.state = msg.state;
        headerEl.dataset.state = msg.state;
        if (msg.state !== 'listening') {
          vuEl.style.width = '0%';
        }
        break;
      case 'transcript':
        showTranscript(msg.text);
        break;
      case 'agentStatus':
        renderAgentStatus(msg);
        break;
      case 'agentTool':
        renderAgentTool(msg);
        break;
      case 'agentText':
        renderAgentText(msg.delta);
        break;
      case 'agentPermission':
        renderAgentPermission(msg.request);
        break;
      case 'agentTodos':
        renderAgentTodos(msg.todos || []);
        break;
      case 'agentMilestone':
        addMilestone(msg.text);
        break;
      case 'setupStatus':
        renderSetup(msg.items);
        break;
      case 'lang':
        applyLanguage(msg.value);
        break;
      case 'zoom':
        document.body.style.zoom = String(Math.min(2, Math.max(0.7, Number(msg.value) || 1)));
        break;
    }
  });

  applyLanguage('en');
  post({ type: 'ready' });
  diag('webview loaded');
})();
