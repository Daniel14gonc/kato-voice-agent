import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // The Agent SDK is ESM-only and locates its bundled CLI via import.meta —
  // it must stay external (loaded with a native dynamic import at runtime).
  external: ['vscode', '@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();

  // Router evaluation harness (runs outside VS Code; see npm run eval:router).
  await esbuild.build({
    entryPoints: ['eval/router/run.ts'],
    bundle: true,
    outfile: 'dist/eval-router.js',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    logLevel: 'warning',
  });
}
