# Kato — talk to your code

Kato is a voice assistant for VS Code and Cursor. You talk, and it navigates your codebase, explains it, runs the debugger, handles git and GitHub, and hands real coding work to the agent you already use: **Claude Code** or **Codex**.

Kato never writes code itself. It either runs a precise IDE action (go to a symbol, set a breakpoint, switch branches), or it delegates to the coding agent and keeps you in the loop while it works: what it's doing, when it needs your OK, and when it's done.

It understands English and Spanish, including mixed "Spanglish" sentences.

## A quick example

> **You:** Give me a tour of how multiplayer works.
> **Kato:** Handing it to Claude Code to read the code and build the tour. You'll see its progress in the panel.
> *(40 seconds later)* Multiplayer runs over a local TCP connection… I prepared a tour with 6 stops. Say "next" to start.
>
> **You:** Did CI pass?
> **Kato:** CI failed: 1 of 4 checks red, unit tests. Say "fix the CI" and I'll hand the logs to the agent.
>
> **You:** Fix the CI.
> **Kato:** Unit tests failing in CI. On it — handing it to Claude Code. I'll tell you if it needs you or when it's done.
> *(the code appears in the editor as if it were being typed)*
> **Kato:** Claude Code wants to run the login tests. Should I allow it?
> **You:** Yes to all.
> **Kato:** Done — switching to auto, so I stop asking.

## What you can say

You don't need exact phrases; these are examples. Spanish works just as well ("¿qué errores hay?", "arréglalo", "llévame a la función X").

| Area | Try saying | What happens |
|---|---|---|
| **Understand code** | "What does this function do?" · "Give me a tour of the repo" · "Teach me Swift with this project" | Code on screen is explained right away. Anything bigger goes to the coding agent (read-only), which builds a guided tour that highlights each part of the code while Kato talks about it. Say "next", "back", "repeat". |
| **Navigate** | "Take me to the function handleLogin" · "Where is the retry logic?" · "Who calls this?" · "The other one" | Jumps to the best match and tells you if there are others; "the other one" / "next" walks through them. |
| **Change code** | "Add validation to the signup form" · "Make a plan first" · "Stop" | The coding agent does the work. You can steer it mid-task, approve or deny its actions, and change how much it may do without asking. |
| **Errors** | "What errors are there?" · "Fix them" | Reads VS Code's Problems panel, takes you to the first error, and hands all of them to the agent. |
| **Debugging** | "Put a breakpoint in calculateTotal" · "Debug this file" · "Step" · "What is `items` now?" · "Why is it failing?" · "Fix it" | Drives the real VS Code debugger. While paused, "fix it" gives the agent the exception, the call stack and the local variables. |
| **Git** | "What did I change?" · "Commit this" · "Switch to the feature login branch" · "What does my branch have that main doesn't?" · "Pull in the latest main" · "Stash my changes" | Branch names are matched loosely ("feature login" finds `feature/login-form`). Anything risky, like stashing or merging with conflicts, asks first. |
| **GitHub** | "Did CI pass?" · "Fix the CI" · "How's my PR?" · "Read me the review comments" · "Address the review comments" · "What PRs do I need to review?" · "Check out Ana's PR" · "Work on issue 12" · "Open a PR" | Uses the GitHub account you're already signed into in VS Code, so there's nothing extra to install. Fixes go to the agent along with the CI logs or review comments. Opening a PR always asks first. |
| **Your day** | "What did I do today?" · "My standup for yesterday" · "What did I do this week?" | A short spoken summary of your commits, branches, uncommitted work, finished agent tasks and pull requests. |

## Getting started

### Requirements

- **VS Code 1.93+ or Cursor**, on **macOS**. Only macOS is tested so far; the Linux and Windows microphone capture exists but has never been tried.
- **ffmpeg**, for microphone capture: `brew install ffmpeg`.
- **An OpenAI API key.** Kato uses it to understand requests and to answer.
- **Optional:** an **AssemblyAI** or **Soniox** key for speech recognition and voice. Without one, Kato uses OpenAI for those too.
- **A coding agent you're logged into:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (run `claude` once and sign in) or [Codex](https://github.com/openai/codex) (run `codex login`).

### Install

Kato isn't in the marketplace yet. Build and install it from source:

```bash
git clone https://github.com/Daniel14gonc/kato-voice-agent.git
cd kato-voice-agent
npm install
npx @vscode/vsce package          # produces kato-0.1.0.vsix
code --install-extension kato-0.1.0.vsix     # or: cursor --install-extension kato-0.1.0.vsix
```

### Set it up (about a minute)

1. Run **Kato: Setup** from the command palette, or just press `Ctrl+;`: setup starts on its own the first time.
2. It walks you through four steps:
   - what to use for listening and speaking;
   - only the API keys you're missing (each is checked as you paste it, then stored in VS Code's secret storage);
   - which coding agent to use (it detects what you have installed and signed in);
   - how much the agent may do without asking.
3. The **Kato** panel (next to Terminal and Output) shows a checklist of anything still missing.
4. **macOS asks for microphone permission** the first time. If Kato doesn't seem to hear you, check *System Settings → Privacy & Security → Microphone*.

### Talk to it

| Key | Action |
|---|---|
| `Ctrl+;` | Start talking. Kato stops listening when you pause. Press it while Kato is speaking to interrupt it. |
| `Ctrl+Shift+;` | Type or paste instead of speaking (useful for URLs, error logs, tokens). |
| `Esc` | Cancel whatever Kato is doing. |

## Working with the coding agent

When you ask for a change, Kato starts a session with your coding agent and stays out of the way:

- **The panel** shows a card with the agent's status, a timer, its own step list with progress, the action it's running right now, and a collapsible log of everything it did. Click a command in the log to see its output.
- **The status bar** shows something like `Claude Code · 2/5 · 1:23`, and turns yellow when the agent is waiting for you.
- **By voice**, Kato only says what matters: how many steps the agent planned, an occasional progress update on long tasks, when it needs your approval, and when it's done. Set `kato.agent.spokenUpdates` to `minimal` to hear only the last two.

**Permissions.** Each agent exposes its own levels. Ask "what modes do you have?" to hear them.

| Level | What it means |
|---|---|
| **Plan** | The agent only reads the code and proposes a plan. |
| **Manual** | You approve every action by voice, edits included. |
| **Normal** *(default)* | Edits happen freely. Commands that can change things ask first; read-only commands like `ls`, `git status` or `grep` never do. |
| **Auto** | Nothing asks. Every action still shows in the panel, and you can say "stop" at any time. |

When the agent asks for permission, Kato tells you *what it's for* ("it wants to run the login tests") and the panel shows the exact command. Answer "yes", "no", or "yes to all", which switches to Auto. Your choice is remembered across restarts. Codex has no per-action approvals, so its levels are sandbox scopes instead.

## How it works

```
 Kato panel (webview)                    VS Code extension host
┌──────────────────────┐   messages   ┌─────────────────────────────────────────────────┐
│ audio playback       │ ◀──────────  │ Voice pipeline                                  │
│ conversation         │              │  mic (ffmpeg) → speech-to-text (AssemblyAI,     │
│ agent card, steps    │              │  Soniox or OpenAI) → router → executor → TTS    │
│ setup checklist      │              │                                                 │
└──────────────────────┘              │ Router: one fast LLM call picks ONE tool per     │
                                      │ utterance, using a snapshot of what's on screen  │
                                      │                                                 │
                                      │ Executor                                        │
                                      │  ├─ IDE actions: LSP, debugger, git, Problems   │
                                      │  ├─ GitHub REST API (VS Code's GitHub sign-in)  │
                                      │  └─ Agent layer ──▶ Claude Code / Codex         │
                                      └─────────────────────────────────────────────────┘
```

- **Streaming end to end.** Kato starts speaking the first sentence while the rest is still being generated, and you can interrupt at any point.
- **Agent-agnostic.** Claude Code and Codex sit behind the same interface. Kato drives the CLI you already installed and logged into, so no agent credentials pass through Kato.
- **API keys stay in the extension host.** They're kept in VS Code's secret storage and never reach the webview.
- **Latency is logged per request.** Run *Kato: Show Log* to see the breakdown. The targets are under 2 s for IDE commands and under 2.5 s to the first spoken word.

## Configuration

These are the settings you're most likely to change. All of them are under `kato.*` in VS Code settings.

| Setting | Default | What it does |
|---|---|---|
| `kato.agent.provider` | `claude-code` | Coding agent: `claude-code` or `codex`. |
| `kato.agent.defaultMode` | *(agent's default)* | Starting permission level: `plan`, `ask` (manual), `agent` (normal) or `auto`. Saying "put it on auto" updates it. |
| `kato.agent.spokenUpdates` | `milestones` | `milestones` = plan, occasional progress and done; `minimal` = only when it needs you or finishes. |
| `kato.stt.provider` | `soniox` | Speech-to-text: `assemblyai`, `soniox` or `openai`. Falls back to OpenAI if that provider's key is missing. |
| `kato.tts.provider` | `soniox` | Voice: `soniox` or `openai`. Pick a specific voice with *Kato: Choose Voice*. |
| `kato.stt.silenceMs` | `500` | Pause length (ms) that ends your sentence. Raise it if Kato cuts you off. |
| `kato.models.router` | `gpt-4.1-mini` | Model that decides what each request means. Runs on every request, so it should be fast. |
| `kato.panel.zoom` | `1.1` | Size of everything in the Kato panel. |
| `kato.mic.device` | *(system default)* | Microphone to use (macOS: device name or index). |

## Development

```bash
npm install
npm run build        # bundle into dist/
npm run typecheck
```

- **Run it:** open the folder in VS Code and press **F5**, which starts *Run Kato (no debugger)*. To use breakpoints, pick *Debug Kato Extension* instead.
- **Router evaluation:** `OPENAI_API_KEY=... npm run eval:router` replays about 250 recorded requests against the router and reports accuracy per tool. Add `ROUTER_MODEL=<model>` to compare models.
- **Package:** `npx @vscode/vsce package` produces a small (~5 MB) cross-platform `.vsix`.

## License

[MIT](LICENSE) © 2026 Daniel Gonzalez Carrillo
