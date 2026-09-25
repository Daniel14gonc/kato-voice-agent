import * as vscode from 'vscode';
import type { AgentStatusUpdate } from '../agent/agentManager';
import type { AgentTodo } from '../agent/agentSession';

/** Commands the panel may trigger (buttons, clickable rows). Nothing else. */
const PANEL_COMMANDS = new Set(['kato.showAgentOutput', 'kato.setup', 'kato.toggleTalk', 'kato.showLog']);

export type PipelineState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface AudioBridgeEvents {
  onReady(): void;
  onPlaybackStarted(): void;
  onPlaybackEnded(): void;
  onPlaybackError(message: string): void;
  onDiag(message: string): void;
  /** Fires at the exact moment a sentence's audio starts playing. */
  onSentenceStarted?(id: number): void;
  /** Text typed/pasted in the panel — treated exactly like a spoken utterance. */
  onUserInput?(text: string): void;
}

/**
 * Hosts the audio webview (PCM playback + status UI) and exposes a typed
 * message protocol to the rest of the extension. Mic capture lives in the
 * extension host (see MicCapture); the webview never sees API keys.
 */
export class AudioBridge implements vscode.WebviewViewProvider {
  static readonly viewId = 'kato.audio';

  private view: vscode.WebviewView | undefined;
  private events: AudioBridgeEvents | undefined;
  private ready = false;
  private readyPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;
  /** Replayed when the page (re)loads: it may come up after the status was sent. */
  private lastSetup: object | undefined;
  private lastZoom: object | undefined;
  private lang: 'es' | 'en' = 'en';
  private languageListener: (() => void) | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setEvents(events: AudioBridgeEvents): void {
    this.events = events;
  }

  get isResolved(): boolean {
    return this.view !== undefined;
  }

  /** Reveals the view (resolving it if needed) and waits for the page's `ready`. */
  async ensureReady(): Promise<void> {
    if (this.view && this.ready) {
      return;
    }
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve) => {
        this.readyResolve = resolve;
      });
    }
    if (!this.view) {
      await vscode.commands.executeCommand('kato.audio.focus');
    }
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('El panel de audio de Kato no respondió (timeout)')), 5000),
    );
    await Promise.race([this.readyPromise, timeout]);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
      this.readyPromise = undefined;
      this.readyResolve = undefined;
    });
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.readyResolve?.();
        this.post({ type: 'lang', value: this.lang });
        if (this.lastSetup) {
          this.post(this.lastSetup);
        }
        if (this.lastZoom) {
          this.post(this.lastZoom);
        }
        break;
      case 'playbackStarted':
        this.events?.onPlaybackStarted();
        break;
      case 'playbackEnded':
        this.events?.onPlaybackEnded();
        break;
      case 'playbackError':
        this.events?.onPlaybackError(msg.message as string);
        break;
      case 'sentenceStarted':
        if (typeof msg.id === 'number') {
          this.events?.onSentenceStarted?.(msg.id);
        }
        break;
      case 'userInput':
        if (typeof msg.text === 'string') {
          this.events?.onUserInput?.(msg.text);
        }
        break;
      case 'diag':
        this.events?.onDiag(msg.message as string);
        break;
      case 'command':
        if (typeof msg.command === 'string' && PANEL_COMMANDS.has(msg.command)) {
          void vscode.commands.executeCommand(msg.command);
        }
        break;
    }
  }

  private post(msg: object): void {
    void this.view?.webview.postMessage(msg);
  }

  playAudio(base64Pcm: string): void {
    this.post({ type: 'playAudio', chunk: base64Pcm });
  }

  answerStart(): void {
    this.post({ type: 'answerStart' });
  }

  stopAudio(): void {
    this.post({ type: 'stopAudio' });
  }

  setStatus(state: PipelineState): void {
    this.post({ type: 'status', state });
  }

  showLevel(rms: number): void {
    this.post({ type: 'level', value: rms });
  }

  showTranscript(text: string): void {
    this.post({ type: 'transcript', text });
  }

  /** `newBubble` starts a fresh Kato bubble when this sentence is revealed. */
  announceSentence(text: string, id?: number, newBubble = false): void {
    this.post({ type: 'sentenceStart', text, id, newBubble });
  }

  /** Dim monospace line in the history (test runs, one-off notices). */
  showActivity(text: string): void {
    this.post({ type: 'activity', text });
  }

  /** Agent card: who is working, in what mode, on what step, for how long. */
  agentStatus(update: AgentStatusUpdate): void {
    this.post({ type: 'agentStatus', ...update });
  }

  /** A tool call starting or finishing. Same `id` updates the same row. */
  agentTool(event: {
    id: string;
    label: string;
    detail?: string;
    state: 'running' | 'ok' | 'error';
    hasOutput?: boolean;
  }): void {
    this.post({ type: 'agentTool', ...event });
  }

  /** The agent's plan as a checklist. */
  agentTodos(todos: AgentTodo[]): void {
    this.post({ type: 'agentTodos', todos });
  }

  /** A milestone line in the conversation (task started, step done, finished). */
  agentMilestone(text: string): void {
    this.post({ type: 'agentMilestone', text });
  }

  /** Scales the whole panel (kato.panel.zoom). Replayed when the page reloads. */
  setZoom(zoom: number): void {
    this.lastZoom = { type: 'zoom', value: zoom };
    this.post(this.lastZoom);
  }

  /** The panel's fixed text follows the conversation: 'es' or anything else (English). */
  get language(): 'es' | 'en' {
    return this.lang;
  }

  setLanguage(language: string | undefined): void {
    const lang = language === 'es' ? 'es' : 'en';
    if (lang === this.lang) {
      return;
    }
    this.lang = lang;
    this.post({ type: 'lang', value: lang });
    this.languageListener?.();
  }

  onLanguageChange(listener: () => void): void {
    this.languageListener = listener;
  }

  /** Setup checklist for the empty state (keys, ffmpeg, agent CLI). */
  setupStatus(items: Array<{ label: string; ok: boolean; optional?: boolean; hint?: string }>): void {
    this.lastSetup = { type: 'setupStatus', items };
    this.post(this.lastSetup);
  }

  /**
   * Brings the Kato panel into view without stealing the editor's focus — the
   * user is usually talking, not typing, but may be mid-edit.
   */
  reveal(): void {
    if (this.view) {
      this.view.show(true);
      return;
    }
    void vscode.commands
      .executeCommand('kato.audio.focus')
      .then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
  }

  /** The agent's own prose, streamed — proof of life between tool calls. */
  agentText(delta: string): void {
    this.post({ type: 'agentText', delta });
  }

  /**
   * A permission request, shown with the raw command. Approving by voice
   * without seeing what is about to run is the thing this fixes.
   */
  agentPermission(request: { title: string; detail?: string; canRemember: boolean } | undefined): void {
    this.post({ type: 'agentPermission', request: request ?? null });
  }

  /** Opens and focuses the composer, optionally labelled with what Kato asked. */
  requestInput(placeholder: string, question?: string): void {
    void vscode.commands.executeCommand('kato.audio.focus');
    this.post({ type: 'requestInput', placeholder, question });
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaUri = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...parts));
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline';" />
  <style>
    :root { --kato-radius: 10px; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      display: flex;
      flex-direction: column;
    }

    /* Header: state at a glance */
    header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px 6px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    }
    #dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
    #status { font-weight: 600; font-size: 0.92em; }
    #status[data-state="listening"] ~ #vu #vu-bar { background: var(--vscode-charts-green); }
    header[data-state="listening"] #dot { background: var(--vscode-charts-green); animation: pulse 1.2s ease-in-out infinite; }
    header[data-state="thinking"] #dot { background: var(--vscode-charts-yellow); animation: pulse 0.9s ease-in-out infinite; }
    header[data-state="speaking"] #dot { background: var(--vscode-charts-blue); animation: pulse 0.7s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.8); } }
    #vu { flex: 1; height: 4px; background: var(--vscode-editorWidget-background); border-radius: 2px; overflow: hidden; }
    #vu-bar { height: 100%; width: 0%; background: var(--vscode-charts-green); transition: width 60ms linear; }
    .icon-btn {
      background: none; border: none; color: var(--vscode-descriptionForeground);
      cursor: pointer; font-size: 0.8em; padding: 2px 6px; border-radius: 4px;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); color: var(--vscode-foreground); }

    /* Agent card: a coding agent works for minutes, so the panel has to show
       what it is doing — prominently — without the user having to ask. */
    #agent {
      display: none; flex-direction: column; gap: 5px;
      margin: 8px 10px 0; padding: 9px 11px 9px 12px;
      border-radius: 8px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-left: 3px solid var(--vscode-charts-blue);
      background: var(--vscode-editorWidget-background);
    }
    #agent.open { display: flex; }
    #agent[data-state="waiting_approval"] { border-left-color: var(--vscode-charts-yellow); }
    #agent[data-state="ready"] { border-left-color: var(--vscode-charts-green); }
    #agent[data-state="exploring"] { border-left-color: var(--vscode-charts-purple, var(--vscode-charts-blue)); }
    .agent-head { display: flex; align-items: center; gap: 8px; font-size: 1.08em; flex-wrap: wrap; }
    #agent-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--vscode-descriptionForeground); }
    #agent[data-state="working"] #agent-dot,
    #agent[data-state="starting"] #agent-dot { background: var(--vscode-charts-blue); animation: pulse 1s ease-in-out infinite; }
    #agent[data-state="exploring"] #agent-dot { background: var(--vscode-charts-purple, var(--vscode-charts-blue)); animation: pulse 1s ease-in-out infinite; }
    #agent[data-state="waiting_approval"] #agent-dot { background: var(--vscode-charts-yellow); animation: pulse 0.7s ease-in-out infinite; }
    #agent[data-state="ready"] #agent-dot { background: var(--vscode-charts-green); }
    #agent-name { font-weight: 700; }
    #agent-state { opacity: 0.85; }
    .agent-chip {
      font-size: 0.85em; padding: 0 6px; border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      opacity: 0.8;
    }
    .agent-chip:empty { display: none; }
    #agent-time { margin-left: auto; opacity: 0.75; font-size: 0.92em; font-variant-numeric: tabular-nums; }
    #agent-task { font-size: 1em; opacity: 0.85; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    /* Progress: real when the agent keeps a step list, indeterminate otherwise. */
    #agent-progress { height: 4px; border-radius: 2px; overflow: hidden; background: var(--vscode-editor-background); position: relative; }
    #agent-progress-bar { height: 100%; width: 0%; background: var(--vscode-charts-blue); transition: width 300ms ease; }
    #agent-progress.indeterminate #agent-progress-bar { width: 30%; position: absolute; animation: slide 1.4s ease-in-out infinite; }
    #agent[data-state="ready"] #agent-progress-bar { background: var(--vscode-charts-green); width: 100%; animation: none; position: static; }
    #agent[data-state="waiting_approval"] #agent-progress-bar { background: var(--vscode-charts-yellow); animation-play-state: paused; }
    @keyframes slide { 0% { left: -30%; } 100% { left: 100%; } }
    #agent-steps { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 1em; }
    #agent-steps:empty { display: none; }
    #agent-steps li { display: flex; gap: 6px; opacity: 0.55; }
    #agent-steps li::before { content: "○"; width: 1em; flex: none; text-align: center; }
    #agent-steps li[data-status="in_progress"] { opacity: 1; font-weight: 600; }
    #agent-steps li[data-status="in_progress"]::before { content: "◐"; color: var(--vscode-charts-blue); }
    #agent-steps li[data-status="completed"] { opacity: 0.7; }
    #agent-steps li[data-status="completed"]::before { content: "✓"; color: var(--vscode-charts-green); }
    #agent-now {
      font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; opacity: 0.85;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #agent-now::before { content: "◌ "; }
    #agent-now:empty { display: none; }
    /* The agent's own prose, streamed: proof of life between tool calls. */
    #agent-stream {
      font-size: 0.95em; opacity: 0.7; line-height: 1.45;
      max-height: 4.4em; overflow: hidden; font-style: italic;
    }
    #agent-stream:empty { display: none; }
    /* The permission prompt: plain-language title, the exact command below. */
    #agent-ask {
      display: none; flex-direction: column; gap: 4px;
      margin-top: 3px; padding: 7px 9px; border-radius: 6px;
      border: 1px solid var(--vscode-charts-yellow);
      background: var(--vscode-input-background);
    }
    #agent-ask.open { display: flex; }
    #agent-ask-title { font-size: 1.02em; font-weight: 600; }
    #agent-ask-detail {
      font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; opacity: 0.85;
      white-space: pre-wrap; word-break: break-all; max-height: 7em; overflow: auto;
    }
    #agent-ask-detail:empty { display: none; }
    #agent-ask-hint { font-size: 0.88em; opacity: 0.75; }
    /* Every tool call, collapsed: there when you want it, never in the way. */
    #agent-log { font-size: 0.95em; }
    #agent-log summary { cursor: pointer; opacity: 0.6; user-select: none; }
    #agent-log summary:hover { opacity: 0.9; }
    #agent-log-rows .activity { font-size: 0.95em; opacity: 0.75; }
    #agent-log-rows { max-height: 220px; overflow-y: auto; margin-top: 4px; display: flex; flex-direction: column; gap: 1px; }
    #agent-log-rows .activity[data-output="1"] { cursor: pointer; text-decoration: underline dotted; }

    /* History */
    #history { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
    .turn { display: flex; flex-direction: column; gap: 3px; max-width: 92%; }
    .turn .who { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.55; }
    .bubble { padding: 7px 10px; border-radius: var(--kato-radius); white-space: pre-wrap; line-height: 1.45; }
    .turn.user { align-self: flex-end; align-items: flex-end; }
    .turn.user .bubble {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-bottom-right-radius: 3px;
    }
    .turn.user.live .bubble { opacity: 0.65; font-style: italic; }
    .turn.kato { align-self: flex-start; }
    .turn.kato .bubble {
      background: var(--vscode-editorWidget-background);
      border-bottom-left-radius: 3px;
    }
    /* One paragraph per spoken sentence: a wall of text is hard to scan. */
    .bubble p { margin: 0; }
    .bubble p + p { margin-top: 0.5em; }
    .activity {
      align-self: flex-start; font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.88em; opacity: 0.65; padding-left: 4px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
    }
    .activity::before { content: "› "; opacity: 0.7; }
    .activity[data-state="running"]::before { content: "◌ "; opacity: 0.8; }
    .activity[data-state="ok"]::before { content: "✓ "; color: var(--vscode-charts-green); opacity: 0.9; }
    .activity[data-state="error"]::before { content: "✗ "; color: var(--vscode-charts-red); opacity: 0.9; }
    .activity[data-state="running"] { opacity: 0.85; }
    .milestone {
      align-self: stretch; font-size: 0.92em; opacity: 0.8; padding: 2px 6px;
      border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #empty { margin: auto; text-align: center; font-size: 0.85em; line-height: 1.6; max-width: 340px; }
    .empty-title { opacity: 0.55; }
    /* First-run checklist: what is set up and what is missing, at a glance. */
    #setup { margin-top: 12px; text-align: left; display: flex; flex-direction: column; gap: 4px; }
    #setup:empty { display: none; }
    .setup-item { display: flex; gap: 7px; align-items: baseline; }
    .setup-item .mark { width: 1em; flex: none; text-align: center; }
    .setup-item[data-ok="1"] .mark { color: var(--vscode-charts-green); }
    .setup-item[data-ok="0"] .mark { color: var(--vscode-charts-red); }
    .setup-item[data-ok="0"][data-optional="1"] .mark { color: var(--vscode-descriptionForeground); }
    .setup-item .hint { display: block; opacity: 0.6; font-size: 0.9em; }
    .setup-examples { margin-top: 10px; opacity: 0.6; font-size: 0.92em; }
    .setup-button {
      margin-top: 8px; padding: 5px 12px; border-radius: 6px; cursor: pointer; border: none; align-self: center;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    .setup-button:hover { background: var(--vscode-button-hoverBackground); }

    /* Composer: summoned, never permanent — this is a voice-first surface.
       It appears when Kato asks for a value, on the type shortcut, or when
       the user pastes/types into the panel. */
    footer { padding: 6px 12px 8px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); }
    #hint { font-size: 0.78em; opacity: 0.5; text-align: center; padding: 2px 0; }
    #hint kbd {
      font-family: inherit; opacity: 0.9;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 3px; padding: 0 3px;
    }
    #composer { display: none; gap: 6px; align-items: flex-end; }
    #composer.open { display: flex; }
    #ask { font-size: 0.8em; opacity: 0.75; margin-bottom: 4px; }
    #ask:empty { display: none; }
    #input {
      width: 100%; padding: 6px 9px; border-radius: 6px; resize: none; overflow-y: auto;
      min-height: 30px; max-height: 180px; line-height: 1.4;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      font-family: inherit; font-size: 0.92em; outline: none;
    }
    #input:focus { border-color: var(--vscode-focusBorder); }
    #composer.awaiting #input { border-color: var(--vscode-charts-yellow); }
    #send {
      padding: 6px 10px; border-radius: 6px; cursor: pointer; border: none;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    #send:hover { background: var(--vscode-button-hoverBackground); }

    /* Pasted blocks stay collapsed so they don't bury the conversation. */
    .paste-chip {
      cursor: pointer; font-size: 0.85em; opacity: 0.85;
      display: inline-flex; align-items: center; gap: 5px;
    }
    .paste-chip::after { content: "▸"; font-size: 0.85em; opacity: 0.6; }
    .paste-chip.open::after { content: "▾"; }
    .paste-body {
      display: none; margin-top: 6px; padding-top: 6px; max-height: 260px; overflow: auto;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; white-space: pre-wrap;
    }
    .paste-body.open { display: block; }
    #audio-unlock {
      display: none; width: 100%; margin-bottom: 6px; padding: 6px;
      border-radius: 6px; cursor: pointer; border: none;
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    }
  </style>
</head>
<body>
  <header id="header" data-state="idle">
    <span id="dot"></span>
    <span id="status" data-state="idle">Idle</span>
    <div id="vu"><div id="vu-bar"></div></div>
    <button class="icon-btn" id="clear" title="Clear conversation">Clear</button>
  </header>

  <div id="agent" data-state="idle">
    <div class="agent-head">
      <span id="agent-dot"></span>
      <span id="agent-name">Agente</span>
      <span id="agent-state"></span>
      <span class="agent-chip" id="agent-mode"></span>
      <span id="agent-time"></span>
    </div>
    <div id="agent-task"></div>
    <div id="agent-progress" class="indeterminate"><div id="agent-progress-bar"></div></div>
    <ol id="agent-steps"></ol>
    <div id="agent-now"></div>
    <div id="agent-stream"></div>
    <div id="agent-ask">
      <div id="agent-ask-title"></div>
      <div id="agent-ask-detail"></div>
      <div id="agent-ask-hint"></div>
    </div>
    <details id="agent-log">
      <summary id="agent-log-summary">Actividad</summary>
      <div id="agent-log-rows"></div>
    </details>
  </div>

  <div id="history">
    <div id="empty">
      <div class="empty-title">Pulsa <b>Ctrl+;</b> y habla</div>
      <div id="setup"></div>
    </div>
  </div>

  <footer>
    <button id="audio-unlock">🔊 Click para habilitar el audio</button>
    <div id="hint"><kbd>Ctrl+;</kbd> hablar · <kbd>Ctrl+Shift+;</kbd> escribir o pegar</div>
    <div id="composer">
      <div style="flex:1">
        <div id="ask"></div>
        <textarea id="input" rows="1" placeholder="Escribe o pega aquí… (Enter envía, Esc cierra)"
                  autocomplete="off" spellcheck="false"></textarea>
      </div>
      <button id="send" title="Send">Send</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${mediaUri('webview', 'main.js')}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
