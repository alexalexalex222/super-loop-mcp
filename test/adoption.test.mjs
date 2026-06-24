// Operator-gated loop adoption: when a proven improvement is approved on the
// dashboard, the operator's exported decision is APPLIED — the improved loop is
// installed as a new versioned custom loop and ENFORCED by loop_start next cycle.
// Mandated canonical loops stay immutable (P8); applying a decision never stops the
// run; and adoption is NOT reachable as a model-callable tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

const LOOP_A = [
  'PHASE ONE INTAKE',
  'Improved candidate ALPHA: do the first improved thing and record evidence.',
  '',
  'PHASE TWO MEASURE',
  'Measure on the frozen benchmark; the model never self-scores.',
  '',
  'PHASE THREE VERIFY',
  'Reverify from sealed bytes, then continue. The operator is the only stop.'
].join('\n');

const LOOP_B = [
  'PHASE ONE INTAKE',
  'Improved candidate BETA: a different, stronger first move with recorded evidence.',
  '',
  'PHASE TWO MEASURE',
  'Measure on the frozen benchmark; the model never self-scores.',
  '',
  'PHASE THREE VERIFY',
  'Reverify from sealed bytes, then continue. The operator is the only stop.'
].join('\n');

function initd(engine, runId) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK, userMessages: ['go'] });
}

test('operator adopts an improved loop → installed as a versioned custom loop → loop_start streams it', () => {
  const { engine, store } = freshEngine();
  initd(engine, 'r1');
  const a = engine.operator.adoptLoop({ loopId: 'my-miner', content: LOOP_A });
  assert.equal(a.ok, true);
  assert.equal(a.version, 1);
  // installed in the global custom-loop store with the improved bytes
  assert.equal(store.readLoop('my-miner').content, LOOP_A);
  // a FRESH run streams the adopted loop from the store (enforced)
  initd(engine, 'r2');
  const s = engine.loop_start({ runId: 'r2', loop: 'my-miner' });
  assert.equal(s.status, 'OK');
  assert.equal(s.loop, 'my-miner');
  assert.ok(JSON.stringify(s).includes('ALPHA'), 'loop_start streams the adopted improved content');
});

test('adopting onto a mandated loop id is refused (canonical is immutable / P8)', () => {
  const { engine, store } = freshEngine();
  for (const id of ['strip-miner', 'loop-de-loop']) {
    const a = engine.operator.adoptLoop({ loopId: id, content: LOOP_A });
    assert.equal(a.ok, false, `${id} must be refused`);
    assert.match(a.reason, /mandated|immutable|never overwritten/i);
    assert.equal(store.readLoop(id), null, 'no custom record written for a mandated id');
  }
});

test('approving a loop-adoption review applies it (adopt + enforce) and never stops the run', () => {
  const { engine, store } = freshEngine();
  initd(engine, 'r3');
  const q = engine.human_review_request({
    runId: 'r3', action: 'add',
    item: { kind: 'loop-adoption', title: 'adopt improved miner', loopId: 'my-miner', loopContent: LOOP_A }
  });
  assert.ok(q.reviewId);
  const statusBefore = store.load('r3').status;

  const res = engine.operator.applyDashboardDecisions({ runId: 'r3', decisions: { [q.reviewId]: { decision: 'approve' } } });
  assert.equal(res.ok, true);
  assert.equal(res.applied[0].adopted.loopId, 'my-miner');

  const review = store.load('r3').humanReviews.find((r) => r.id === q.reviewId);
  assert.equal(review.status, 'APPROVED');
  assert.equal(review.adoption.loopId, 'my-miner');

  // NON-BLOCKING: applying a decision must not stop / transition / complete the run
  assert.equal(store.load('r3').status, statusBefore, 'applying a decision must not change run status (no stop)');

  // ENFORCED: a fresh run streams the adopted loop
  initd(engine, 'r4');
  assert.ok(JSON.stringify(engine.loop_start({ runId: 'r4', loop: 'my-miner' })).includes('ALPHA'));
});

test('sludging a review rejects it and adopts nothing', () => {
  const { engine, store } = freshEngine();
  initd(engine, 'r5');
  const q = engine.human_review_request({
    runId: 'r5', action: 'add',
    item: { kind: 'loop-adoption', loopId: 'sludged-loop', loopContent: LOOP_A }
  });
  engine.operator.applyDashboardDecisions({ runId: 'r5', decisions: { [q.reviewId]: { decision: 'sludge', notes: 'not good enough' } } });
  assert.equal(store.load('r5').humanReviews.find((r) => r.id === q.reviewId).status, 'SLUDGE');
  assert.equal(store.readLoop('sludged-loop'), null, 'a sludged review installs no loop');
});

test('rollback restores the previous adopted version', () => {
  const { engine } = freshEngine();
  engine.operator.adoptLoop({ loopId: 'verloop', content: LOOP_A }); // v1 (ALPHA)
  engine.operator.adoptLoop({ loopId: 'verloop', content: LOOP_B }); // v2 (BETA)
  initd(engine, 'r7');
  assert.ok(JSON.stringify(engine.loop_start({ runId: 'r7', loop: 'verloop' })).includes('BETA'), 'v2 current before rollback');

  const rb = engine.operator.rollbackLoop({ loopId: 'verloop' });
  assert.equal(rb.ok, true);
  assert.equal(rb.restoredFromVersion, 1);

  initd(engine, 'r8');
  const s = engine.loop_start({ runId: 'r8', loop: 'verloop' });
  assert.ok(JSON.stringify(s).includes('ALPHA'), 'rolled back to v1 content');
  assert.ok(!JSON.stringify(s).includes('BETA'), 'v2 content no longer streamed');
});

test('adoption is operator-only: not reachable as a model-callable tool', () => {
  const { engine } = freshEngine();
  // The server dispatch is engine[name] for FUNCTION-typed handlers only. Adoption is
  // under api.operator (an object), so tools/call can never invoke it.
  assert.equal(typeof engine.adoptLoop, 'undefined');
  assert.equal(typeof engine.adopt_loop, 'undefined');
  assert.equal(typeof engine.applyDashboardDecisions, 'undefined');
  assert.equal(typeof engine.operator, 'object');
  assert.equal(typeof engine.operator.applyDashboardDecisions, 'function');
});
