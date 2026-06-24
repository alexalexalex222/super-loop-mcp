// Req 4: ask-once. A brief explanation first, then a few short questions when the
// task is underspecified; never asks again after init; user messages stored
// locally with sha256 hashes. The questions cover only what the operator alone
// can answer — never model, promotion mode, benchmark policy, or the standing
// guarantees, which the tool decides from the task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

test('vague task returns a brief explanation + a few short questions exactly once', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'r1', task: 'improve my loop', userMessages: ['improve my loop'] });
  assert.equal(r.status, 'OK');
  assert.equal(r.runId, 'r1');
  assert.ok(Array.isArray(r.questions));
  assert.ok(r.questions.length >= 3 && r.questions.length <= 5, `expected 3-5 short questions, got ${r.questions.length}`);
  // Explain-first: the brief must arrive with the questions so the operator knows how to answer.
  assert.ok(typeof r.explanation === 'string' && r.explanation.length > 80, 'a brief explanation is included');
  assert.match(r.briefing, /dashboard is always on/i);
  assert.match(r.briefing, /improve or harden/i);
  assert.equal(r.dashboardAlwaysOn, true);
  assert.equal(r.continuation.required, false);
});

test('ask-once NEVER asks the operator to decide model, promotion mode, policy, or the standing guarantees', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'rpol', task: 'improve my loop' });
  const blob = r.questions.join('\n');
  // None of these model-internal policy choices may be posed back to the operator.
  assert.doesNotMatch(blob, /promotion mode/i, 'must not ask the operator to choose promotion mode');
  assert.doesNotMatch(blob, /\bdeterministic\b[\s\S]*\bsubjective\b|\bsubjective\b[\s\S]*\bdeterministic\b/i, 'must not pose deterministic-vs-subjective as an operator choice');
  assert.doesNotMatch(blob, /which .{0,20}\bmodel|model limit|budget\/?model|\bgpt-5|\bglm-5|opus-4/i, 'must not ask the operator to choose the model/route');
  assert.doesNotMatch(blob, /char ?cap|≤?\s*3000\s*char|3000\s*char/i, 'must never introduce a 3000-char cap');
  // And the explanation must state that the tool — not the operator — owns those decisions.
  assert.match(r.explanation, /I decide the model routes/i);
  assert.match(r.explanation, /promotion rule|internal threshold/i);
  assert.match(r.explanation, /you decide the goal/i);
});

test('answers move the run to INITIALIZED and never re-ask', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'r2', task: 'make it better' });
  const r2 = engine.initialize_loop_run({ runId: 'r2', answers: ['precision up 10%', 'my loop file', 'fewer tokens, same pass rate', 'keep my authorship', 'keep moving'] });
  assert.equal(r2.status, 'OK');
  assert.equal(r2.questions, undefined); // no more questions
  // a third call must not ask again
  const r3 = engine.initialize_loop_run({ runId: 'r2', task: 'make it better' });
  assert.equal(r3.questions, undefined);
  assert.match(r3.message, /Already initialized/i);
});

test('a specific task initializes immediately with no questions', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'r3', task: SPECIFIC_TASK });
  assert.equal(r.status, 'OK');
  assert.equal(r.questions, undefined);
  assert.match(r.message, /Initialized/);
  assert.equal(r.dashboardAlwaysOn, true);
  assert.match(r.briefing, /dashboard is always on/i);
});

test('user messages are stored locally with sha256 hashes', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'r4', task: SPECIFIC_TASK, userMessages: ['msg one', 'msg two', 'fuck this build the real thing'] });
  const state = store.load('r4');
  assert.equal(state.userMessages.length, 3);
  for (const m of state.userMessages) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof m.text, 'string');
  }
});

test('non-frontier requested model is auto-corrected, not blocking init', () => {
  const { engine, store } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'r5', task: SPECIFIC_TASK, model: 'claude-haiku-4-5' });
  assert.equal(r.status, 'OK');
  const state = store.load('r5');
  assert.equal(state.config.model.primary, 'claude-opus-4-8'); // defaulted away from haiku
  assert.ok(r.modelWarning);
});

test('failure patience is clamped into the 10–15 advisory band', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'r6', task: SPECIFIC_TASK, config: { failurePatience: 99 } });
  assert.equal(store.load('r6').config.failurePatience, 15);
  engine.initialize_loop_run({ runId: 'r7', task: SPECIFIC_TASK, config: { failurePatience: 2 } });
  assert.equal(store.load('r7').config.failurePatience, 10);
});

test('tools require initialization first (BLOCKED before ask-once is satisfied)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'r8', task: 'vague' }); // stays AWAITING_ANSWERS
  const r = engine.loop_start({ runId: 'r8', loop: 'strip-miner' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'NOT_INITIALIZED');
});

test('the stop-condition notice is surfaced at the very start (leak #5)', () => {
  const { engine } = freshEngine();
  const exact = 'WARNING: You are the stop condition. This loop does not stop until you stop it.';
  const vague = engine.initialize_loop_run({ runId: 'r9', task: 'improve my loop' });
  assert.equal(vague.stopCondition, exact); // shown with the questions
  const initd = engine.initialize_loop_run({ runId: 'r10', task: SPECIFIC_TASK });
  assert.equal(initd.stopCondition, exact); // and on immediate init
});

test('the deeper-explanation answer is honored in the same response, no re-ask (leak #2)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'r11', task: 'make it better' }); // → questions
  // operator answers the final question asking to go deeper
  const initd = engine.initialize_loop_run({ runId: 'r11', answers: ['precision up', 'my loop', 'fewer tokens same quality', 'keep authorship', 'yes go deeper please'] });
  assert.equal(initd.status, 'OK');
  assert.equal(initd.questions, undefined, 'must not re-ask');
  assert.ok(initd.deeperExplanation, 'a deeper explanation is included');
  assert.match(initd.deeperExplanation, /phase-gated|tool-measured|stop condition/i);
});

test('no deeper explanation when the operator says keep moving', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'r12', task: 'make it better' });
  const initd = engine.initialize_loop_run({ runId: 'r12', answers: ['precision up', 'my loop', 'fewer tokens', 'no regress', 'no just keep moving after the brief'] });
  assert.equal(initd.status, 'OK');
  assert.equal(initd.deeperExplanation, undefined);
});
