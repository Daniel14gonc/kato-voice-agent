import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { IntentRouter } from '../../src/router/intentRouter';

/**
 * Golden evaluation for the intent router: replays recorded utterances against
 * the real router and reports accuracy per tool. Run with
 * `OPENAI_API_KEY=... npm run eval:router`. Gate for CI: exits non-zero below
 * ROUTER_MIN_ACCURACY (default 0.90).
 */

interface Case {
  utterance: string;
  expect: string;
  /**
   * Expected `action` argument. The eval used to compare only the tool name,
   * which is why it stayed green while every "put it on auto" in a real session
   * came back as `approve`: same tool, wrong argument, invisible here.
   */
  expectAction?: string;
  context: string;
  note?: string;
}

const WORKSPACE = 'WORKSPACE: lexr (/Users/dev/code/lexr)';
const ACTIVE_FILE =
  'ACTIVE FILE: src/study/capture.py (python, 214 lines), cursor at line 42, inside function capture_word';
const VISIBLE = 'VISIBLE: lines 30-70';
const TABS = 'OTHER OPEN TABS: src/study/srs.py, src/accounts/models.py';

/** Snapshots mirroring what ContextEngine produces at runtime. */
const CONTEXTS: Record<string, string> = {
  default: [WORKSPACE, ACTIVE_FILE, VISIBLE, TABS].join('\n'),
  noWorkspace: [
    'WORKSPACE: none — the user has NO folder or project open in VS Code. Code navigation, search and repo questions are impossible until they open one.',
  ].join('\n'),
  selection: [WORKSPACE, ACTIVE_FILE, 'SELECTION: lines 40-58', VISIBLE, TABS].join('\n'),
  withReferents: [
    WORKSPACE,
    ACTIVE_FILE,
    VISIBLE,
    'REFERENTS (things Kato listed; the user may point at them by number/ID):',
    'R1: src/study/capture.py:40 — `def capture_word(text, section_id):`',
    'R2: src/study/llm.py:88 — `def analyze(text):`',
    'R3: src/accounts/views.py:120 — `class RegisterView(APIView):`',
    'R4: src/billing/credits.py:15 — `def meter(cost):`',
    'R5: src/study/srs.py:60 — `def review_card(card, rating):`',
  ].join('\n'),
  // Cached agent knowledge in the snapshot — the setup where explicit tour
  // requests used to get downgraded to answer (the notes "already answer" them).
  withRepoNotes: [
    WORKSPACE,
    ACTIVE_FILE,
    VISIBLE,
    'REPO NOTES (from earlier agent explorations of this workspace):\n' +
      '- Q: explain the architecture of this repo\n' +
      '  A: lexr is a spaced-repetition study app: capture.py ingests words, llm.py analyzes them with an LLM, srs.py schedules reviews and billing/credits.py meters usage.',
  ].join('\n'),
  tourActive: [
    WORKSPACE,
    ACTIVE_FILE,
    VISIBLE,
    'TOUR: active with 8 stops, at stop 2 (src/study/urls.py:12). "next/siguiente", "previous/anterior", "repeat/repite", "stop/termina" control it.',
  ].join('\n'),
  debugPaused: [
    WORKSPACE,
    ACTIVE_FILE,
    VISIBLE,
    'DEBUG: session active, paused at src/study/capture.py:42 — "step/siguiente" → step_over, "continue/continúa" → continue, ' +
      '"what is X / cuánto vale X" → evaluate, "stop the debugger" → stop.',
  ].join('\n'),
  agentWorking: [
    WORKSPACE,
    ACTIVE_FILE,
    'AGENT: claude-code session working (mode agent), task: "refactor the capture flow into a service", 6 tools used. Recent tools: Read src/study/capture.py; Edit src/study/capture.py.',
  ].join('\n'),
  agentWaitingApproval: [
    WORKSPACE,
    ACTIVE_FILE,
    'AGENT: claude-code session WAITING FOR VOICE APPROVAL: "correr pytest -k capture" — an affirmative ("sí", "dale", ' +
      '"apruébalo", "yes") → agent_control approve, a negative → agent_control deny. NEVER confirm_action. (mode agent), ' +
      'task: "run the capture tests", 4 tools used. Permission levels this agent supports: plan, ask, agent, auto — ' +
      '"what modes do you have" → agent_control list_modes, "put it on X" → agent_control set_mode.',
  ].join('\n'),
  // The agent finished its turn and asked the user something in plain text.
  // Every affirmative here is a NEW instruction, not an approval.
  agentReady: [
    WORKSPACE,
    ACTIVE_FILE,
    'AGENT: claude-code session ready — it finished its turn. An affirmative or a restated task is a NEW instruction: ' +
      'agent_control is wrong, use agent_delegate to steer it. (mode agent), task: "push the changes to main", 11 tools ' +
      'used. Recent tools: correr git status; correr git log -1. Permission levels this agent supports: plan, ask, agent, ' +
      'auto — "what modes do you have" → agent_control list_modes, "put it on X" → agent_control set_mode.',
  ].join('\n'),
  planReady: [
    WORKSPACE,
    ACTIVE_FILE,
    'AGENT: claude-code session ready (mode plan), task: "move scoring into its own service", 9 tools used. The agent presented a plan and is waiting for the user to approve execution.',
  ].join('\n'),
  withProblems: [
    WORKSPACE,
    ACTIVE_FILE,
    VISIBLE,
    'PROBLEMS: 4 error(s), 2 warning(s) — errors in capture, llm. "¿qué errores hay?" → problems summary; "arréglalos / fix the errors" → problems fix.',
  ].join('\n'),
  pendingConfirmation: [
    WORKSPACE,
    ACTIVE_FILE,
    'PENDING CONFIRMATION: commit on main with message "fix: validate capture payload" — a yes/no answer means confirm_action.',
  ].join('\n'),
  gitChanges: [
    WORKSPACE,
    ACTIVE_FILE,
    'GIT: branch main, 3 changed files (src/study/capture.py, src/study/llm.py, tests/test_capture.py).',
  ].join('\n'),
};

const CONCURRENCY = 6;

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Set OPENAI_API_KEY to run the router evaluation.');
    process.exit(2);
  }
  const model = process.env.ROUTER_MODEL ?? 'gpt-4.1-mini';
  const minAccuracy = Number(process.env.ROUTER_MIN_ACCURACY ?? '0.9');
  // Bundled into dist/, so resolve the dataset from the repo root instead.
  const casesPath = path.join(process.cwd(), 'eval', 'router', 'cases.json');
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as Case[];
  const only = process.env.ROUTER_ONLY_TOOL;
  const selected = only ? cases.filter((c) => c.expect === only) : cases;

  const router = new IntentRouter(
    async () => apiKey,
    () => model,
  );

  console.log(`Routing ${selected.length} cases through ${model}…\n`);
  const results: Array<{ case: Case; got: string; ok: boolean }> = [];
  let index = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const current = index++;
      if (current >= selected.length) {
        return;
      }
      const testCase = selected[current];
      const snapshot = CONTEXTS[testCase.context];
      if (!snapshot) {
        results.push({ case: testCase, got: `UNKNOWN CONTEXT ${testCase.context}`, ok: false });
        continue;
      }
      let got = 'ERROR';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const intent = await router.route({
            transcript: testCase.utterance,
            snapshotText: snapshot,
            history: [],
            signal: AbortSignal.timeout(30_000),
          });
          // Tool alone is not the decision: agent_control approve and
          // agent_control set_mode do completely different things.
          got = testCase.expectAction
            ? `${intent.tool}:${String(intent.args.action ?? intent.args.direction ?? 'none')}`
            : intent.tool;
          break;
        } catch (err) {
          got = `ERROR ${String(err instanceof Error ? err.message : err).slice(0, 60)}`;
        }
      }
      const want = testCase.expectAction ? `${testCase.expect}:${testCase.expectAction}` : testCase.expect;
      results.push({ case: testCase, got, ok: got === want });
      process.stdout.write(got === want ? '.' : 'x');
    }
  });
  await Promise.all(workers);

  const passed = results.filter((r) => r.ok).length;
  const accuracy = passed / results.length;
  console.log(`\n\nAccuracy: ${passed}/${results.length} (${(accuracy * 100).toFixed(1)}%)\n`);

  const byTool = new Map<string, { total: number; ok: number }>();
  for (const result of results) {
    const entry = byTool.get(result.case.expect) ?? { total: 0, ok: 0 };
    entry.total++;
    if (result.ok) {
      entry.ok++;
    }
    byTool.set(result.case.expect, entry);
  }
  console.log('Per tool:');
  for (const [tool, entry] of [...byTool.entries()].sort((a, b) => a[1].ok / a[1].total - b[1].ok / b[1].total)) {
    const pct = ((entry.ok / entry.total) * 100).toFixed(0);
    console.log(`  ${pct.padStart(3)}%  ${String(entry.ok).padStart(3)}/${String(entry.total).padEnd(3)} ${tool}`);
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) {
      console.log(
        `  [${failure.case.context}] "${failure.case.utterance}"\n      expected ${failure.case.expect}, got ${failure.got}` +
          (failure.case.note ? `\n      note: ${failure.case.note}` : ''),
      );
    }
  }

  if (accuracy < minAccuracy) {
    console.error(`\nBelow the ${(minAccuracy * 100).toFixed(0)}% gate.`);
    process.exit(1);
  }
}

void main();
