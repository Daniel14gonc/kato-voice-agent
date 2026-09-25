# Kato

**Talk to your development environment.** Kato es una extensión de VS Code/Cursor que entiende lo que estás viendo, navega tu codebase, te ayuda a debuggear y controla el coding agent que ya uses (Claude Code, Codex, …) — todo por voz.

> Estado actual: **M0** — loop de voz end-to-end (hablar → transcribir → responder → escuchar) con instrumentación de latencia. Ver el plan completo de milestones en la sección Roadmap.

## Cómo probarlo (sin marketplace)

### Requisitos

- **ffmpeg** para la captura de micrófono (`brew install ffmpeg`). VS Code bloquea `getUserMedia` en webviews de extensiones ([vscode#323602](https://github.com/microsoft/vscode/issues/323602)), así que Kato captura audio con un proceso ffmpeg en el extension host.
- API key de OpenAI (obligatoria). Opcional: AssemblyAI o Soniox para la voz; sin su key, Kato usa OpenAI.
- Un agente de código con sesión iniciada: Claude Code (`claude`) o Codex (`codex login`).

### Desarrollo (VS Code)

```bash
npm install
```

1. Abre este proyecto en VS Code y presiona **F5** (lanza el Extension Development Host).
2. En la ventana nueva, ejecuta **"Kato: Setup"** (o pulsa `Ctrl+;`: sin key de OpenAI arranca el setup solo). Son 4 pasos: con qué escucha/habla, las keys que falten (se validan al pegarlas y se guardan en SecretStorage), qué agente de código usar (detecta cuál tienes instalado y con sesión) y cuánto puede hacer sin preguntarte. El panel de Kato muestra un checklist de lo que falta.
3. Abre el panel **Kato** (junto a Terminal/Output) — ahí vive la captura de audio y verás transcript + respuesta.
4. Presiona **`Ctrl+;`** y habla. Al callarte (VAD), Kato transcribe, piensa y responde por voz.
   - `Ctrl+;` de nuevo mientras habla = interrumpirlo y volver a escuchar (barge-in).
   - `Esc` = cancelar todo.

**Permiso de micrófono en macOS**: la primera vez, macOS debe autorizar el micrófono para VS Code (Ajustes → Privacidad y seguridad → Micrófono). Si la captura falla silenciosamente, revisa eso primero.

### Probar en Cursor

```bash
npx @vscode/vsce package
cursor --install-extension kato-0.1.0.vsix
```

## Métricas de latencia

Cada interacción registra su desglose en el output channel **Kato** (`Kato: Show Log`):

```
[latency #3] speechEnd→transcript: 320ms | transcript→llmFirstToken: 540ms | ... | TOTAL speechEnd→audible: 1650ms
```

Presupuesto objetivo: comando IDE < 2 s; primera palabra hablada < 2.5 s.

## Configuración

| Setting | Default | Qué hace |
|---|---|---|
| `kato.models.router` | `gpt-4.1-mini` | Modelo para el routing de intenciones (M1+) |
| `kato.models.explainer` | `gpt-4.1` | Modelo para respuestas habladas (gpt-5 = más listo, más lento en arrancar) |
| `kato.stt.model` | `gpt-4o-transcribe` | Modelo de transcripción (Realtime API) |
| `kato.stt.silenceMs` | `500` | Silencio (ms) para dar por terminada la frase |
| `kato.stt.language` | *(auto)* | Hint de idioma (`es`, `en`, …) |
| `kato.stt.prompt` | *(es/en bias)* | Prompt de sesgo para el code-switching español/inglés |
| `kato.tts.model` | `gpt-4o-mini-tts` | Modelo TTS |
| `kato.tts.voice` | `nova` | Voz de respuesta |
| `kato.tts.instructions` | *(en, ritmo rápido)* | Instrucciones de estilo para el TTS |
| `kato.mic.device` | *(default del sistema)* | Dispositivo de captura (nombre o índice avfoundation) |
| `kato.agent.provider` | `claude-code` | Agente de código: `claude-code` o `codex` |
| `kato.agent.defaultMode` | *(del agente)* | Nivel de permisos inicial: `plan`, `ask` (manual), `agent` (normal), `auto`. Decir "sí a todo" o "ponlo en automático" lo actualiza |
| `kato.agent.spokenUpdates` | `milestones` | `milestones`: avisa el plan, un avance ocasional en tareas largas y el final. `minimal`: solo cuando te necesita o termina |

## Mientras el agente trabaja

- **Panel de Kato**: tarjeta del agente con estado, reloj, checklist de pasos (la lista de tareas del propio agente), la acción actual y un log de actividad colapsable. Click en un comando para ver su salida.
- **Barra de estado**: `Claude Code · 2/5 · 1:23`, en amarillo cuando espera tu OK. Click abre el panel.
- **Voz**: solo lo que importa: cuántos pasos planeó, un avance cada ~90 s como máximo en tareas largas, cuándo te necesita y cuándo termina.
- **Permisos**: los comandos de solo lectura (`ls`, `git status`, `grep`…) nunca preguntan en modo normal. Kato te dice *para qué* es cada comando (no la sintaxis) y el comando exacto aparece en el panel. "Sí a todo" pasa a automático y se recuerda.

## Arquitectura (M0)

```
Webview (panel Kato)                Extension host
┌─────────────────────┐   postMsg   ┌──────────────────────────────┐
│ PCM playback (TTS)  │ ◀─chunks──  │ VoicePipeline (state machine)│
│ VU meter / estado   │ ◀─status──  │  ├─ Mic: ffmpeg (24kHz PCM)  │
└─────────────────────┘             │  ├─ STT: OpenAI Realtime WS  │
                                    │  ├─ LLM: streaming → frases  │
                                    │  └─ TTS: gpt-4o-mini-tts PCM │
                                    └──────────────────────────────┘
```

- La captura de mic vive en el extension host (ffmpeg); el webview solo reproduce el TTS y muestra estado. Las API keys nunca tocan el webview.
- Todo el pipeline es streaming y cancelable: la primera frase de la respuesta se habla mientras el resto se sigue generando.
- `engines.vscode: ^1.93.0`, sin proposed APIs (compatibilidad con Cursor).

## Roadmap

- **M0** ✅ Scaffold + loop de voz end-to-end con métricas de latencia.
- **M1** Explore: context engine ("eyes"), LSP queries, referencias deícticas ("ve al segundo"), quick explain, deep understanding vía coding agent read-only + tour por el repo.
- **M2** Edit: catálogo de comandos IDE por voz (rename LSP, tests, diff, commit). Kato nunca genera código.
- **M3** Agent: capa `AgentProvider` (Claude Code + Codex), niveles Ask/Plan/Agent, supervisión por voz.
- **M4** Debug: sesiones de investigación con breakpoints, DAP y hypothesis state.
