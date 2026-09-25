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
  const agentCountEl = document.getElementById('agent-count');
  const agentTaskEl = document.getElementById('agent-task');
  const agentNowEl = document.getElementById('agent-now');
  const agentStreamEl = document.getElementById('agent-stream');
  const agentAskEl = document.getElementById('agent-ask');
  const agentAskTitleEl = document.getElementById('agent-ask-title');
  const agentAskDetailEl = document.getElementById('agent-ask-detail');
  const agentAskHintEl = document.getElementById('agent-ask-hint');

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
    chip.textContent = '📋 ' + lines + (lines === 1 ? ' línea pegada' : ' líneas pegadas');
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
    inputEl.placeholder = opts.placeholder || 'Escribe o pega aquí… (Enter envía, Esc cierra)';
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
    agentRows.clear();
  });

  // ---------- agent ----------
  //
  // A delegated task runs for minutes. Without this the panel said "Idle" the
  // whole time and the only way to learn anything was to ask out loud — which
  // then read a truncated shell command back at you.

  const agentRows = new Map(); // tool id -> history line
  let agentRunningId = null;
  let agentStreamText = '';

  const STATE_LABEL = {
    starting: 'arrancando',
    working: 'trabajando',
    waiting_approval: 'esperando tu OK',
    ready: 'listo',
    closed: 'cerrado',
    idle: 'inactivo',
  };

  function renderAgentStatus(msg) {
    agentEl.classList.toggle('open', Boolean(msg.active));
    if (!msg.active) {
      agentRows.clear();
      agentRunningId = null;
      agentStreamText = '';
      agentStreamEl.textContent = '';
      agentNowEl.textContent = '';
      return;
    }
    agentEl.dataset.state = msg.state;
    agentNameEl.textContent = msg.provider;
    agentModeEl.textContent = msg.modeLabel || '';
    agentCountEl.textContent = msg.toolCount ? msg.toolCount + ' acciones' : '';
    agentTaskEl.textContent = msg.task || '';
    agentTaskEl.title = msg.task || '';
    if (msg.state === 'ready') {
      // The turn is over: its running prose is stale, and leaving it up reads
      // as if the agent were still mid-thought.
      agentNowEl.textContent = '';
      agentStreamText = '';
      agentStreamEl.textContent = '';
      agentRunningId = null;
    }
  }

  function renderAgentTool(msg) {
    let row = agentRows.get(msg.id);
    if (!row) {
      if (emptyEl && emptyEl.parentNode) {
        emptyEl.remove();
      }
      row = document.createElement('div');
      row.className = 'activity';
      historyEl.appendChild(row);
      agentRows.set(msg.id, row);
      trim();
    }
    row.dataset.state = msg.state;
    row.textContent = msg.label;
    row.title = msg.detail || msg.label;
    scrollToEnd();
    if (msg.state === 'running') {
      agentRunningId = msg.id;
      agentNowEl.textContent = msg.detail || msg.label;
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

  function renderAgentPermission(request) {
    if (!request) {
      agentAskEl.classList.remove('open');
      agentAskDetailEl.textContent = '';
      return;
    }
    agentAskEl.classList.add('open');
    agentAskTitleEl.textContent = '¿Le doy permiso para ' + request.title + '?';
    // The raw command, verbatim: this is what the user is actually approving.
    agentAskDetailEl.textContent = request.detail || '';
    agentAskHintEl.textContent = request.canRemember
      ? 'Di "sí" para aprobar, o "sí, y no me preguntes más".'
      : 'Di "sí" para aprobar o "no" para denegar.';
    scrollToEnd();
  }

  const STATUS_LABEL = {
    idle: 'Idle — Ctrl+; to talk',
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
  };

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
          placeholder: msg.placeholder || 'Pega el valor aquí…',
          question: msg.question,
          awaiting: true,
        });
        break;
      case 'level':
        vuEl.style.width = Math.min(100, Math.round(msg.value * 300)) + '%';
        break;
      case 'status':
        statusEl.textContent = STATUS_LABEL[msg.state] || msg.state;
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
    }
  });

  post({ type: 'ready' });
  diag('webview loaded');
})();
