// Sling core. Every tool handler lives here. The point is simple: a model
// cannot promote, advance, or declare anything "done" from reasoning alone.
// Each gate demands tool-measured artifacts on disk, and the operator is the
// only stop condition.
import {
  STATUS, BLOCK, VERDICT, DEFAULTS, DEFAULT_PRIMARY_MODEL, KNOWN_FRONTIER_EXAMPLES, STOP_CONDITION_WARNING,
  NATIVE_CONTINUATION_NOTICE, LANE_KIND, LANE_STATUS, BUILDER_GATING_ROUTES, MANDATED_LOOPS
} from './constants.mjs';
import { sha256, hash8, nowIso, wordCount, round, mean, stdev, isSafeId } from './util.mjs';
import { classifyRoute, rejectedRoutes, rejectedBuilderRoutes } from './models.mjs';
import { evaluatePromotion } from './scorecard.mjs';
import { resolveLoopId, loadLoop, loopSummary, makeCustomLoop, isMandatedId, verifyAllLoops } from './loops.mjs';
import { renderDashboard, renderReport } from './dashboard.mjs';
import { deriveMeasurement, estimateTokens, scoreOracle, isDeterministicOracle, TOOL_AUTHORITY, CALLER_AUTHORITY } from './measure.mjs';
import { detectHostCapabilities } from './host.mjs';
import { existsSync } from 'node:fs';
import { isExecEnabled, runWorker, execBinaryForRoute, executorWorker } from './executor.mjs';
import { runSupervisedCampaign } from './supervisor.mjs';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const ok = (message, extra = {}) => ({ status: 'OK', message, ...extra });
const blocked = (code, message, extra = {}) => ({ status: 'BLOCKED', code, message, ...extra });

export function createEngine(store, { clock = nowIso } = {}) {
  // ---- state scaffolding -------------------------------------------------
  function freshRun(runId, ts) {
    return {
      runId, version: 1, createdAt: ts, updatedAt: ts,
      status: STATUS.AWAITING_ANSWERS,
      task: { text: '', sha256: '', sufficiency: 'unknown', acceptanceCriteria: null, mode: 'unknown' },
      config: {
        model: { primary: DEFAULT_PRIMARY_MODEL, declared: false, autoSelected: true },
        failurePatience: DEFAULTS.failurePatience,
        branchRetirementBatches: DEFAULTS.branchRetirementBatches,
        promotion: { ...DEFAULTS.promotion },
        comparisonRule: 'pareto'
      },
      userMessages: [], questions: [], answers: [],
      loops: {}, activeLoop: null, customLoops: {},
      baseline: { recorded: false },
      benchmark: { proposals: [], frozen: false, def: null, baselineScore: null, epoch: 0 },
      hypotheses: [], tests: [],
      failures: { consecutive: 0, total: 0, exhaustionFlagged: false },
      // Supervisor target queue. Lanes are how Sling owns transitions: a 'mine'
      // lane runs the Strip Miner, an 'improve' lane runs Loop-de-loop. On
      // saturation/retirement the supervisor AUTO-TRANSITIONS to the next lane —
      // there is no pause/await/stop lane and no terminal campaign state.
      campaign: { lanes: [], activeLaneId: null, transitions: [] },
      decisions: [], promotions: [], humanReviews: [], observations: [],
      counters: { artifact: 0, observation: 0, hypothesis: 0, test: 0, review: 0, decision: 0, promotion: 0, benchmark: 0, continuation: 0, lane: 0, transition: 0 },
      dashboardPath: null, reportPath: null,
      dashboard: { alwaysOn: true, reviewAuthority: 'dashboard-only', modelCanResolveReview: false },
      continuation: { required: false, id: null, since: null, source: null, reason: null, next: null, clearedAt: null, clearedBy: null, history: [] },
      log: []
    };
  }
  function nextId(state, kind, prefix) {
    state.counters[kind] = (state.counters[kind] || 0) + 1;
    return `${prefix}-${String(state.counters[kind]).padStart(3, '0')}`;
  }
  function logEvent(state, event, detail) {
    state.log.push({ ts: clock(), event, detail: detail || null });
  }
  function invalidIdBlock(label, value) {
    return blocked(BLOCK.BAD_INPUT,
      `Invalid ${label} "${String(value || '')}". Use letters/numbers plus ".", "_" or "-" only; no slashes, spaces, or path traversal.`,
      { label, value: String(value || '') });
  }
  function loadRun(args) {
    if (!args || !args.runId) return null;
    if (!isSafeId(args.runId)) return { __blocked: invalidIdBlock('runId', args.runId) };
    return store.exists(args.runId) ? store.load(args.runId) : null;
  }
  function requireInitialized(state) {
    if (state && state.__blocked) return state.__blocked;
    if (![STATUS.INITIALIZED, STATUS.ACTIVE, STATUS.NEEDS_RESUME].includes(state.status)) {
      return blocked(BLOCK.NOT_INITIALIZED,
        'Run is not initialized. Call initialize_loop_run first (the ask-once gate) so the loop never runs on an unconfirmed task.',
        { runStatus: state.status });
    }
    return null;
  }
  // ---- loop resolution (mandated + user-added custom loops) --------------
  // A run pins a snapshot of any custom loop it streams into state.customLoops so
  // the source is immutable for the life of the run (and hash-locked on every load).
  function customLoopRecord(state, id) {
    if (state.customLoops && state.customLoops[id]) return state.customLoops[id];
    return store.readLoop(id);
  }
  function canonLoopId(state, arg) {
    const mandated = resolveLoopId(arg);
    if (mandated) return mandated;
    if (!arg) return null;
    const key = String(arg).toLowerCase().trim();
    if (!isSafeId(key)) return null;
    if ((state.customLoops && state.customLoops[key]) || store.loopExists(key)) return key;
    return null;
  }
  function unknownLoopBlock(state, arg) {
    const value = String(arg == null ? '' : arg);
    const key = value.toLowerCase().trim();
    if (key && !isSafeId(key)) return invalidIdBlock('loop', value);
    const custom = store.listLoops();
    return blocked(BLOCK.UNKNOWN_LOOP,
      `Unknown loop "${value || '<empty>'}". Mandated: strip-miner (The Strip Miner Loop) or loop-de-loop (Loop 2, the improvement loop).${custom.length ? ` Custom local loops: ${custom.join(', ')}.` : ' Register your own with loop_register.'}`,
      { customLoops: custom });
  }
  function requestedLoopTarget(state, arg, { fallbackActive = false } = {}) {
    const explicit = arg != null && String(arg).trim() !== '';
    if (explicit) {
      const id = canonLoopId(state, arg);
      if (!id) return { error: unknownLoopBlock(state, arg) };
      return { id, explicit: true };
    }
    if (fallbackActive && state.activeLoop) return { id: state.activeLoop, explicit: false };
    return { id: null, explicit: false };
  }
  function phaseEvidenceTarget(state, args) {
    const wantsPhase = args.loop != null || Number.isInteger(args.phase);
    if (!wantsPhase) return { wantsPhase: false };
    const target = requestedLoopTarget(state, args.loop, { fallbackActive: true });
    if (target.error) return { error: target.error };
    if (!target.id) {
      return { error: blocked(BLOCK.NO_ACTIVE_LOOP, 'No active loop. Start a loop before recording phase evidence, or pass an explicit valid loop id.') };
    }
    const ls = state.loops[target.id];
    if (!ls) return { error: blocked(BLOCK.NOT_STARTED, `Loop "${target.id}" not started. Call loop_start { loop:"${target.id}" } before recording phase evidence.`) };
    const phase = Number.isInteger(args.phase) ? args.phase : ls.phaseCursor;
    if (phase < 0 || phase >= ls.totalPhases) {
      return { error: blocked(BLOCK.BAD_INPUT, `Phase ${phase} is outside loop "${target.id}" bounds 0..${ls.totalPhases - 1}.`, { loop: target.id, phase, totalPhases: ls.totalPhases }) };
    }
    return { wantsPhase: true, loop: target.id, phase };
  }
  function loadAnyLoop(state, id) {
    if (resolveLoopId(id)) return loadLoop(id);
    const rec = customLoopRecord(state, id);
    if (!rec) throw new Error(`unknown loop: ${id}`);
    return makeCustomLoop(rec);
  }
  function continuationDirective(state, context = '') {
    const prefix = context ? `${context} ` : '';
    return `${prefix}Reports, dashboards, saturation findings, and no-improvement advisories are checkpoints, not stopping points. If this lane is exhausted, pivot to the next runnable improvement lane while the dashboard stays available for operator review.`;
  }
  function ensureContinuation(state) {
    if (!state.continuation) {
      state.continuation = { required: false, id: null, since: null, source: null, reason: null, next: null, clearedAt: null, clearedBy: null, history: [] };
    }
    if (!Array.isArray(state.continuation.history)) state.continuation.history = [];
    return state.continuation;
  }
  function recommendedNextAction(state) {
    const active = state.activeLoop && state.loops[state.activeLoop] ? state.activeLoop : null;
    if (active) {
      const ls = state.loops[active];
      const ev = (ls.evidence && ls.evidence[ls.phaseCursor]) || [];
      if (ev.length === 0) {
        return {
          tool: 'observation_record',
          args: { runId: state.runId, loop: active, phase: ls.phaseCursor, summary: '<evidence from the work just performed>' },
          reason: `current streamed phase ${ls.phaseCursor} needs evidence before the next phase`
        };
      }
      if (ls.phaseCursor + 1 < ls.totalPhases) {
        return { tool: 'request_next_phase', args: { runId: state.runId, loop: active }, reason: 'current phase has evidence; stream the next phase' };
      }
    }
    if (!state.baseline.recorded) {
      return { tool: 'artifact_record', args: { runId: state.runId, role: 'baseline', content: '<frozen baseline loop/artifact bytes>' }, reason: 'hash-lock the baseline before benchmark selection' };
    }
    if (!state.benchmark.frozen) {
      return { tool: 'benchmark_propose', args: { runId: state.runId, benchmarks: ['<scorecard with value dimensions, cost dimensions, and real cases>'] }, reason: 'freeze the task-specific benchmark before challengers' };
    }
    if (!state.benchmark.baselineScore) {
      return { tool: 'benchmark_run', args: { runId: state.runId, arm: 'baseline', measurementRef: '<tool-measured artifact id>' }, reason: 'set the tool-measured baseline bar' };
    }
    const moved = (state.tests || []).find((t) => t.verdict === VERDICT.MOVED_FRONTIER && !t.reverified);
    if (moved) {
      return { tool: 'reverify_run', args: { runId: state.runId, testId: moved.id }, reason: 'deep-reverify the moved-frontier evidence before promotion' };
    }
    const untested = (state.hypotheses || []).find((h) => !(state.tests || []).some((t) => t.hypothesisId === h.id));
    if (untested) {
      return { tool: 'test_hypothesis', args: { runId: state.runId, hypothesisId: untested.id, fullTest: { agentRuns: ['<3-5 frontier measured runs>'] } }, reason: 'run a full measured test for the next registered hypothesis' };
    }
    return {
      tool: 'register_hypotheses',
      args: { runId: state.runId, hypotheses: ['<3-5 new frontier hypotheses for the next bottleneck/lane>'] },
      reason: 'continue into the next runnable improvement lane'
    };
  }
  function continuationPayload(state) {
    const c = ensureContinuation(state);
    return {
      required: !!c.required,
      id: c.id || null,
      source: c.source || null,
      reason: c.reason || null,
      since: c.since || null,
      next: c.next || recommendedNextAction(state),
      inProgress: !!c.inProgress,
      lastCommitment: c.lastCommitment || null,
      clearedAt: c.clearedAt || null,
      clearedBy: c.clearedBy || null
    };
  }
  function requireContinuation(state, source, reason) {
    const c = ensureContinuation(state);
    const ts = clock();
    if (!c.required) c.id = nextId(state, 'continuation', 'cont');
    c.required = true;
    c.inProgress = false;
    c.since = c.since || ts;
    c.source = source;
    c.reason = reason;
    c.next = recommendedNextAction(state);
    c.clearedAt = null;
    c.clearedBy = null;
    c.history.push({ id: c.id, ts, event: 'required', source, reason, next: c.next });
    logEvent(state, 'continuation_required', { id: c.id, source });
    return c;
  }
  function clearContinuation(state, source, detail = null) {
    const c = ensureContinuation(state);
    if (!c.required) return c;
    const ts = clock();
    c.required = false;
    c.inProgress = false;
    c.clearedAt = ts;
    c.clearedBy = source;
    c.history.push({ id: c.id, ts, event: 'cleared', source, detail });
    logEvent(state, 'continuation_cleared', { id: c.id, source });
    return c;
  }
  // ---- supervisor lanes / target queue / auto-transition -----------------
  // The supervisor owns transitions. Worker output is an untrusted proposal; only
  // a supervisor-accepted transition counts as progress. On saturation or branch
  // retirement the supervisor AUTO-TRANSITIONS to the next lane — it never pauses,
  // awaits the operator, or marks the campaign complete. The operator is the only
  // stop condition.
  function ensureCampaign(state) {
    if (!state.campaign) state.campaign = { lanes: [], activeLaneId: null, transitions: [] };
    if (!Array.isArray(state.campaign.lanes)) state.campaign.lanes = [];
    if (!Array.isArray(state.campaign.transitions)) state.campaign.transitions = [];
    return state.campaign;
  }
  function laneKindForLoop(loopId) {
    const meta = MANDATED_LOOPS[loopId];
    if (meta && meta.role === 'mine') return LANE_KIND.MINE;
    return LANE_KIND.IMPROVE; // loop-de-loop, custom loops, and improvement lanes
  }
  function activeLane(state) {
    const c = ensureCampaign(state);
    return c.lanes.find((l) => l.id === c.activeLaneId) || null;
  }
  // The current improvement branch. If none is active (e.g. after a retirement
  // pivot, or tests run without an explicit loop_start), open a fresh improve lane
  // so branch accounting always has a home. Never returns null.
  function ensureActiveLane(state) {
    const existing = activeLane(state);
    if (existing && existing.status === LANE_STATUS.ACTIVE) return existing;
    return ensureLaneForLoop(state, state.activeLoop || 'loop-de-loop');
  }
  function ensureLaneForLoop(state, loopId) {
    const c = ensureCampaign(state);
    let lane = c.lanes.find((l) => l.loop === loopId && l.status === LANE_STATUS.ACTIVE);
    if (!lane) {
      lane = { id: nextId(state, 'lane', 'lane'), kind: laneKindForLoop(loopId), loop: loopId, status: LANE_STATUS.ACTIVE, noImproveBatches: 0, since: clock(), retiredAt: null };
      c.lanes.push(lane);
    }
    c.activeLaneId = lane.id;
    return lane;
  }
  // Decide the next lane after the current one saturates/retires. Mining → improve
  // the best available loop with Loop-de-loop; improving → the next improvement
  // branch (operator queues the loop; the supervisor never stops to ask).
  function planNextLane(state, fromLane) {
    if (fromLane && fromLane.kind === LANE_KIND.MINE) {
      return { kind: LANE_KIND.IMPROVE, loop: 'loop-de-loop',
        firstAction: 'loop_start { loop:"loop-de-loop" } to harden the best available loop, then lock baseline → freeze benchmark → 3-5 frontier challengers' };
    }
    return { kind: LANE_KIND.IMPROVE, loop: null,
      firstAction: 'open the next improvement branch: register_hypotheses for the next bottleneck (or loop_start a queued loop), then run full measured tests' };
  }
  // The auto-transition itself. `cause` is 'saturation' | 'branch_retirement'.
  function autoTransition(state, cause, detail = {}) {
    const c = ensureCampaign(state);
    const from = activeLane(state);
    if (from) {
      from.status = cause === 'saturation' ? LANE_STATUS.SATURATED : LANE_STATUS.RETIRED;
      from.retiredAt = clock();
    }
    const plan = planNextLane(state, from);
    let to = null;
    if (plan.loop) {
      // reuse an existing active lane for that loop, else queue a fresh one
      to = c.lanes.find((l) => l.loop === plan.loop && l.status === LANE_STATUS.ACTIVE)
        || { id: nextId(state, 'lane', 'lane'), kind: plan.kind, loop: plan.loop, status: LANE_STATUS.ACTIVE, noImproveBatches: 0, since: clock(), retiredAt: null };
      if (!c.lanes.includes(to)) c.lanes.push(to);
      c.activeLaneId = to.id;
    } else {
      // No concrete next loop pinned yet; clear the active lane pointer but keep the
      // campaign running with a continuation that points at opening the next branch.
      c.activeLaneId = null;
    }
    const tid = nextId(state, 'transition', 'trans');
    c.transitions.push({ id: tid, ts: clock(), cause, from: from ? from.id : null, fromKind: from ? from.kind : null, to: to ? to.id : null, toKind: plan.kind, toLoop: plan.loop, detail });
    logEvent(state, 'auto_transition', { cause, from: from ? from.id : null, to: to ? to.id : null, toLoop: plan.loop });
    requireContinuation(state, `auto_transition_${cause}`,
      `${cause === 'saturation' ? 'Mining lane saturated' : 'Branch retired after ' + DEFAULTS.branchRetirementBatches + ' valid no-improvement test batches'} — supervisor auto-transitioned to the next ${plan.kind} lane. This is a pivot, not a stop. ${plan.firstAction}`);
    return { transitionId: tid, from, to, plan };
  }

  function writeDashboardForState(state) {
    const html = renderDashboard(state);
    const path = store.writeRunFile(state.runId, 'dashboard.html', html);
    state.dashboardPath = path;
    return { path, warningIncluded: html.includes(STOP_CONDITION_WARNING) };
  }

  // ---- ask-once helpers --------------------------------------------------
  function resolveModel(requested) {
    if (!requested) return { primary: DEFAULT_PRIMARY_MODEL, declared: false, warning: null };
    const c = classifyRoute(requested);
    if (c.ok) return { primary: requested, declared: true, warning: null };
    return { primary: DEFAULT_PRIMARY_MODEL, declared: false,
      warning: `requested model "${requested}" is non-frontier (${c.reason}); defaulting to ${DEFAULT_PRIMARY_MODEL}` };
  }
  function inferMode(text) {
    const t = String(text || '');
    const subjective = /\b(website|web ?page|landing|copy|copywrit|design|ui|ux|prompt|loop|email|content|brand|hero|logo|article|essay|story)\b/i.test(t);
    const deterministic = /\b(\d+\s?ms|latency|throughput|faster|load time|p9\d|compile|build time|memory|bundle size|fps|deterministic)\b/i.test(t);
    if (subjective && !deterministic) return 'subjective';
    if (deterministic && !subjective) return 'deterministic';
    return 'mixed';
  }
  function isTaskSpecific(text, ac) {
    if (ac && String(ac).trim().length > 0) return true;
    const t = String(text || '').trim();
    const words = wordCount(t);
    const hasMetric = /\b(\d+\s?(?:ms|s|sec|%|px|tokens?|fps)|under|over|at least|at most|<=|>=|pass(?:es|ing)?|score|benchmark|accuracy|conversion|p9\d|latency|reduce|increase)\b/i.test(t);
    const vagueOnly = /^(?:please\s+)?(?:just\s+)?(?:improve|fix|make (?:it|this|the loop) better|optimi[sz]e|enhance|do (?:the )?loop|better)\b/i.test(t) && !hasMetric;
    if (vagueOnly) return false;
    return words >= 8 && hasMetric;
  }
  // Ask-once questions cover ONLY what the operator alone can answer: the goal,
  // the starting point, how WIDE to mine, what ORDER to improve in, what "better"
  // means, and any task-specific hard limit. Model routes, promotion mode, benchmark
  // policy, and the standing guarantees are decided by the tool from the task —
  // never posed back to the operator. The deeper-explanation offer stays LAST
  // (wantsDeeperExplanation weights the final answer).
  function generateQuestions() {
    return [
      'In one sentence: what is the end result a successful run must produce?',
      'Start by MINING your sessions for a new/stronger loop (the Strip Miner), or go straight to IMPROVING an existing loop (Loop-de-loop)? If improving, name the loop/prompt/repo/page to start from.',
      'If mining: search your WHOLE session history, or stop after finding a set number of loops? Give a number, or say "whole history".',
      'After mining, improve the BEST loops first, or go in the order found? Heads-up — a run can go for hours, days, or weeks depending on the task and how deep I mine; best-first surfaces value soonest.',
      'In plain English, what would make the result clearly better? I turn this into the frozen, tool-measured benchmark.',
      'Anything task-specific I must not break? The standing guarantees — evidence-gated promotion, a hash-locked baseline, no cost regression, and your authorship — always hold, so name only the extras.',
      'Want me to explain how Sling enforces this before I start, or should I just keep moving after this?'
    ];
  }
  // Explain-first: a brief, plain-English account of what the run does and, more
  // importantly, what the operator decides versus what the tool decides — so the
  // questions above are answerable without a wall of policy choices.
  function askOnceExplanation() {
    return [
      'Sling is the supervisor/harness, not a prompt. It owns campaign state, the target queue, transitions, benchmark math, the dashboard, and stop policy.',
      'I hold the full private Strip Miner and Loop-de-loop inside the harness and stream them one section at a time, each gated on recorded evidence. A worker model can only PROPOSE artifacts or transitions; a summary, a "done", a confidence claim, or a bare tool call is never progress — only a supervisor-accepted transition counts. I freeze a benchmark from your definition of "better", lock the baseline by hash, measure baseline and challenger on the same yardstick, compute the delta myself, and re-verify from sealed bytes before any promotion.',
      'You decide the goal, whether to start by mining or by improving an existing loop, how wide to mine (your whole history or a set number of loops), what order to improve in (best-first or in order), what "better" means, and any hard limit. I decide the model routes (default ' + DEFAULT_PRIMARY_MODEL + ', strongest available; builds and in-loop gating route to ' + BUILDER_GATING_ROUTES.join(' or ') + '), the promotion rule, and the internal thresholds — those are mine, so you are not asked to set policy.',
      'If the Strip Miner saturates I auto-transition to Loop-de-loop or the next lane; a branch retires only after ' + DEFAULTS.branchRetirementBatches + ' valid no-improvement test batches and then pivots — it never ends the campaign. The dashboard stays open the whole run for your Approve/Sludge review, and the run never marks itself complete. You are the only stop condition.'
    ].join(' ');
  }
  function storeMessages(list) {
    return list.map((m, i) => ({ index: i, sha256: sha256(String(m)), chars: String(m).length, text: String(m) }));
  }
  // Leak #2: the 6th ask-once question offers a deeper explanation. Honor the
  // answer — if the operator asks for more, return it in the SAME initialized
  // response. Never re-ask, never block on it.
  function wantsDeeperExplanation(answers) {
    const arr = (answers || []).map((a) => String(a && a.text != null ? a.text : a));
    if (!arr.length) return false;
    // The deeper-explanation offer is always the last question, so weight the
    // last answer; still scan them all in case the operator answered out of order.
    const last = arr[arr.length - 1] || '';
    const hay = `${last} ${arr.join(' ')}`.toLowerCase();
    const positive = /(deep|deeper|more detail|more details|explain|elaborate|verbose|full explanation|tell me more|walk me through|go deeper|yes)/.test(hay);
    const negativeOnly = /(no thanks|no thank|keep moving|just start|skip it|brief is fine|move on|don'?t need|no need)/.test(hay)
      && !/(deep|deeper|more detail|explain|elaborate)/.test(hay);
    return positive && !negativeOnly;
  }
  function deeperExplanation(state) {
    const model = state.config.model.primary;
    return [
      'How Sling actually enforces this (the deeper explanation you asked for):',
      `1) Phase-gated streaming — the full private 345-line Strip Miner and 75-line Loop-de-loop (Loop 2) live inside the supervisor. loop_start hands you one section; request_next_phase only unlocks the next section after evidence is recorded for the current one (PHASE_SKIP otherwise). The full loop never collapses into context before real decisions. You can also add your own loops with loop_register, and they stream the same way.`,
      '2) Benchmark-first — you hash-lock a baseline (write-once) and freeze a task-specific scorecard before any challenger. The scorecard carries a deterministic oracle where possible so quality is tool-scored, not asserted.',
      '3) Tool-measured authority — every metric is derived by the MCP from the raw bytes you record (tokenCost always; quality via the frozen oracle). A number typed by the model is caller-reported and refused by the benchmark/test gates. reverify_run re-derives the metrics from the sealed bytes, so a tampered number cannot survive.',
      '4) The honest boundary — the MCP cannot prove the recorded bytes came from a real frontier-agent run, and it cannot judge subjective quality without an oracle. Subjective wins go to the dashboard for your Approve/Sludge decision and never auto-promote. Deterministic wins can promote autonomously. That split is intentional, not hidden.',
      `5) Frontier + parallel — full tests need 3–5 frontier agents (haiku/mini/nano/lite/prior-gen rejected). Default route ${model}; web-search current SOTA and run host_capability_preflight to see which CLIs are installed.`,
      '6) Continuation rule — reports, dashboards, saturation, and no-improvement advisories create a continuation obligation. continue_run records intent but cannot clear that obligation; only a real progress tool clears it. The operator is the only stop condition.'
    ].join('\n');
  }

  // ---- measurement helpers ----------------------------------------------
  // Every measured number must come from a recorded raw artifact, so it can be
  // re-hashed during reverify. Inline model-reported metrics are rejected.
  function resolveMeasurement(state, ref) {
    if (!ref) return { ok: false, reason: 'no measurementRef — record the raw run via artifact_record (content/measurement) and pass its id; the MCP derives the metrics from the bytes' };
    if (!isSafeId(ref)) return { ok: false, reason: 'invalid measurementRef id (no slashes, spaces, or path traversal)' };
    const art = store.readArtifact(state.runId, ref);
    if (!art) return { ok: false, reason: `measurementRef ${ref} not found` };
    if (!art.measurement) return { ok: false, reason: `artifact ${ref} has no measurement` };
    const tokenCost = Number(art.measurement.tokenCost);
    const quality = Number(art.measurement.quality);
    if (!(tokenCost >= 0) || !(quality >= 0 && quality <= 1)) {
      return { ok: false, reason: `measurement must have tokenCost>=0 and quality in [0,1] (got cost ${tokenCost}, quality ${quality})` };
    }
    return {
      ok: true, metrics: { tokenCost, quality },
      authority: { tokenCost: art.measurement.tokenCostAuthority || CALLER_AUTHORITY, quality: art.measurement.qualityAuthority || CALLER_AUTHORITY },
      measurementRef: ref, sha256: art.sha256
    };
  }
  function validateAgentRun(state, run) {
    const c = classifyRoute(run && run.model);
    if (!c.ok) return { ok: false, model: c.model, reason: `route ${c.model}: ${c.reason}`, code: BLOCK.BANNED_ROUTE };
    const m = resolveMeasurement(state, run && run.measurementRef);
    if (!m.ok) return { ok: false, model: c.model, reason: `agent run on ${c.model}: ${m.reason}`, code: BLOCK.MODEL_REPORTED };
    if (m.authority.tokenCost !== TOOL_AUTHORITY) {
      return { ok: false, model: c.model, code: BLOCK.MEASUREMENT_AUTHORITY,
        reason: `agent run on ${c.model}: tokenCost authority is "${m.authority.tokenCost}", not tool-computed. The MCP must derive cost from the recorded bytes — record the raw run via artifact_record without { callerReported:true } and pass that measurementRef. A number the model typed is not evidence.` };
    }
    return { ok: true, model: c.model, metrics: m.metrics, authority: m.authority, measurementRef: m.measurementRef, reverifiable: true };
  }
  function summarizeBenchmark(def) {
    return { id: def.id, name: def.name, taskValueDimensions: def.taskValueDimensions, resourceDimensions: def.resourceDimensions, cases: def.cases.length, comparisonRule: def.comparisonRule };
  }
  function sectionResult(loop, ls, section, mode) {
    const hasNext = section.index + 1 < loop.sections.length;
    return ok(`Streaming ${loop.meta.title} — phase ${section.index + 1}/${loop.sections.length}: ${section.title} (${mode})`, {
      loop: loop.id, trigger: loop.meta.trigger,
      phase: section.index, totalPhases: loop.sections.length, title: section.title,
      section: section.body,
      gate: hasNext
        ? `To unlock phase ${section.index + 1} (0-indexed), record evidence for THIS phase: observation_record or artifact_record with { loop:"${loop.id}", phase:${section.index} }. request_next_phase without evidence returns BLOCKED (PHASE_SKIP).`
        : 'This is the final section. Streaming complete is NOT campaign complete — proceed to baseline/benchmark/hypotheses.',
      note: 'The full loop is held inside the MCP. You get one section at a time so 300+ lines never collapse into the model before real decisions.'
    });
  }

  // ============================ TOOLS ====================================

  function initialize_loop_run(args = {}) {
    const ts = clock();
    const runId = args.runId || `run-${hash8(String(args.task || '') + ts)}`;
    if (!isSafeId(runId)) return invalidIdBlock('runId', runId);
    let state = store.exists(runId) ? store.load(runId) : freshRun(runId, ts);

    // Always (re)store user messages + task hash locally — this is the hook corpus.
    if (Array.isArray(args.userMessages)) state.userMessages = storeMessages(args.userMessages);
    if (typeof args.task === 'string' && args.task.trim()) {
      state.task.text = args.task;
      state.task.sha256 = sha256(args.task);
    }
    if (args.acceptanceCriteria) state.task.acceptanceCriteria = String(args.acceptanceCriteria);

    // Ask-once already satisfied → idempotent. NEVER ask again.
    if ([STATUS.INITIALIZED, STATUS.ACTIVE, STATUS.NEEDS_RESUME].includes(state.status)) {
      if (Array.isArray(args.answers)) {
        state.answers = args.answers.map((a, i) => ({ index: i, sha256: sha256(String(a)), text: String(a), ts }));
      }
      state.updatedAt = ts;
      const dash = writeDashboardForState(state);
      store.save(state);
      const deeper = wantsDeeperExplanation(state.answers) ? deeperExplanation(state) : undefined;
      return ok('Already initialized. Ask-once is satisfied; I will not ask again or mark the run complete by myself.',
        { runId, runStatus: state.status, model: state.config.model, dashboardPath: dash.path, dashboardAlwaysOn: true, stopCondition: STOP_CONDITION_WARNING, nativeContinuation: NATIVE_CONTINUATION_NOTICE, deeperExplanation: deeper, next: continuationDirective(state) });
    }

    // First-time configuration.
    const modelInfo = resolveModel(args.model);
    state.config.model = { primary: modelInfo.primary, declared: modelInfo.declared, autoSelected: !modelInfo.declared };
    if (args.config && Number.isFinite(args.config.failurePatience)) {
      state.config.failurePatience = clamp(Math.round(args.config.failurePatience), 10, 15);
    }
    if (args.config && args.config.comparisonRule) state.config.comparisonRule = args.config.comparisonRule;
    if (args.config && args.config.promotion) state.config.promotion = { ...state.config.promotion, ...args.config.promotion };
    state.task.mode = (args.config && args.config.mode) || inferMode(state.task.text);

    const answersProvided = Array.isArray(args.answers) && args.answers.length > 0;
    if (answersProvided) {
      state.answers = args.answers.map((a, i) => ({ index: i, sha256: sha256(String(a)), text: String(a), ts }));
    }

    const specific = isTaskSpecific(state.task.text, state.task.acceptanceCriteria) || answersProvided;

    if (!specific) {
      state.status = STATUS.AWAITING_ANSWERS;
      state.task.sufficiency = 'insufficient';
      state.questions = generateQuestions();
      logEvent(state, 'ask_once', { count: state.questions.length });
      state.updatedAt = ts;
      const dash = writeDashboardForState(state);
      store.save(state);
      return ok('First, a brief on what this does and what you decide; then a few short questions so we do not burn tokens on the wrong task. This is the only time I will ask. After this I keep moving, and you remain the stop condition.', {
        runId, runStatus: state.status,
        explanation: askOnceExplanation(),
        questions: state.questions,
        briefing: 'I will keep the run moving after this. The dashboard is always on and available for review. The model can queue or list review items, but only the operator can Approve or Sludge them from the dashboard. If a mining lane saturates or produces no winners, that is a checkpoint; the next step is to improve or harden the best available loop.',
        stopCondition: STOP_CONDITION_WARNING,
        nativeContinuation: NATIVE_CONTINUATION_NOTICE,
        dashboardPath: dash.path,
        dashboardAlwaysOn: true,
        continuation: continuationPayload(state),
        next: 'Call initialize_loop_run again with { runId, answers:[...] } to begin. Answer the last question to request a deeper explanation in that same response.'
      });
    }

    state.status = STATUS.INITIALIZED;
    state.task.sufficiency = 'sufficient';
    logEvent(state, 'initialized', { model: state.config.model.primary, mode: state.task.mode });
    state.updatedAt = ts;
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok('Initialized. Ask-once is complete; I will not ask again or mark the run complete by myself.', {
      runId, runStatus: state.status, model: state.config.model,
      briefing: 'I will keep the run moving after this. The dashboard is always on and available for review. The model can queue or list review items, but only the operator can Approve or Sludge them from the dashboard. If a mining lane saturates or produces no winners, that is a checkpoint; the next step is to improve or harden the best available loop.',
      stopCondition: STOP_CONDITION_WARNING,
      nativeContinuation: NATIVE_CONTINUATION_NOTICE,
      deeperExplanation: wantsDeeperExplanation(state.answers) ? deeperExplanation(state) : undefined,
      modelWarning: modelInfo.warning || undefined,
      sotaAdvisory: `Using ${state.config.model.primary} as the most capable available route. Check current SOTA via web search at the start (OpenAI / Anthropic / Google / Z.ai), and override config.model if a stronger frontier model exists. Run host_capability_preflight to see which frontier CLIs are installed locally. Non-frontier routes (haiku/mini/nano/lite/prior-gen) are rejected for full tests.`,
      builderRoutingAdvisory: `Builds and in-loop gating route to ${BUILDER_GATING_ROUTES.join(' or ')}. Codex/GPT stays a supported host surface but is not a trusted in-loop builder/gating worker. Frontier test workers may still include gpt-5.5.`,
      failurePatience: state.config.failurePatience, branchRetirementBatches: state.config.branchRetirementBatches, mode: state.task.mode,
      storedUserMessages: state.userMessages.length,
      dashboardPath: dash.path,
      dashboardAlwaysOn: true,
      continuation: continuationPayload(state),
      next: 'Call loop_start { runId, loop:"strip-miner" } (The Strip Miner Loop) or { loop:"loop-de-loop" } (Loop 2), or a custom loop registered with loop_register. Sections stream one at a time and require recorded evidence before the next section unlocks. Reports are checkpoints, not stopping points.'
    });
  }

  function loop_start(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}". Call initialize_loop_run first.`);
    const g = requireInitialized(state); if (g) return g;
    const target = requestedLoopTarget(state, args.loop);
    if (target.error) return target.error;
    if (!target.id) return unknownLoopBlock(state, args.loop);
    const id = target.id;
    // Pin an immutable, hash-locked snapshot of a custom loop into the run.
    if (!resolveLoopId(id) && !(state.customLoops && state.customLoops[id])) {
      const rec = store.readLoop(id);
      if (rec) { state.customLoops = state.customLoops || {}; state.customLoops[id] = rec; }
    }
    const loop = loadAnyLoop(state, id);
    if (!state.loops[id]) state.loops[id] = { phaseCursor: 0, totalPhases: loop.sections.length, evidence: {}, startedAt: clock(), origin: loop.meta.origin || 'mandated' };
    state.activeLoop = id;
    if (state.status === STATUS.INITIALIZED) state.status = STATUS.ACTIVE;
    const lane = ensureLaneForLoop(state, id); // supervisor opens/activates the lane for this loop
    const ls = state.loops[id];
    const section = loop.sections[ls.phaseCursor];
    clearContinuation(state, 'loop_start', { loop: id, phase: ls.phaseCursor });
    logEvent(state, 'loop_start', { loop: id, phase: ls.phaseCursor, lane: lane.id, laneKind: lane.kind });
    state.updatedAt = clock();
    store.save(state);
    return { ...sectionResult(loop, ls, section, 'started'), lane: { id: lane.id, kind: lane.kind }, continuation: continuationPayload(state) };
  }

  function advancePhase(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const target = requestedLoopTarget(state, args.loop, { fallbackActive: true });
    if (target.error) return target.error;
    const id = target.id;
    if (!id) return blocked(BLOCK.NO_ACTIVE_LOOP, 'No active loop. Call loop_start first.');
    const ls = state.loops[id];
    if (!ls) return blocked(BLOCK.NOT_STARTED, `Loop "${id}" not started. Call loop_start { loop:"${id}" }.`);
    const loop = loadAnyLoop(state, id);
    const current = ls.phaseCursor;
    const ev = ls.evidence[current] || [];
    if (ev.length === 0) {
      return blocked(BLOCK.PHASE_SKIP,
        `Phase ${current} ("${loop.sections[current].title}") has no recorded evidence. Record evidence (observation_record or artifact_record with { loop:"${id}", phase:${current} }) before requesting the next phase. No skipping.`,
        { loop: id, phase: current, title: loop.sections[current].title });
    }
    if (current + 1 >= loop.sections.length) {
      requireContinuation(state, 'stream_complete', `All sections of ${id} streamed; continue into benchmark/hypothesis work or the next lane.`);
      state.updatedAt = clock();
      store.save(state);
      return ok(`All ${loop.sections.length} sections of ${id} have streamed. Streaming complete is not campaign completion. Proceed to baseline, benchmark, and hypotheses; if this lane saturates, pivot to the next improvement lane.`,
        { loop: id, phase: current, totalPhases: loop.sections.length, streamComplete: true, continuation: continuationPayload(state), next: continuationDirective(state, 'Do not stop here.') });
    }
    ls.phaseCursor = current + 1;
    const section = loop.sections[ls.phaseCursor];
    clearContinuation(state, 'request_next_phase', { loop: id, phase: ls.phaseCursor });
    logEvent(state, 'advance_phase', { loop: id, phase: ls.phaseCursor });
    state.updatedAt = clock();
    store.save(state);
    return { ...sectionResult(loop, ls, section, 'advanced'), continuation: continuationPayload(state) };
  }

  function observation_record(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const summary = String(args.summary || '').trim();
    if (!summary) return blocked(BLOCK.BAD_INPUT, 'observation_record needs a non-empty summary (what you actually did/observed for this phase).');
    const target = phaseEvidenceTarget(state, args);
    if (target.error) return target.error;
    const oid = nextId(state, 'observation', 'obs');
    let unlocked = null;
    let lid = null, phase = null;
    if (target.wantsPhase) {
      lid = target.loop;
      phase = target.phase;
      (state.loops[lid].evidence[phase] = state.loops[lid].evidence[phase] || []).push(oid);
      unlocked = { loop: lid, phase };
    }
    state.observations.push({ id: oid, ts: clock(), loop: lid, phase, kind: args.kind || 'observation', summary, sourceRef: args.sourceRef || null });
    if (unlocked) clearContinuation(state, 'observation_record', unlocked);
    state.updatedAt = clock();
    store.save(state);
    return ok(`Observation ${oid} recorded.`, {
      observationId: oid, evidenceFor: unlocked,
      note: unlocked ? `Phase ${unlocked.phase} now has evidence; request_next_phase will advance.` : 'No loop/phase attached; this does not unlock a phase.',
      continuation: continuationPayload(state)
    });
  }

  function artifact_record(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const phaseTarget = phaseEvidenceTarget(state, args);
    if (phaseTarget.error) return phaseTarget.error;

    let content = args.content;
    if (content == null && args.sourcePath) {
      return blocked(BLOCK.BAD_INPUT,
        'sourcePath reads are disabled. Pass explicit content captured by host-approved tools; the MCP will not read arbitrary local files on a model-supplied path.');
    }
    content = String(content == null ? '' : content);
    const digest = sha256(content);
    const aid = nextId(state, 'artifact', 'art');
    const role = args.role || 'evidence';

    // Measurement authority (leak #3 hardening): the MCP DERIVES the measurement
    // from the recorded bytes — tokenCost always, quality via the frozen
    // benchmark's deterministic oracle when one exists. The caller's numbers are
    // retained only as `claimed`. The one way to record a weak caller-reported
    // measurement is to opt in explicitly with { callerReported:true }, which
    // exists solely so the benchmark/test/promotion gates can prove they refuse it.
    let measurement = null;
    const wantsMeasurement = (args.measurement && typeof args.measurement === 'object') || args.measure === true;
    if (wantsMeasurement) {
      const claimed = (args.measurement && typeof args.measurement === 'object') ? args.measurement : {};
      if (args.callerReported === true) {
        const tc = Number(claimed.tokenCost); const q = Number(claimed.quality);
        measurement = {
          tokenCost: tc, quality: Number.isFinite(q) ? q : null,
          tokenCostAuthority: CALLER_AUTHORITY, qualityAuthority: CALLER_AUTHORITY,
          claimed: { tokenCost: Number.isFinite(tc) ? tc : null, quality: Number.isFinite(q) ? q : null },
          oracleScored: false
        };
      } else {
        const oracle = (state.benchmark && state.benchmark.frozen && state.benchmark.def) ? state.benchmark.def.oracle : null;
        measurement = deriveMeasurement(content, oracle, claimed);
      }
    }
    const record = { id: aid, ts: clock(), role, name: args.name || aid, sha256: digest, chars: content.length, content, measurement };

    if (role === 'baseline') {
      if (state.baseline.recorded) {
        if (state.baseline.sha256 === digest) {
          // idempotent re-record of the same baseline
        } else if (args.newEpoch && args.rationale) {
          state.baseline = { recorded: true, artifactId: aid, sha256: digest, name: record.name, lockedAt: clock(), epoch: (state.baseline.epoch || 1) + 1, rationale: String(args.rationale) };
          store.writeArtifact(state.runId, aid, record);
        } else {
          return blocked(BLOCK.BASELINE_LOCKED,
            `Baseline already hash-locked to ${state.baseline.sha256}. A different baseline (${digest}) is refused to prevent tampering. To replace it, pass { newEpoch:true, rationale:"..." } (a new metric epoch between cycles).`,
            { existing: state.baseline.sha256, incoming: digest });
        }
      } else {
        state.baseline = { recorded: true, artifactId: aid, sha256: digest, name: record.name, lockedAt: clock(), epoch: 1 };
        store.writeArtifact(state.runId, aid, record);
      }
    } else {
      store.writeArtifact(state.runId, aid, record);
    }

    // Optional phase evidence.
    let unlocked = null;
    if (phaseTarget.wantsPhase) {
      const lid = phaseTarget.loop;
      const phase = phaseTarget.phase;
      (state.loops[lid].evidence[phase] = state.loops[lid].evidence[phase] || []).push(aid);
      unlocked = { loop: lid, phase };
    }
    logEvent(state, 'artifact_record', { id: aid, role });
    if (role === 'baseline' || measurement || unlocked) clearContinuation(state, 'artifact_record', { artifactId: aid, role, evidenceFor: unlocked });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Artifact ${aid} recorded (sha256 ${digest.slice(0, 12)}…).`, {
      artifactId: aid, sha256: digest, role,
      baseline: role === 'baseline' ? state.baseline : undefined,
      measurementRecorded: !!measurement,
      measurement: measurement ? {
        tokenCost: measurement.tokenCost, quality: measurement.quality,
        tokenCostAuthority: measurement.tokenCostAuthority, qualityAuthority: measurement.qualityAuthority,
        note: measurement.qualityAuthority === TOOL_AUTHORITY
          ? 'tokenCost + quality tool-computed from the recorded bytes; reverifiable.'
          : 'tokenCost tool-computed from bytes; quality is caller-reported (no deterministic oracle) → dashboard authority, cannot auto-promote.'
      } : undefined,
      evidenceFor: unlocked,
      continuation: continuationPayload(state)
    });
  }

  function benchmark_propose(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const benches = Array.isArray(args.benchmarks) ? args.benchmarks : (args.benchmark ? [args.benchmark] : []);
    if (!benches.length) return blocked(BLOCK.BAD_INPUT, 'Provide benchmarks:[{name, taskValueDimensions:[...], resourceDimensions:[...], cases:[...], oracle, qualityScale}].');
    const created = [];
    for (const b of benches) {
      const tv = b.taskValueDimensions || b.qualityDimensions || [];
      const rd = b.resourceDimensions || b.costDimensions || [];
      const cases = b.cases || [];
      if (!Array.isArray(tv) || tv.length < 1 || !Array.isArray(rd) || rd.length < 1 || !Array.isArray(cases) || cases.length < 1) {
        return blocked(BLOCK.WEAK_BENCHMARK,
          'A benchmark must declare ≥1 task-value dimension, ≥1 resource/cost dimension, and ≥1 concrete case drawn from real prior uses/failures. The benchmark is the bar — it cannot be hand-waved.',
          { got: { taskValueDimensions: tv.length, resourceDimensions: rd.length, cases: cases.length } });
      }
      const bid = nextId(state, 'benchmark', 'bench');
      state.benchmark.proposals.push({
        id: bid, name: b.name || bid, taskValueDimensions: tv, resourceDimensions: rd, cases,
        oracle: b.oracle || null, qualityScale: b.qualityScale || '0..1',
        comparisonRule: b.comparisonRule || state.config.comparisonRule,
        forbiddenShortcuts: b.forbiddenShortcuts || [], invariants: b.invariants || [], ts: clock()
      });
      created.push(bid);
    }
    clearContinuation(state, 'benchmark_propose', { benchmarkIds: created });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Recorded ${created.length} benchmark proposal(s).`, {
      benchmarkIds: created,
      continuation: continuationPayload(state),
      next: 'Hash-lock the baseline (artifact_record role=baseline), then benchmark_select to freeze one scorecard before any hypothesis.'
    });
  }

  function benchmark_select(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.baseline.recorded) return blocked(BLOCK.BASELINE_FIRST, 'Hash-lock the baseline first (artifact_record { role:"baseline", content:"..." }). The baseline is the thing challengers must beat.');
    const def = state.benchmark.proposals.find((p) => p.id === args.benchmarkId);
    if (!def) return blocked(BLOCK.BAD_INPUT, `Unknown benchmarkId "${args.benchmarkId}". Propose one first (benchmark_propose).`, { proposals: state.benchmark.proposals.map((p) => p.id) });
    if (state.benchmark.frozen) {
      if (state.benchmark.def.id === def.id) return ok('Benchmark already frozen (idempotent).', { frozen: summarizeBenchmark(state.benchmark.def) });
      if (args.newEpoch && args.rationale) {
        state.benchmark.def = def; state.benchmark.frozenAt = clock(); state.benchmark.epoch = (state.benchmark.epoch || 1) + 1; state.benchmark.baselineScore = null;
        clearContinuation(state, 'benchmark_select', { benchmarkId: def.id, newEpoch: true });
        store.save(state);
        return ok('New metric epoch: benchmark re-frozen. Re-run the baseline arm before challengers.', { frozen: summarizeBenchmark(def), epoch: state.benchmark.epoch, continuation: continuationPayload(state) });
      }
      return blocked(BLOCK.BENCHMARK_FROZEN, `Benchmark/scorecard already frozen to ${state.benchmark.def.id}. Changing it mid-cycle is refused (anti-gaming). Open a new epoch with { newEpoch:true, rationale:"..." } only between cycles.`, { frozenId: state.benchmark.def.id });
    }
    state.benchmark.frozen = true; state.benchmark.def = def; state.benchmark.frozenAt = clock(); state.benchmark.epoch = 1;
    clearContinuation(state, 'benchmark_select', { benchmarkId: def.id });
    logEvent(state, 'benchmark_frozen', { id: def.id });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Benchmark "${def.name}" is frozen. The scorecard is now immutable for this cycle.`, {
      frozen: summarizeBenchmark(def),
      continuation: continuationPayload(state),
      next: 'Run the baseline arm through it (benchmark_run { arm:"baseline", measurementRef }) to set the tool-measured bar, then register 3–5 frontier hypotheses.'
    });
  }

  function benchmark_run(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze a benchmark first (benchmark_select). The scorecard must be frozen before any measured run.');
    const arm = args.arm || 'baseline';
    const m = resolveMeasurement(state, args.measurementRef);
    if (!m.ok) return blocked(BLOCK.MODEL_REPORTED, `Benchmark run rejected: ${m.reason}. The bar must be tool-measured with a raw artifact (measurementRef); model self-report never sets or moves the bar.`);
    if (m.authority.tokenCost !== TOOL_AUTHORITY) {
      return blocked(BLOCK.MEASUREMENT_AUTHORITY, `Benchmark run rejected: tokenCost authority is "${m.authority.tokenCost}", not tool-computed. The MCP must derive the bar's cost from recorded bytes; a caller-reported number cannot set the bar challengers are measured against.`, { authority: m.authority });
    }
    if (arm === 'baseline') {
      state.benchmark.baselineScore = { tokenCost: m.metrics.tokenCost, quality: m.metrics.quality, source: 'tool', qualityAuthority: m.authority.quality, measurementRef: m.measurementRef, ts: clock() };
      clearContinuation(state, 'benchmark_run', { arm: 'baseline', measurementRef: m.measurementRef });
      logEvent(state, 'baseline_bar_set', { ...m.metrics });
      state.updatedAt = clock();
      store.save(state);
      return ok(`Baseline bar set: quality ${m.metrics.quality}, tokenCost ${m.metrics.tokenCost} (tool-measured).`, {
        baselineScore: state.benchmark.baselineScore, continuation: continuationPayload(state), next: 'Register 3–5 frontier hypotheses (register_hypotheses).'
      });
    }
    const h = state.hypotheses.find((x) => x.id === arm);
    if (!h) return blocked(BLOCK.UNKNOWN_HYPOTHESIS, `arm "${arm}" is neither "baseline" nor a known hypothesis id.`, { known: state.hypotheses.map((x) => x.id) });
    h.singleRuns = h.singleRuns || [];
    h.singleRuns.push({ ...m.metrics, source: 'tool', measurementRef: m.measurementRef, ts: clock() });
    clearContinuation(state, 'benchmark_run', { arm, measurementRef: m.measurementRef });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Recorded measured arm for ${arm}.`, { arm, metrics: m.metrics, continuation: continuationPayload(state) });
  }

  function register_hypotheses(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.baseline.recorded) return blocked(BLOCK.BASELINE_FIRST, 'Hash-lock the baseline before registering hypotheses (benchmark-first).');
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze the benchmark/scorecard before registering hypotheses (benchmark-first).');
    if (!state.benchmark.baselineScore) return blocked(BLOCK.BASELINE_BAR_FIRST, 'Run the baseline arm through the frozen benchmark (benchmark_run arm=baseline, tool-measured) to set the bar before challengers. The first benchmark is the whole point — it is not optional.');
    const hyps = Array.isArray(args.hypotheses) ? args.hypotheses : [];
    if (hyps.length < DEFAULTS.hypothesisMin || hyps.length > DEFAULTS.hypothesisMax) {
      return blocked(BLOCK.HYPOTHESIS_COUNT, `A full test needs ${DEFAULTS.hypothesisMin}–${DEFAULTS.hypothesisMax} parallel hypotheses tested with frontier models; you provided ${hyps.length}.`, { provided: hyps.length });
    }
    const routes = hyps.map((h) => (h.route && h.route.model) || h.model || '');
    const bad = rejectedRoutes(routes);
    if (bad.length) return blocked(BLOCK.BANNED_ROUTE, `Non-frontier route(s) rejected: ${bad.map((b) => b.model).join(', ')}. Full tests run on the most frontier models (e.g. ${KNOWN_FRONTIER_EXAMPLES.join(', ')}); haiku/mini/nano/lite and prior-gen are rejected.`, { rejected: bad });
    // Builder/gating routing: a hypothesis MAY name the worker that BUILDS its
    // challenger. If named, it must be a trusted builder/gating route (Opus 4.8 /
    // GLM 5.2). Codex/GPT is a fine frontier TEST worker but not an in-loop builder
    // here, so a build routed to it is refused. (Test-worker routes are unaffected.)
    const builderRoutes = hyps.map((h) => (h.builderRoute && h.builderRoute.model) || h.builderRoute || '').filter(Boolean);
    const badBuilders = rejectedBuilderRoutes(builderRoutes);
    if (badBuilders.length) return blocked(BLOCK.BUILDER_ROUTE, `Builder/gating route(s) rejected: ${badBuilders.map((b) => b.model).join(', ')}. Builds and in-loop gating route to ${BUILDER_GATING_ROUTES.join(' or ')}; Codex/GPT stays a host surface, not an in-loop builder.`, { rejected: badBuilders });
    const created = [];
    for (const h of hyps) {
      const hid = nextId(state, 'hypothesis', 'hyp');
      const builderRoute = (h.builderRoute && h.builderRoute.model) || h.builderRoute || null;
      state.hypotheses.push({
        id: hid, title: h.title || hid, bottleneck: h.bottleneck || '', operation: h.operation || '',
        expectedMovement: h.expectedMovement || '', route: { model: (h.route && h.route.model) || h.model },
        builderRoute: builderRoute || null,
        tradeoff: h.tradeoff || '', falsifier: h.falsifier || '', status: 'REGISTERED', ts: clock()
      });
      created.push(hid);
    }
    logEvent(state, 'hypotheses_registered', { count: created.length });
    clearContinuation(state, 'register_hypotheses', { hypothesisIds: created });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Registered ${created.length} frontier hypotheses.`, {
      hypothesisIds: created,
      continuation: continuationPayload(state),
      next: 'For each, run a full test (test_hypothesis) = 3–5 frontier agents actually running the loop, each metric tool-measured. One no-improvement run is never "perfect".'
    });
  }

  function test_hypothesis(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze the benchmark before full tests.');
    if (!state.benchmark.baselineScore) return blocked(BLOCK.BASELINE_BAR_FIRST, 'Set the tool-measured baseline bar (benchmark_run arm=baseline) before full tests.');
    const h = state.hypotheses.find((x) => x.id === args.hypothesisId);
    if (!h) return blocked(BLOCK.UNKNOWN_HYPOTHESIS, `Unknown hypothesisId "${args.hypothesisId}".`, { known: state.hypotheses.map((x) => x.id) });
    const ft = args.fullTest || {};
    const runs = Array.isArray(ft.agentRuns) ? ft.agentRuns : [];
    if (runs.length < DEFAULTS.fullTestAgentsMin || runs.length > DEFAULTS.fullTestAgentsMax) {
      return blocked(BLOCK.FULLTEST_AGENTS, `A full test must run the loop with ${DEFAULTS.fullTestAgentsMin}–${DEFAULTS.fullTestAgentsMax} frontier agents (not ${runs.length}). "Think hard and count it as a test" is not a test.`, { provided: runs.length });
    }
    const routeBad = runs.map((r) => classifyRoute(r && r.model)).filter((c) => !c.ok);
    if (routeBad.length) return blocked(BLOCK.BANNED_ROUTE, `Full test rejected: non-frontier agent route(s) ${routeBad.map((c) => c.model).join(', ')}.`, { rejected: routeBad.map((c) => ({ model: c.model, reason: c.reason })) });
    const validated = runs.map((r) => validateAgentRun(state, r));
    const unmeasured = validated.filter((v) => !v.ok);
    if (unmeasured.length) {
      const authorityFail = unmeasured.find((v) => v.code === BLOCK.MEASUREMENT_AUTHORITY);
      if (authorityFail) {
        return blocked(BLOCK.MEASUREMENT_AUTHORITY, `Full test rejected: ${authorityFail.reason} Caller-reported measurements are refused; the MCP owns the cost, derived from the recorded bytes.`, { rejected: unmeasured.map((v) => v.reason) });
      }
      return blocked(BLOCK.MODEL_REPORTED, `Full test rejected: ${unmeasured.length} agent run(s) are not tool-measured. ${unmeasured[0].reason}. Record each raw run via artifact_record (pass the run-log content; the MCP derives cost from the bytes) and pass measurementRef. Model self-reported metrics never count.`, { unmeasured: unmeasured.map((v) => v.reason) });
    }

    const quals = validated.map((v) => v.metrics.quality);
    const costs = validated.map((v) => v.metrics.tokenCost);
    const qualityAuthority = validated.every((v) => v.authority.quality === TOOL_AUTHORITY) ? TOOL_AUTHORITY : CALLER_AUTHORITY;
    const agg = { tokenCost: round(mean(costs)), quality: round(mean(quals)), n: validated.length, stdevQuality: round(stdev(quals)), minQuality: round(Math.min(...quals)), maxQuality: round(Math.max(...quals)) };
    const mv = evaluatePromotion(state.benchmark.baselineScore, { tokenCost: agg.tokenCost, quality: agg.quality, source: 'tool', reverified: true }, state.config.promotion, state.config.comparisonRule);
    const moved = mv.promote || mv.code === BLOCK.STAGED_TRADEOFF;
    const verdict = moved ? VERDICT.MOVED_FRONTIER : VERDICT.NO_IMPROVEMENT;
    const tid = nextId(state, 'test', 'test');
    state.tests.push({
      id: tid, hypothesisId: h.id, ts: clock(),
      agentRuns: validated.map((v) => ({ model: v.model, tokenCost: v.metrics.tokenCost, quality: v.metrics.quality, measurementRef: v.measurementRef, qualityAuthority: v.authority.quality, reverifiable: v.reverifiable })),
      agg, source: 'tool', qualityAuthority, reverified: false, verdict, movement: mv
    });
    if (moved && h.status !== 'PROMOTED_INTERNAL') h.status = VERDICT.MOVED_FRONTIER;
    else if (h.status === 'REGISTERED') h.status = 'TESTED';

    // Supervisor branch/lane accounting. This point is reached ONLY for a VALID
    // full real test batch (3-5 frontier measured runs that passed every gate);
    // invalid, fake-metric, banned-route, model-reported, and summary-only batches
    // were BLOCKED above and never reach here, so they cannot count toward the
    // advisory or toward branch retirement.
    const lane = ensureActiveLane(state);
    let advisory = null;
    let retirement = null;
    if (verdict === VERDICT.NO_IMPROVEMENT) {
      state.failures.consecutive++; state.failures.total++;
      lane.noImproveBatches = (lane.noImproveBatches || 0) + 1;
    } else {
      state.failures.consecutive = 0;
      lane.noImproveBatches = 0; // a qualifying improvement keeps this branch alive
    }
    if (state.failures.consecutive >= state.config.failurePatience && !state.failures.exhaustionFlagged) state.failures.exhaustionFlagged = true;
    if (state.failures.exhaustionFlagged) {
      advisory = `Risk advisory: ${state.failures.consecutive} consecutive valid full tests produced no frontier movement (advisory band ${state.config.failurePatience}). This REPORTS RISK ONLY and does not stop the run. Keep running another bottleneck or lane unless the operator explicitly stops the campaign.`;
    }
    // Branch retirement: only after N VALID no-improvement batches in this lane.
    // Retirement PIVOTS to the next lane via the supervisor; it never ends the run.
    if (lane.noImproveBatches >= state.config.branchRetirementBatches && lane.status === LANE_STATUS.ACTIVE) {
      if (h.status !== 'PROMOTED_INTERNAL') h.status = 'RETIRED';
      const t = autoTransition(state, 'branch_retirement', { lane: lane.id, batches: lane.noImproveBatches, hypothesisId: h.id });
      retirement = { laneId: lane.id, batches: lane.noImproveBatches, pivotedToKind: t.plan.kind, pivotedToLoop: t.plan.loop, transitionId: t.transitionId };
    } else if (verdict === VERDICT.NO_IMPROVEMENT) {
      requireContinuation(state, 'no_improvement', `Full test ${tid} did not move the frontier; continue into another hypothesis, operation, or lane.`);
    } else {
      clearContinuation(state, 'test_hypothesis', { testId: tid, verdict });
    }
    logEvent(state, 'full_test', { id: tid, hypothesisId: h.id, verdict, lane: lane.id, noImproveBatches: lane.noImproveBatches });
    state.updatedAt = clock();
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok(`Full test ${tid} for ${h.id}: quality ${agg.quality} vs baseline ${state.benchmark.baselineScore.quality}, tokenCost ${agg.tokenCost} vs ${state.benchmark.baselineScore.tokenCost}. Verdict ${verdict}. ${mv.message}${retirement ? ` Branch retired after ${retirement.batches} valid no-improvement batches — supervisor auto-pivoted to the next lane (NOT a stop).` : ''}`, {
      testId: tid, verdict, aggregate: agg, movement: mv, qualityAuthority,
      qualityNote: qualityAuthority === TOOL_AUTHORITY
        ? 'quality is tool-computed against the frozen oracle — eligible for autonomous promotion.'
        : 'quality is caller-reported (no deterministic oracle) — a quality win here must go through the dashboard and cannot auto-promote.',
      failureCounter: { consecutive: state.failures.consecutive, total: state.failures.total, patience: state.config.failurePatience, exhaustionFlagged: state.failures.exhaustionFlagged },
      branchRetirement: { laneId: lane.id, noImproveBatches: lane.noImproveBatches, threshold: state.config.branchRetirementBatches, retired: !!retirement },
      retirement: retirement || undefined,
      advisory: advisory || undefined,
      dashboardPath: dash.path,
      continuation: continuationPayload(state),
      next: retirement
        ? `Branch retired and the supervisor auto-pivoted. ${retirement.pivotedToLoop ? `loop_start { loop:"${retirement.pivotedToLoop}" }` : 'open the next improvement branch (register_hypotheses for the next bottleneck)'}. The campaign keeps running.`
        : verdict === VERDICT.MOVED_FRONTIER
        ? `Deep-reverify the winning evidence (reverify_run { testId:"${tid}" }), then promotion_request.`
        : 'No movement. This is not a final answer and not a stopping point; iterate another hypothesis, try another operation, or pivot lanes.'
    });
  }

  // OPTIONAL live execution (off by default). When the operator opts in
  // (SUPER_LOOP_ALLOW_EXEC=1) the SUPERVISOR launches the 3-5 frontier workers
  // itself and captures their output, so the evidence is tool-owned end-to-end —
  // there is no model-supplied run-log to fabricate. The captured bytes then flow
  // through the SAME measure/gate/aggregate/verdict/retirement path as a recorded
  // full test. A failed/timed-out/non-allowlisted launch is an INVALID batch and
  // never reaches the counters.
  function execute_full_test(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!isExecEnabled()) {
      return blocked(BLOCK.EXEC_DISABLED,
        'Live worker execution is OFF by default (the audited no-exec posture). Set SUPER_LOOP_ALLOW_EXEC=1 to let Sling launch and meter the workers itself. Otherwise run the 3-5 frontier workers in the host and record each run-log via artifact_record + test_hypothesis.',
        { allowEnv: 'SUPER_LOOP_ALLOW_EXEC=1' });
    }
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze the benchmark before an executed full test.');
    if (!state.benchmark.baselineScore) return blocked(BLOCK.BASELINE_BAR_FIRST, 'Set the tool-measured baseline bar before an executed full test.');
    const h = state.hypotheses.find((x) => x.id === args.hypothesisId);
    if (!h) return blocked(BLOCK.UNKNOWN_HYPOTHESIS, `Unknown hypothesisId "${args.hypothesisId}".`, { known: state.hypotheses.map((x) => x.id) });
    const routes = Array.isArray(args.routes) ? args.routes.map((r) => (r && r.model) || r).filter(Boolean) : [];
    if (routes.length < DEFAULTS.fullTestAgentsMin || routes.length > DEFAULTS.fullTestAgentsMax) {
      return blocked(BLOCK.FULLTEST_AGENTS, `execute_full_test launches ${DEFAULTS.fullTestAgentsMin}-${DEFAULTS.fullTestAgentsMax} frontier workers; you gave ${routes.length} route(s).`, { provided: routes.length });
    }
    const routeBad = routes.map((r) => classifyRoute(r)).filter((c) => !c.ok);
    if (routeBad.length) return blocked(BLOCK.BANNED_ROUTE, `Non-frontier route(s) refused: ${routeBad.map((c) => c.model).join(', ')}.`, { rejected: routeBad.map((c) => ({ model: c.model, reason: c.reason })) });
    const notAllow = routes.filter((r) => !execBinaryForRoute(r));
    if (notAllow.length) return blocked(BLOCK.EXEC_FAILED, `Routes with no allowlisted executor binary (claude/codex/glm/gemini only): ${notAllow.join(', ')}.`, { notAllowlisted: notAllow });
    const prompt = String(args.prompt == null ? '' : args.prompt).trim();
    if (!prompt) return blocked(BLOCK.BAD_INPUT, 'execute_full_test needs { prompt } — the loop + task the launched worker should actually run.');

    // Launch each worker (sequential; one tool call at a time over stdio).
    const launches = routes.map((model) => runWorker({ model, prompt, timeoutMs: Number(args.timeoutMs) || undefined }));
    const failed = launches.filter((l) => !l.ok);
    if (failed.length) {
      logEvent(state, 'execute_full_test_invalid', { failed: failed.map((f) => f.model) });
      state.updatedAt = clock();
      store.save(state);
      return blocked(BLOCK.EXEC_FAILED,
        `Launched ${routes.length} worker(s); ${failed.length} failed before producing evidence (${failed.map((f) => `${f.model}:${f.reason}`).join(', ')}). An invalid/failed batch does NOT count toward the ${state.config.branchRetirementBatches}-batch retirement.`,
        { failures: failed.map((f) => ({ model: f.model, reason: f.reason, message: f.message })), countedTowardRetirement: false });
    }

    // Each captured stdout becomes a TOOL-EXECUTED artifact; the MCP derives the
    // metric from the bytes IT captured (not a number or log the model handed in).
    const agentRuns = [];
    const workers = [];
    for (const l of launches) {
      const art = artifact_record({ runId: state.runId, role: 'runlog', name: `exec-${l.model}`, content: l.stdout, measure: true });
      agentRuns.push({ model: l.model, measurementRef: art.artifactId });
      workers.push({ model: l.model, bin: l.bin, exitCode: l.exitCode, durationMs: l.durationMs, bytes: String(l.stdout).length, realTokenUsage: l.tokenUsage, measurementRef: art.artifactId });
    }
    // Same gate/aggregate/verdict/retirement path as a recorded full test.
    const result = test_hypothesis({ runId: state.runId, hypothesisId: h.id, fullTest: { agentRuns, notes: 'tool-executed via execute_full_test' } });

    const s2 = store.load(state.runId);
    s2.executions = s2.executions || [];
    s2.executions.push({ ts: clock(), hypothesisId: h.id, testId: result.testId || null, workers });
    logEvent(s2, 'execute_full_test', { hypothesisId: h.id, workers: workers.length, testId: result.testId || null, verdict: result.verdict || null });
    s2.updatedAt = clock();
    store.save(s2);
    return {
      ...result,
      executed: true,
      executor: {
        workers,
        note: 'Output was captured by the supervisor (tool-executed) — there is no model-supplied run-log to fabricate. The gate uses the reproducible byte-derived metric; realTokenUsage is the worker-reported count when the CLI emits one (else null → byte estimate).'
      }
    };
  }

  function reverify_run(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    let test = args.testId ? state.tests.find((t) => t.id === args.testId) : null;
    if (!test && args.hypothesisId) {
      test = state.tests.filter((t) => t.hypothesisId === args.hypothesisId && t.verdict === VERDICT.MOVED_FRONTIER).sort((a, b) => b.agg.quality - a.agg.quality)[0];
    }
    if (!test) return blocked(BLOCK.BAD_INPUT, 'Provide testId (or hypothesisId with a moved-frontier test) to reverify.');
    // Re-derive the metrics from the sealed bytes — NOT from the stored measurement
    // field. This is the teeth: a tamper that rewrites the recorded number cannot
    // survive, because the MCP recomputes tokenCost (and oracle quality) from the
    // artifact content and compares to what the test recorded.
    const oracle = (state.benchmark && state.benchmark.def) ? state.benchmark.def.oracle : null;
    const problems = [];
    const recomputed = [];
    for (const run of test.agentRuns) {
      if (!run.measurementRef) { problems.push(`run ${run.model}: no measurementRef`); continue; }
      const art = store.readArtifact(state.runId, run.measurementRef);
      if (!art) { problems.push(`run ${run.model}: artifact ${run.measurementRef} missing`); continue; }
      const reHash = sha256(art.content);
      if (reHash !== art.sha256) { problems.push(`run ${run.model}: artifact bytes tampered (content hash ${reHash}!=${art.sha256})`); continue; }
      const reCost = estimateTokens(art.content);
      const reQual = isDeterministicOracle(oracle)
        ? scoreOracle(art.content, oracle)
        : (art.measurement ? Number(art.measurement.quality) : NaN);
      if (reCost !== run.tokenCost) { problems.push(`run ${run.model}: re-derived tokenCost ${reCost} != recorded ${run.tokenCost} (bytes do not back the cost)`); continue; }
      if (!(Math.abs(reQual - run.quality) < 1e-9)) { problems.push(`run ${run.model}: re-derived quality ${reQual} != recorded ${run.quality} (bytes do not back the quality)`); continue; }
      recomputed.push({ tokenCost: reCost, quality: reQual });
    }
    let aggOk = false;
    if (recomputed.length === test.agentRuns.length && recomputed.length > 0) {
      const q = round(mean(recomputed.map((r) => r.quality)));
      const c = round(mean(recomputed.map((r) => r.tokenCost)));
      aggOk = Math.abs(q - test.agg.quality) < 1e-9 && Math.abs(c - test.agg.tokenCost) < 1e-9;
      if (!aggOk) problems.push(`recomputed aggregate (q${q},c${c}) != stored (q${test.agg.quality},c${test.agg.tokenCost})`);
    }
    const reverified = problems.length === 0 && aggOk;
    test.reverified = reverified; test.reverifiedAt = clock(); test.reverifyProblems = problems;
    if (reverified) clearContinuation(state, 'reverify_run', { testId: test.id });
    logEvent(state, 'reverify', { testId: test.id, reverified });
    state.updatedAt = clock();
    store.save(state);
    if (!reverified) return blocked(BLOCK.NOT_REVERIFIED, `Reverify FAILED for ${test.id}: ${problems.join('; ')}. Promotion stays blocked until the winning evidence reproduces from sealed raw artifacts.`, { testId: test.id, problems });
    return ok(`Reverify PASSED for ${test.id}: all ${test.agentRuns.length} raw artifacts re-hashed clean and metrics reproduce. Winning evidence is independently confirmed.`, { testId: test.id, reverified: true, continuation: continuationPayload(state) });
  }

  function promotion_request(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.baseline.recorded) return blocked(BLOCK.BASELINE_FIRST, 'Hash-lock the baseline before promotion.');
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze the benchmark before promotion.');
    if (!state.benchmark.baselineScore) return blocked(BLOCK.BASELINE_BAR_FIRST, 'Set the tool-measured baseline bar before promotion.');
    const h = state.hypotheses.find((x) => x.id === args.hypothesisId);
    if (!h) return blocked(BLOCK.UNKNOWN_HYPOTHESIS, `Unknown hypothesisId "${args.hypothesisId}".`, { known: state.hypotheses.map((x) => x.id) });
    const tests = state.tests.filter((t) => t.hypothesisId === h.id && t.source === 'tool');
    if (!tests.length) {
      return blocked(BLOCK.NO_SCORE_MATRIX, `No tool-measured full test on the frozen benchmark for ${h.id}. "Old green tests" (e.g. 21/21 unit tests) without a frozen-benchmark score matrix cannot promote. Run test_hypothesis first.`);
    }
    const best = tests.slice().sort((a, b) => b.agg.quality - a.agg.quality)[0];
    if (!best.reverified) return blocked(BLOCK.NOT_REVERIFIED, `Best test ${best.id} for ${h.id} is not deep-reverified. Run reverify_run { testId:"${best.id}" } before promotion.`, { testId: best.id });
    if (best.qualityAuthority !== TOOL_AUTHORITY) {
      // Honest boundary: the MCP cannot tool-verify subjective quality. Such a win
      // is real work but is HUMAN-gated through the dashboard (Approve/Sludge); the
      // model never auto-promotes it. This is a checkpoint, not a stop.
      requireContinuation(state, 'quality_unverified', `Promotion of ${h.id} needs human Approve on the dashboard (quality is not tool-verifiable); queue it and continue the next lane.`);
      state.updatedAt = clock();
      const dash = writeDashboardForState(state);
      store.save(state);
      return blocked(BLOCK.QUALITY_UNVERIFIED,
        `Promotion refused for ${h.id}: the winning test's quality authority is "${best.qualityAuthority}", not tool-computed. The MCP cannot prove subjective quality moved. For autonomous promotion, freeze a benchmark with a deterministic oracle so quality is tool-computed; otherwise, send this candidate to the dashboard for operator Approve/Sludge. The run remains active; continue the next lane.`,
        { hypothesisId: h.id, qualityAuthority: best.qualityAuthority, dashboardPath: dash.path, reviewAuthority: 'dashboard-only', continuation: continuationPayload(state) });
    }
    const challenger = { tokenCost: best.agg.tokenCost, quality: best.agg.quality, source: 'tool', reverified: true };
    const decision = evaluatePromotion(state.benchmark.baselineScore, challenger, state.config.promotion, state.config.comparisonRule);
    if (!decision.promote) {
      return blocked(decision.code, `Promotion refused for ${h.id}: ${decision.message}.`, { hypothesisId: h.id, baseline: state.benchmark.baselineScore, challenger, deltas: decision.deltas });
    }
    const pid = nextId(state, 'promotion', 'promo');
    state.promotions.push({
      id: pid, hypothesisId: h.id, kind: decision.kind, baseline: state.benchmark.baselineScore, challenger,
      deltas: decision.deltas, ts: clock(), authority: 'measured-frontier-movement', canonicalChange: false,
      note: "Disposition recorded as internal champion. Changing the operator's canonical loop file requires explicit operator authority (HUMAN-GATED); this tool never overwrites it."
    });
    h.status = 'PROMOTED_INTERNAL';
    logEvent(state, 'promotion', { id: pid, hypothesisId: h.id, kind: decision.kind });
    requireContinuation(state, 'promotion', `Promotion ${pid} recorded as an internal champion; continue into the next bottleneck/lane while dashboard review stays available.`);
    state.updatedAt = clock();
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok(`PROMOTE ${h.id} (${decision.kind}): ${decision.message}. Recorded as internal champion. Changing the canonical loop still requires operator authority through the dashboard. The campaign remains active.`, { promotionId: pid, decision, dashboardPath: dash.path, continuation: continuationPayload(state), next: continuationDirective(state) });
  }

  function cycle_decision_request(args = {}) {
    const pre = loadRun(args);
    if (!pre) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(pre); if (g) return g;
    const intent = String(args.intent || '').toLowerCase();
    let result;
    switch (intent) {
      case 'promote':
        result = promotion_request({ runId: args.runId, hypothesisId: args.hypothesisId }); break;
      case 'advance_phase':
        result = advancePhase({ runId: args.runId, loop: args.loop }); break;
      case 'change_baseline':
        result = (args.newEpoch && args.rationale) ? ok('Baseline epoch change acknowledged — re-record via artifact_record { role:"baseline", newEpoch:true, rationale }.') : blocked(BLOCK.BASELINE_LOCKED, 'Refused: baseline is hash-locked. A change needs { newEpoch:true, rationale } between cycles (anti-tampering).'); break;
      case 'change_benchmark':
        result = (args.newEpoch && args.rationale) ? ok('Benchmark epoch change acknowledged — re-select via benchmark_select { newEpoch:true, rationale }.') : blocked(BLOCK.BENCHMARK_FROZEN, 'Refused: benchmark is frozen mid-cycle. Open a new epoch with { newEpoch:true, rationale } between cycles only.'); break;
      case 'saturate':
      case 'transition':
        result = report_saturation({ runId: args.runId, evidence: args.rationale }); break;
      default:
        result = blocked(BLOCK.OPERATOR_IS_STOP, `Refused unsupported terminal or checkpoint intent "${args.intent}". Allowed progress/transition intents are: promote, advance_phase, change_baseline, change_benchmark, saturate. Continue with the next runnable bottleneck or lane.`);
    }
    // Re-load (delegated handlers saved their own copy) and append the audited decision.
    const state = store.load(args.runId);
    const did = nextId(state, 'decision', 'dec');
    state.decisions.push({ id: did, ts: clock(), intent, args: { hypothesisId: args.hypothesisId || null, loop: args.loop || null }, outcome: result.status, code: result.code || null });
    if (result.code === BLOCK.OPERATOR_IS_STOP) {
      requireContinuation(state, 'blocked_terminal_intent', `Rejected "${args.intent}" through the decision hook; continue into the next runnable lane.`);
    }
    state.updatedAt = clock();
    store.save(state);
    return { ...result, decisionId: did, hookNote: 'Routed through the Sling evidence gate. Reasoning alone is not evidence; only tool-measured artifacts unlock promotion. Checkpoints must continue into the next lane.', continuation: continuationPayload(state) };
  }

  // Supervisor saturation transition. The Strip Miner may saturate; on saturation
  // the supervisor AUTO-TRANSITIONS to Loop-de-loop (or the next improvement lane).
  // It never pauses, awaits the operator, or marks "no re-mining warranted" as a
  // terminal — saturation is a pivot. The operator is the only stop condition.
  function report_saturation(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const lane = ensureActiveLane(state);
    const evidence = args.evidence ? String(args.evidence) : null;
    const t = autoTransition(state, 'saturation', { lane: lane.id, evidence });
    state.updatedAt = clock();
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok(`Saturation recorded for lane ${lane.id} (${lane.kind}). Supervisor auto-transitioned to the next ${t.plan.kind} lane${t.plan.loop ? ` (${t.plan.loop})` : ''}. This is a pivot, not a stop — the campaign keeps running.`, {
      saturatedLane: { id: lane.id, kind: lane.kind },
      transition: { id: t.transitionId, toKind: t.plan.kind, toLoop: t.plan.loop, firstAction: t.plan.firstAction },
      autoTransitioned: true,
      dashboardPath: dash.path,
      continuation: continuationPayload(state),
      next: t.plan.loop ? `loop_start { runId:"${state.runId}", loop:"${t.plan.loop}" }` : t.plan.firstAction
    });
  }

  // Read-only supervisor status: the target queue (lanes), transitions, branch
  // accounting, and whether anything is pending in the human-review dashboard
  // (which never blocks the campaign).
  function campaign_status(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const c = ensureCampaign(state);
    const cur = activeLane(state);
    const pendingReviews = (state.humanReviews || []).filter((r) => r.status === 'PENDING').length;
    return ok(`Campaign ${state.runId}: ${c.lanes.length} lane(s), ${c.transitions.length} auto-transition(s). ${pendingReviews} review item(s) pending (dashboard-only; never blocks the run). The operator is the only stop condition.`, {
      runStatus: state.status,
      activeLane: cur ? { id: cur.id, kind: cur.kind, loop: cur.loop, status: cur.status, noImproveBatches: cur.noImproveBatches } : null,
      lanes: c.lanes.map((l) => ({ id: l.id, kind: l.kind, loop: l.loop, status: l.status, noImproveBatches: l.noImproveBatches })),
      transitions: c.transitions,
      branchRetirementThreshold: state.config.branchRetirementBatches,
      advisoryBand: state.config.failurePatience,
      failureCounter: state.failures,
      pendingDashboardReview: pendingReviews,
      pendingReviewBlocksCampaign: false,
      builderGatingRoutes: BUILDER_GATING_ROUTES,
      stopCondition: STOP_CONDITION_WARNING,
      continuation: continuationPayload(state)
    });
  }

  function continue_run(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const lane = String(args.lane || args.nextLane || '').trim();
    const firstAction = String(args.firstAction || args.first_action || '').trim();
    if (!lane || !firstAction) {
      return blocked(BLOCK.BAD_INPUT,
        'continue_run requires { lane, firstAction }. Use it only when the model is actually moving into the next runnable improvement lane.',
        { continuation: continuationPayload(state) });
    }
    const ts = clock();
    state.continuationCommitments = state.continuationCommitments || [];
    state.continuationCommitments.push({ ts, lane, firstAction, rationale: args.rationale ? String(args.rationale) : null });
    const c = ensureContinuation(state);
    c.inProgress = true;
    c.lastCommitment = { ts, lane, firstAction, rationale: args.rationale ? String(args.rationale) : null };
    c.history.push({ id: c.id || null, ts, event: 'commitment_recorded', source: 'continue_run', lane, firstAction });
    logEvent(state, 'continuation_commitment_recorded', { lane, firstAction });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Continuation commitment recorded: ${lane}. This does not clear the obligation; a real progress tool must run next.`, {
      lane, firstAction,
      continuation: continuationPayload(state),
      next: firstAction,
      clearsWhen: 'A real progress tool runs, such as artifact_record, benchmark_propose, register_hypotheses, test_hypothesis, loop_start, request_next_phase, or reverify_run.'
    });
  }

  function human_review_request(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const action = args.action || (args.item ? 'add' : 'list');
    if (action === 'add') {
      const rid = nextId(state, 'review', 'rev');
      const item = args.item || {};
      state.humanReviews.push({ id: rid, ts: clock(), status: 'PENDING', title: item.title || rid, kind: item.kind || 'change', summary: item.summary || '', hypothesisId: item.hypothesisId || null, evidenceRef: item.evidenceRef || null, notes: null });
      requireContinuation(state, 'human_review_queued', `Review item ${rid} was queued; dashboard review cannot block deterministic progress.`);
      state.updatedAt = clock();
      const dash = writeDashboardForState(state);
      store.save(state);
      return ok(`Review item ${rid} queued for operator review in the dashboard (Approve / Sludge). The model cannot resolve it, and deterministic lanes continue without waiting on review.`, { reviewId: rid, pending: state.humanReviews.filter((r) => r.status === 'PENDING').length, dashboardPath: dash.path, reviewAuthority: 'dashboard-only', continuation: continuationPayload(state) });
    }
    if (action === 'resolve') {
      requireContinuation(state, 'human_review_spoof_blocked', 'Model-callable review resolution was blocked; continue deterministic work while the operator reviews the dashboard.');
      state.updatedAt = clock();
      store.save(state);
      return blocked(BLOCK.DASHBOARD_ONLY,
        'Human review resolution is dashboard-only. The model-callable MCP tool may queue or list review items, but it cannot approve or sludge its own work. Continue the next lane while the operator reviews the dashboard.',
        { reviewId: args.reviewId || null, reviewAuthority: 'dashboard-only', pending: state.humanReviews.filter((r) => r.status === 'PENDING').length, continuation: continuationPayload(state) });
    }
    return ok(`${state.humanReviews.length} review item(s).`, { reviews: state.humanReviews, reviewAuthority: 'dashboard-only', note: 'The model can only list review state. Approve/Sludge is not a model-callable action.', continuation: continuationPayload(state) });
  }

  function update_dashboard(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    requireContinuation(state, 'dashboard_update', 'Dashboard was rendered; dashboard review is not a stopping condition.');
    state.updatedAt = clock();
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok(`Dashboard written to ${dash.path}. It remains available throughout the run. Approve/Sludge is operator-only from the dashboard; model-callable tools cannot resolve human review. The stop-condition notice appears at the top.`, {
      path: dash.path, warningIncluded: dash.warningIncluded, reviewItems: state.humanReviews.length, reviewAuthority: 'dashboard-only', continuation: continuationPayload(state)
    });
  }

  function report_export(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    requireContinuation(state, 'report_export', 'Report was exported; a report is a checkpoint, not completion.');
    const md = renderReport(state);
    const path = store.writeRunFile(state.runId, 'report.md', md);
    state.reportPath = path;
    state.updatedAt = clock();
    store.save(state);
    return ok(`Report written to ${path}.`, { path, continuation: continuationPayload(state) });
  }

  // ---- local loop library (leak #1: users add their own loops) -----------
  function loopJournal(args, event, detail) {
    if (args.runId && isSafeId(args.runId) && store.exists(args.runId)) {
      const s = store.load(args.runId);
      logEvent(s, event, detail);
      s.updatedAt = clock();
      store.save(s);
    }
  }

  function loop_register(args = {}) {
    // Library-level operation: it adds a loop to THIS machine's local MCP so the
    // model can stream it phase-gated. runId is optional (only used to journal).
    if (args.runId && !isSafeId(args.runId)) return invalidIdBlock('runId', args.runId);
    const id = String(args.id || args.loopId || '').toLowerCase().trim();
    if (!isSafeId(id)) return invalidIdBlock('loop id', id);
    if (isMandatedId(id)) {
      return blocked(BLOCK.LOOP_EXISTS, `"${id}" collides with a hash-locked mandated loop (The Strip Miner Loop / Loop-de-loop). Those are never overwritten — choose another id for your custom loop.`);
    }
    if (args.content == null && args.sourcePath) {
      return blocked(BLOCK.BAD_INPUT, 'sourcePath reads are disabled. Paste the loop text as `content`; the MCP will not read an arbitrary local file path.');
    }
    const content = String(args.content == null ? '' : args.content);
    if (content.trim().length < 40) {
      return blocked(BLOCK.LOOP_SOURCE, 'Custom loop source is too small to phase-gate. Provide the real multi-section loop text (headers or paragraph breaks become streamable phases).');
    }
    const digest = sha256(content);
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    if (store.loopExists(id) && !args.overwrite) {
      const prev = store.readLoop(id);
      if (!(prev && prev.sha256 === digest)) {
        return blocked(BLOCK.LOOP_EXISTS, `Custom loop "${id}" is already registered with a different hash. Pass { overwrite:true } to replace it (a new local version).`, { existing: prev ? prev.sha256 : null, incoming: digest });
      }
    }
    const record = {
      id, title: args.title ? String(args.title) : id,
      trigger: args.trigger ? String(args.trigger) : `/loop ${id}`,
      role: args.role ? String(args.role) : 'custom', aka: [], origin: 'custom',
      content, sha256: digest, lines, registeredAt: clock()
    };
    let built;
    try { built = makeCustomLoop(record); } catch (e) { return blocked(BLOCK.LOOP_SOURCE, `Custom loop rejected: ${e.message}`); }
    if (built.sections.length < 2) {
      return blocked(BLOCK.LOOP_SOURCE, `Custom loop "${id}" produced only ${built.sections.length} streamable section(s); phase-gated streaming needs ≥2. Add section headers or blank-line-separated paragraphs.`, { sections: built.sections.length });
    }
    record.sections = built.sections.length;
    store.writeLoop(record);
    loopJournal(args, 'loop_register', { id, sections: built.sections.length, sha256: digest });
    return ok(`Custom loop "${id}" registered locally (sha256 ${digest.slice(0, 12)}…, ${built.sections.length} phase-gated sections). Stream it with loop_start { loop:"${id}" }.`, {
      loop: { id, title: record.title, trigger: record.trigger, sha256: digest, lines, sections: built.sections.length, origin: 'custom' },
      note: 'Hash-locked locally exactly like the mandated loops, and streamed one section at a time through the same phase gate. The bundled 345-line Strip Miner and 75-line Loop-de-loop are untouched. Nothing leaves your machine.'
    });
  }

  function loop_library(args = {}) {
    if (args.runId && !isSafeId(args.runId)) return invalidIdBlock('runId', args.runId);
    const mandated = verifyAllLoops().map((m) => ({
      id: m.id, title: m.title, trigger: m.trigger, role: m.role,
      sha256: m.sha256, lines: m.lines, sections: m.sections, origin: 'mandated', hashLocked: true
    }));
    const custom = store.listLoops().map((cid) => {
      const r = store.readLoop(cid);
      try {
        const b = makeCustomLoop(r);
        return { id: cid, title: r.title, trigger: r.trigger, role: r.role || 'custom', sha256: b.sha256, lines: b.lines, sections: b.sections.length, origin: 'custom', hashLocked: true };
      } catch (e) {
        return { id: cid, title: (r && r.title) || cid, origin: 'custom', hashLocked: false, error: e.message };
      }
    });
    loopJournal(args, 'loop_library', { mandated: mandated.length, custom: custom.length });
    return ok(`Loop library: ${mandated.length} mandated (hash-locked) + ${custom.length} custom local loop(s).`, {
      mandated, custom,
      registerWith: 'loop_register { id, title, content, trigger? } — add your own loops; they stream phase-gated like the mandated ones.',
      streamWith: 'loop_start { runId, loop:"<id>" }'
    });
  }

  // ---- host capability preflight (leak #7) -------------------------------
  function host_capability_preflight(args = {}) {
    if (args.runId && !isSafeId(args.runId)) return invalidIdBlock('runId', args.runId);
    const report = detectHostCapabilities();
    loopJournal(args, 'host_preflight', { installed: report.installed });
    return ok(`Host preflight: ${report.installedCount}/${report.routes.length} known frontier-agent CLIs found on PATH${report.installed.length ? ` (${report.installed.join(', ')})` : ' (none)'}.`, {
      ...report,
      advisory: `This is a LOCAL capability check, not SOTA/web research and not an auth check. Use it to pick routes that are actually installed, then web-search current SOTA (OpenAI / Anthropic / Google / Z.ai) and confirm auth before relying on any route. Non-frontier routes are still rejected by register_hypotheses/test_hypothesis.`
    });
  }

  // ---- registry ----------------------------------------------------------
  const api = {
    initialize_loop_run,
    loop_register,
    loop_library,
    host_capability_preflight,
    loop_start,
    loop_next: advancePhase,
    request_next_phase: advancePhase,
    observation_record,
    artifact_record,
    benchmark_propose,
    benchmark_select,
    benchmark_run,
    register_hypotheses,
    test_hypothesis,
    execute_full_test,
    reverify_run,
    promotion_request,
    cycle_decision_request,
    report_saturation,
    campaign_status,
    continue_run,
    human_review_request,
    update_dashboard,
    report_export,
    // exposed for tooling/tests
    _loopSummary: loopSummary
  };
  // The autonomous supervisor: one call drives the whole campaign (intake → mine →
  // improve targets → bank Stones → advance/retire → re-mine) with the executor as
  // the real worker, validating every worker output through the enforcement boundary.
  // Bounded by maxBatches inside the MCP call (a safety cap, not completion); the
  // standalone CLI runs it until the operator stop-file. Requires the exec opt-in.
  api.run_campaign = (args = {}) => {
    if (!isExecEnabled()) {
      return blocked(BLOCK.EXEC_DISABLED, 'The autonomous supervisor must run real workers; set SUPER_LOOP_ALLOW_EXEC=1. (Without it, drive the MCP tools from a host agent, or use mock workers via the supervisor API in tests.)', { allowEnv: 'SUPER_LOOP_ALLOW_EXEC=1' });
    }
    let stopFile = args.stopFile || null;
    return runSupervisedCampaign(api, { ...(args.config || {}), runId: args.runId }, {
      worker: executorWorker,
      maxBatches: Number.isFinite(args.maxBatches) ? args.maxBatches : (Number.isFinite(args.maxRounds) ? args.maxRounds : 3),
      stopCheck: stopFile ? () => { try { return existsSync(stopFile); } catch { return false; } } : () => false
    });
  };
  return api;
}
