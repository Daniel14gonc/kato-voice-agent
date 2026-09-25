import OpenAI from 'openai';
import type { ChatMessage } from '../llm/llmProvider';
import { lowestReasoningEffort } from '../llm/openai';

export interface Intent {
  tool: string;
  args: Record<string, unknown>;
}

export interface RouteRequest {
  transcript: string;
  snapshotText: string;
  history: ChatMessage[];
  signal: AbortSignal;
}

/**
 * One gpt-4.1-mini call with strict function calling decides what every
 * utterance means. There is no separate "mode" classifier — the mode is an
 * emergent effect of which tool gets picked. Static prefix (system + tools)
 * goes first so OpenAI's automatic prompt caching kicks in.
 */
const ROUTER_SYSTEM_PROMPT =
  'You are the intent router for Kato, a voice assistant inside VS Code. ' +
  'The user speaks Spanish and English, often mixed, and transcripts come from speech recognition, so expect ' +
  'filler words and small transcription errors. Map each utterance to EXACTLY ONE tool call.\n' +
  'Rules:\n' +
  '- Kato NEVER generates or edits code itself. Any request to create/modify/write code or files, implement, refactor or ' +
  'fix → agent_delegate (a coding agent does the work). If the snapshot shows an AGENT session already running, ' +
  'agent_delegate sends the instruction to it as steering.\n' +
  '- Agent supervision — read the AGENT line first, because its state decides which tool is right:\n' +
  '  · WAITING FOR VOICE APPROVAL: any affirmative ("sí", "dale", "apruébalo", "yes", "yeah", "ok") → agent_control approve; ' +
  'any negative ("no", "deniégalo", "don\'t run that") → agent_control deny. Still approve/deny when the user adds something ' +
  'else ("sí, y ponlo en automático" → approve). NEVER confirm_action while the agent waits: it answers a different question ' +
  'and leaves the agent blocked until it times out.\n' +
  '  · ready or working with NOTHING pending: an affirmative, an insistence or a restated task is a NEW instruction → ' +
  'agent_delegate, never agent_control approve. "sí, hazlo", "yes, commit and then push", "te dije que lo hicieras" are all ' +
  'agent_delegate.\n' +
  '  · "¿qué está haciendo?/how is it going" → agent_control status; "detente/párale/stop" → agent_control stop.\n' +
  '  · A plan is ready and the user says "adelante/ejecútalo/go ahead" → agent_control continue.\n' +
  '  · Permission levels: "ponlo en automático", "modo manual", "pásalo a plan", "no me preguntes más" → agent_control ' +
  'set_mode, with `mode` set to the user\'s own words. "¿qué modos tienes?", "what permission levels are there?" → ' +
  'agent_control list_modes. Kato resolves the words against the levels the current agent really supports, so never filter ' +
  'or rename them yourself.\n' +
  '- The SNAPSHOT describes what the user currently sees in VS Code. If it says no workspace/folder is open, ' +
  'code navigation and search tools are useless — use answer and mention they need to open a project.\n' +
  '- REFERENTS are items Kato listed earlier (R1, R2, …). "el segundo" / "the second one" → that referent ID. ' +
  'Use nav_goto_ref ONLY when the user points at a listed item by position or name — never for a new concept they just ' +
  'brought up, and NEVER when the snapshot has no REFERENTS section (there is nothing to point at, so pick another tool).\n' +
  '- After the agent changed files: "explain what you did", "muéstrame lo que hiciste", "no vi nada de eso", "walk me ' +
  'through it" → explain_deep, so the agent re-reads the real files and Kato gives a guided tour. Do NOT use answer, ' +
  'which would only paraphrase the conversation from memory.\n' +
  '- "Where is X implemented/handled?", "take me to where X happens", "go to the X logic" → find_feature (semantic). ' +
  'search_code is ONLY for literal strings the user dictates ("busca el texto TODO").\n' +
  '- Questions about code on screen or a referent → explain_quick. General chat, questions about Kato itself, ' +
  'or anything not covered by other tools → answer.\n' +
  '- Questions that need exploring code NOT on screen — repo architecture, "explain this repo", where/how a whole ' +
  'feature works across files — → explain_deep. It is slow (a coding agent explores the repo), so only when quick tools cannot answer.\n' +
  '- An EXPLICIT request for a tour or walkthrough ("dame un tour", "guíame por el código", "guide me through the code", ' +
  '"walk me through it", "recórremelo paso a paso") is ALWAYS explain_deep: the user is asking Kato to navigate the code ' +
  'with them, and explain_deep is the only tool that produces a tour. REPO NOTES or visible code never satisfy it — ' +
  'answer/explain_quick would only talk, which is exactly what they did not ask for.\n' +
  '- While the snapshot shows an active TOUR: "siguiente/next", "anterior/previous", "repite", "para/termina el tour" → tour_control.\n' +
  '- Debugger: "debuggea este archivo", "arranca el debugger", "debug test.py" → debug_control start. "Pon un breakpoint ' +
  'en la línea 12" → debug_control set_breakpoint. While the snapshot shows an active DEBUG session: "siguiente/step/avanza" ' +
  '→ step_over, "entra/step into" → step_into, "sal/step out" → step_out, "continúa/continue/sigue corriendo" → continue, ' +
  '"¿qué vale X?/what is X now?" → evaluate with target = the expression, "para el debugger" → stop. If BOTH a tour and a ' +
  'debug session are active, "siguiente" is the debugger only when they say step/paso; otherwise tour_control. Asking to ' +
  'FIX the bug is agent_delegate, not debug_control.\n' +
  '- Git: "muéstrame el diff/qué cambié" → git_diff; "haz stage" → git_stage; "haz commit" → git_commit; ' +
  '"cámbiate a la rama X"/"crea una branch" → git_branch. ANY other git operation (init, push, pull, merge, ' +
  'rebase, revert, reset, tag, remotes, resolving conflicts) → agent_delegate, never the closest git tool.\n' +
  'Running the project tests → run_tests.\n' +
  '- Compound utterances still map to ONE tool: pick the one that achieves the whole request. While the agent is waiting, ' +
  '"sí, y ya no me preguntes" → agent_control approve — Kato reads the "stop asking" half itself and remembers the decision.\n' +
  '- confirm_action ONLY when the snapshot shows PENDING CONFIRMATION and no agent is waiting for approval. If both are ' +
  'present the agent wins: use agent_control approve/deny.\n' +
  '- Use ask_input when completing the request needs an EXACT string the user has not given and would be painful to ' +
  'dictate (a URL, a git remote, a token or API key, a long path, an email), AND when the user announces they are about ' +
  'to send you something ("te voy a pasar el error", "te mando el resumen del bug", "let me paste the log"). Once the ' +
  'value arrives as the next message, route normally with it.\n' +
  '- A long pasted block (logs, stack trace, error output, a spec) is MATERIAL for a task, not a command: if it implies ' +
  'work → agent_delegate with that content in the instruction; if it is a question about code on screen → explain_quick; ' +
  'otherwise → answer. Never try to map it to a short navigation command.\n' +
  '- If the utterance is ambiguous between referents or targets, use ask_clarification.';

/**
 * Bare yes/no while the agent is parked on a permission request. Routing these
 * through the LLM cost ~1 second each and, worse, misfired: in a recorded
 * session a plain "Yes." was routed to confirm_action, the approval was
 * swallowed, and the agent died on its 180-second timeout. An anchored match
 * on the whole utterance is both faster and impossible to misroute; anything
 * longer or more complex still goes to the router.
 */
const AFFIRMATIVE =
  /^(s[ií]+|sip|simón|dale|vale|ok|okay|claro|correcto|perfecto|adelante|apru[eé]balo|apru[eé]balo ya|aprobado|apru[eé]ba|h[aá]zlo|yes|yeah|yep|yup|sure|go ahead|approve|approve it|do it|allow it)$/i;
const NEGATIVE =
  /^(no|nope|para|det[eé]nte|cancela|canc[eé]lalo|deni[eé]galo|deniega|no lo hagas|don't|dont|do not|deny|deny it|cancel)$/i;

/** The intent for an utterance Kato can resolve without asking the LLM. */
export function quickAgentIntent(transcript: string, waitingApproval: boolean): Intent | undefined {
  if (!waitingApproval) {
    return undefined;
  }
  const text = transcript
    .trim()
    .replace(/^[¿¡\s]+/, '')
    .replace(/[\s,.!?]+$/, '');
  if (AFFIRMATIVE.test(text)) {
    return { tool: 'agent_control', args: { action: 'approve', mode: null } };
  }
  if (NEGATIVE.test(text)) {
    return { tool: 'agent_control', args: { action: 'deny', mode: null } };
  }
  return undefined;
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  tool('nav_goto_ref', 'Open/jump to a referent Kato listed earlier (search hit, reference, symbol match).', {
    ref_id: { type: 'string', description: 'Referent ID, e.g. "R2".' },
  }),
  tool('nav_goto_symbol', 'Jump to a named function/class/symbol — or open a FILE — in the workspace by name.', {
    name: {
      type: 'string',
      description: 'Symbol or file name, as close to the code identifier / filename as possible.',
    },
  }),
  tool(
    'find_references',
    'List places that call/use a symbol. Target: a referent ID, a symbol name, or null for the symbol under the cursor.',
    {
      target: {
        type: ['string', 'null'],
        description: 'Referent ID ("R2"), symbol name, or null = symbol at cursor.',
      },
    },
  ),
  tool('search_code', 'Literal full-text search — only when the user dictates an exact string to find.', {
    query: { type: 'string', description: 'Exact text to search for.' },
  }),
  tool(
    'find_feature',
    'Semantic locate: the user asks where a concept/feature lives or is implemented. Searches several keywords and picks the best location.',
    {
      question: { type: 'string', description: "The user's question, verbatim-ish." },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description:
          '2-5 short code-ish search terms likely to appear in the relevant code: identifiers, config keys, library names (English, e.g. ["JWT", "SIMPLE_JWT", "TokenObtainPair"]).',
      },
    },
  ),
  tool(
    'explain_quick',
    'Explain code the user can already see: current selection, visible code, or a referent. NOT for whole-repo questions.',
    {
      question: { type: 'string', description: "The user's question, verbatim-ish." },
      ref_id: { type: ['string', 'null'], description: 'Referent ID if they pointed at one, else null.' },
    },
  ),
  tool(
    'explain_deep',
    'Delegate to the coding agent (slow, read-only): repo-wide or cross-file questions about code not currently on screen. Produces an overview plus a guided tour.',
    {
      question: { type: 'string', description: "The user's question, verbatim-ish." },
      granularity: {
        type: ['string', 'null'],
        description:
          'Only if the user asked for a depth: "block" (línea por línea, bloque por bloque), "function" (función por función) or "section" (por encima, resumen general). Otherwise null — the agent decides.',
      },
    },
  ),
  tool(
    'debug_control',
    'Drive the real VS Code debugger, live: start/stop a session, breakpoints, stepping, inspecting values.',
    {
      action: {
        type: 'string',
        enum: [
          'start',
          'set_breakpoint',
          'remove_breakpoints',
          'step_over',
          'step_into',
          'step_out',
          'continue',
          'evaluate',
          'stop',
        ],
        description: 'What to do with the debugger.',
      },
      target: {
        type: ['string', 'null'],
        description: 'File name for start/set_breakpoint, or the expression to evaluate. Null when not needed.',
      },
      line: { type: ['number', 'null'], description: '1-based line number for set_breakpoint.' },
    },
  ),
  tool('tour_control', 'Control the active guided tour.', {
    action: {
      type: 'string',
      enum: ['next', 'prev', 'repeat', 'stop'],
      description: 'next = advance, prev = go back, repeat = re-narrate current stop, stop = end the tour.',
    },
  }),
  tool(
    'agent_delegate',
    'Delegate a coding task to the coding agent (create/modify files, implement, refactor, fix, run commands). If an AGENT session is already running, this steers it with the new instruction.',
    {
      instruction: {
        type: 'string',
        description: "The task, faithful to the user's words, with enough detail to act on.",
      },
      mode: {
        type: ['string', 'null'],
        description:
          '"plan" if the user wants a plan first ("hazme un plan", "planéalo"); "ask" if they want to approve each step; null = normal execution.',
      },
    },
  ),
  tool('agent_control', 'Supervise the running agent task or change its permission level.', {
    action: {
      type: 'string',
      enum: ['status', 'stop', 'approve', 'deny', 'continue', 'set_mode', 'list_modes'],
      description:
        'status = report what the agent is doing; stop = interrupt it; approve/deny = resolve a PENDING permission request; ' +
        'continue = execute the plan the agent proposed; set_mode = change the permission level (fill `mode`); ' +
        'list_modes = read out the permission levels this agent supports ("¿qué modos tienes?", "what levels are there?").',
    },
    mode: {
      type: ['string', 'null'],
      description:
        'Only for set_mode: the level the user asked for, in their own words ("automático", "modo manual", "plan", ' +
        '"auto mode", "no me preguntes"). null for every other action.',
    },
  }),
  tool('git_diff', 'Show the uncommitted changes in the repository.', {
    explain: {
      type: 'boolean',
      description:
        'true if the user wants the changes explained ("¿qué cambié?", "explícame el diff"); false to just show them.',
    },
  }),
  tool('git_stage', 'Stage all current changes (git add).', {}),
  tool('git_branch', 'Switch to a branch, creating it when the user asks for a new one.', {
    name: { type: 'string', description: 'Branch name.' },
    create: { type: 'boolean', description: 'true when the user asks for a NEW branch.' },
  }),
  tool('git_commit', 'Commit the current changes. Kato asks for spoken confirmation before committing.', {
    message: {
      type: ['string', 'null'],
      description: 'Commit message if the user dictated one; null to generate it from the diff.',
    },
  }),
  tool('run_tests', "Run the project's test suite and report the result out loud.", {}),
  tool(
    'ask_input',
    'Ask the user to TYPE or PASTE an exact value (URL, git remote, token, long path) into the Kato panel.',
    {
      question: { type: 'string', description: "Spoken request, in the user's language. One short sentence." },
      placeholder: { type: 'string', description: 'Hint shown in the input box, e.g. "https://github.com/user/repo.git".' },
    },
  ),
  tool('confirm_action', 'Answer a pending confirmation that Kato asked for (see PENDING CONFIRMATION).', {
    yes: { type: 'boolean', description: 'true = confirm and execute, false = cancel.' },
  }),
  tool(
    'answer',
    'Speak a conversational answer (general questions, chit-chat, questions about Kato, or anything with no better tool).',
    {},
  ),
  tool('ask_clarification', 'Ask the user a short clarifying question when the request is ambiguous.', {
    question: { type: 'string', description: 'The clarifying question to speak, in the user’s language.' },
  }),
];

export class IntentRouter {
  constructor(
    private readonly getApiKey: () => Promise<string | undefined>,
    private readonly getModel: () => string,
  ) {}

  async route(request: RouteRequest): Promise<Intent> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Missing OpenAI API key');
    }
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create(
      {
        model: this.getModel(),
        // Routing runs on every utterance: reasoning off keeps it on budget
        // (and OpenAI recommends effort 'none' with forced tool calls).
        ...lowestReasoningEffort(this.getModel()),
        tools: TOOLS,
        tool_choice: 'required',
        parallel_tool_calls: false,
        messages: [
          { role: 'system', content: ROUTER_SYSTEM_PROMPT },
          ...request.history.slice(-8),
          {
            role: 'user',
            content: `SNAPSHOT:\n${request.snapshotText}\n\nUTTERANCE: ${request.transcript}`,
          },
        ],
      },
      { signal: request.signal },
    );
    const call = completion.choices[0]?.message.tool_calls?.[0];
    if (!call || call.type !== 'function') {
      return { tool: 'answer', args: {} };
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      // Malformed arguments → treat as plain answer rather than failing the turn.
      return { tool: 'answer', args: {} };
    }
    return { tool: call.function.name, args };
  }
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name,
      description,
      strict: true,
      parameters: {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    },
  };
}
