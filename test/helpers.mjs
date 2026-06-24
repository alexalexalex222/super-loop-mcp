// Shared test helpers. Each engine gets an isolated temp home and a deterministic
// monotonic clock so runs never collide and timestamps are reproducible.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createEngine } from '../src/engine.mjs';
import { DEFAULT_QUALITY_ORACLE, buildMeasuredContent } from '../src/measure.mjs';

export function freshEngine() {
  const home = mkdtempSync(join(tmpdir(), 'superloop-'));
  const store = createStore(home);
  let t = 0;
  const clock = () => `2026-06-23T00:00:${String(t++ % 60).padStart(2, '0')}.000Z`;
  const engine = createEngine(store, { clock });
  return { engine, store, home };
}

// A fully-specified task so initialize_loop_run skips the ask-once questions.
export const SPECIFIC_TASK =
  'Improve the strip-miner loop to raise candidate precision by at least 10% while keeping token cost under the current benchmark.';

/**
 * Record a TOOL-COMPUTED raw artifact and return its id (the reverifiable
 * measurementRef). The run-log content is sized + probe-seeded so the MCP DERIVES
 * exactly (tokenCost, quality) from the bytes against the frozen probe oracle —
 * the model never hands the MCP a bare number.
 */
export function recordMeasurement(engine, runId, label, tokenCost, quality) {
  const r = engine.artifact_record({
    runId, name: label, role: 'runlog',
    content: buildMeasuredContent(tokenCost, quality, DEFAULT_QUALITY_ORACLE),
    measurement: { tokenCost, quality }
  });
  return r.artifactId;
}

/** Record an explicitly CALLER-REPORTED (weak) measurement — used to prove the gates refuse it. */
export function recordCallerReported(engine, runId, label, tokenCost, quality) {
  const r = engine.artifact_record({
    runId, name: label, role: 'runlog',
    content: `caller-reported run ${label}`,
    measurement: { tokenCost, quality }, callerReported: true
  });
  return r.artifactId;
}

/** Drive init → baseline lock → frozen benchmark (with a deterministic oracle) → measured baseline bar. */
export function initThroughBaselineBar(engine, runId, { baseQuality = 0.7, baseCost = 1000 } = {}) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK, userMessages: ['build it', 'use the full loops'] });
  engine.artifact_record({ runId, role: 'baseline', name: 'baseline.md', content: 'BASELINE LOOP TEXT v1' });
  const prop = engine.benchmark_propose({
    runId,
    benchmarks: [{
      name: 'miner-precision',
      taskValueDimensions: ['candidate-precision', 'evidence-fidelity'],
      resourceDimensions: ['token-cost'],
      cases: [{ id: 'c1', input: 'session-corpus-A', expect: '3 qualified loops' }],
      oracle: DEFAULT_QUALITY_ORACLE
    }]
  });
  engine.benchmark_select({ runId, benchmarkId: prop.benchmarkIds[0] });
  const ref = recordMeasurement(engine, runId, 'baseline-bar', baseCost, baseQuality);
  engine.benchmark_run({ runId, arm: 'baseline', measurementRef: ref });
}

export function parseToolText(callResult) {
  return JSON.parse(callResult.content[0].text);
}
