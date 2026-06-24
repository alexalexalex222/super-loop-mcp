// Frozen facts the whole server is built around. Pure data only — no logic, no I/O.

// The two mandated, hash-locked FULL PRIVATE loop sources. These hashes are the
// contract: loops.mjs refuses to start if the bundled bytes do not match, and the
// test suite re-derives both from disk. Both are byte-identical to the operator's
// full private sources (no lite/public/summarized/reconstructed text). The
// supervisor — not edits to the loop text — owns stop policy, so the loops stay
// verbatim. The 345-line file is The Strip Miner Loop (the local big cross-agent
// miner, NOT the short 3-paragraph GitHub one); the 75-line file is Loop-de-loop
// (Loop 2), the full private improvement loop. "Loop hardener" is NOT a product
// name; the product loop is Loop-de-loop. ("loop-hardener"/"hardener" survive only
// as back-compat resolution aliases.)
export const MANDATED_LOOPS = {
  'strip-miner': {
    id: 'strip-miner',
    file: 'strip-miner.txt',
    sha256: '5270d691319120758423503e74c5aa6b378409b55f30bc6d2f2f7ca283ed9ec9',
    lines: 345,
    trigger: '/loop strip-miner',
    aka: ['the-strip-miner-loop', 'strip-miner-loop', 'cross-agent-strip-miner', 'miner'],
    role: 'mine',
    title: 'The Strip Miner Loop',
    // A few section headers that exist ONLY in the full 345-line miner. Used to
    // prove the short GitHub miner was not substituted in.
    bigMinerMarkers: [
      'DURABLE READER WAVES',
      'CONTRADICTION SWEEP',
      'CLEAN-CONTEXT REPLAY',
      'INDEPENDENT ROOT-TASK PROOF',
      'WEB LOOP SCOUTING AND EXTERNAL INSPIRATION',
      'PUBLICATION AND SHARING BOUNDARY'
    ]
  },
  'loop-de-loop': {
    id: 'loop-de-loop',
    file: 'loop-de-loop.md',
    sha256: '70090e033e995374710722771372d1afb17b6f0f823b2ce2911d9bfd38022b44',
    lines: 75,
    trigger: '/loop loop-de-loop',
    aka: ['loop-2', 'loop2', 'loop-de-loop-hardener', 'loop-hardener', 'hardener'],
    role: 'improve',
    title: 'Loop-de-loop (Loop 2)',
    bigMinerMarkers: []
  }
};

// Dashboard warning string — asserted verbatim in tests so the contract stays
// visible. Operator-specified exact text.
export const STOP_CONDITION_WARNING =
  'WARNING: You are the stop condition. This loop does not stop until you stop it.';

// On-start notice: tell the WORKER its runtime's native continuous/agentic command
// so the campaign is not stopped early by the runtime itself. Surfaced at init
// alongside the stop-condition warning; the operator is still the only stop condition.
export const NATIVE_CONTINUATION_NOTICE =
  'On start, engage your runtime’s native continuous mode so this run is not stopped early: ' +
  'Claude Code → /loop, Codex → /goal, other runtimes → your equivalent continuous/agentic loop command. ' +
  'Then keep working the phase gate until the operator stops you — do not self-complete.';

// Default model the server proposes when the operator does not name one.
// "the most capable available model" — the operator may override at init, and
// the agent is told to web-search current SOTA before committing.
export const DEFAULT_PRIMARY_MODEL = 'claude-opus-4-8';

// Named current-frontier routes (advisory only — banlist below is the hard gate).
export const KNOWN_FRONTIER_EXAMPLES = ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2', 'gemini-3-pro'];

// Builds and IN-LOOP GATING route ONLY to these trusted builder/gating workers.
// Codex/GPT remains a supported HOST surface but is NOT a trusted in-loop builder
// or gating worker (it keeps re-architecting the spec), so it is excluded here.
// This does not narrow the general frontier set used for hypothesis test workers.
export const BUILDER_GATING_ROUTES = ['claude-opus-4-8', 'glm-5.2'];

export const DEFAULTS = {
  failurePatience: 12, // consecutive no-improvement full tests before a RISK ADVISORY (spec: 10–15); advisory never stops the run
  branchRetirementBatches: 30, // valid full real test batches with no qualifying improvement before a branch RETIRES and PIVOTS to the next lane (never a campaign stop)
  hypothesisMin: 3,
  hypothesisMax: 5,
  fullTestAgentsMin: 3, // each full test = 3–5 agents actually running the loop
  fullTestAgentsMax: 5,
  promotion: {
    minQualityGain: 0.05, // quality is 0..1; a real win moves it by >= 5 pts
    costRegressionTolerance: 0.15, // a quality win may cost up to +15% tokens
    minCostSaving: 0.10 // a cost win must cut >= 10% tokens with no quality loss
  }
};

// Campaign lane vocabulary. Lanes are how the supervisor models the target queue:
// a 'mine' lane runs the Strip Miner; an 'improve' lane runs Loop-de-loop. On
// saturation/retirement the supervisor AUTO-TRANSITIONS to the next lane. None of
// these are pause/await/stop states — there is no valid terminal campaign state.
export const LANE_KIND = { MINE: 'mine', IMPROVE: 'improve' };
export const LANE_STATUS = { ACTIVE: 'active', SATURATED: 'saturated', RETIRED: 'retired' };

// Run / cycle status vocabulary.
export const STATUS = {
  AWAITING_ANSWERS: 'AWAITING_ANSWERS',
  INITIALIZED: 'INITIALIZED',
  ACTIVE: 'ACTIVE',
  NEEDS_RESUME: 'NEEDS_RESUME'
};

// Block codes — every BLOCKED result carries one so callers (and tests) can branch.
export const BLOCK = {
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  UNKNOWN_RUN: 'UNKNOWN_RUN',
  NO_ACTIVE_LOOP: 'NO_ACTIVE_LOOP',
  NOT_STARTED: 'NOT_STARTED',
  PHASE_SKIP: 'PHASE_SKIP',
  UNKNOWN_LOOP: 'UNKNOWN_LOOP',
  BASELINE_FIRST: 'BASELINE_FIRST',
  BASELINE_LOCKED: 'BASELINE_LOCKED',
  BASELINE_BAR_FIRST: 'BASELINE_BAR_FIRST',
  BENCHMARK_FIRST: 'BENCHMARK_FIRST',
  BENCHMARK_FROZEN: 'BENCHMARK_FROZEN',
  WEAK_BENCHMARK: 'WEAK_BENCHMARK',
  HYPOTHESIS_COUNT: 'HYPOTHESIS_COUNT',
  BANNED_ROUTE: 'BANNED_ROUTE',
  UNKNOWN_HYPOTHESIS: 'UNKNOWN_HYPOTHESIS',
  FULLTEST_AGENTS: 'FULLTEST_AGENTS',
  MODEL_REPORTED: 'MODEL_REPORTED',
  NO_SCORE_MATRIX: 'NO_SCORE_MATRIX',
  NOT_REVERIFIED: 'NOT_REVERIFIED',
  BELOW_THRESHOLD: 'BELOW_THRESHOLD',
  BELOW_FLOOR: 'BELOW_FLOOR',
  STAGED_TRADEOFF: 'STAGED_TRADEOFF',
  OPERATOR_IS_STOP: 'OPERATOR_IS_STOP',
  DASHBOARD_ONLY: 'DASHBOARD_ONLY',
  MEASUREMENT_AUTHORITY: 'MEASUREMENT_AUTHORITY', // a caller-reported (not tool-computed) cost reached a gate
  QUALITY_UNVERIFIED: 'QUALITY_UNVERIFIED',       // a quality win the MCP cannot tool-verify → dashboard, never auto-promote
  LOOP_EXISTS: 'LOOP_EXISTS',                     // custom loop id collides with a mandated/registered loop
  LOOP_SOURCE: 'LOOP_SOURCE',                     // custom loop source is empty/too small to phase-gate
  NO_ACTIVE_LANE: 'NO_ACTIVE_LANE',               // a supervisor lane op ran with no active lane
  BUILDER_ROUTE: 'BUILDER_ROUTE',                 // a build / in-loop gating step routed to a non-builder (e.g. codex/gpt) worker
  EXEC_DISABLED: 'EXEC_DISABLED',                 // live worker execution requested but SUPER_LOOP_ALLOW_EXEC is not set
  EXEC_FAILED: 'EXEC_FAILED',                     // a launched worker failed/timed out/was not allowlisted → invalid batch (does not count)
  BAD_INPUT: 'BAD_INPUT'
};

// Verdicts a measured full test can carry. NO_IMPROVEMENT is never "perfect".
export const VERDICT = {
  MOVED_FRONTIER: 'MOVED_FRONTIER',
  NO_IMPROVEMENT: 'NO_IMPROVEMENT',
  NEEDS_MEASUREMENT: 'NEEDS_MEASUREMENT'
};
