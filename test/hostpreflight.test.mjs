// Leak #7: host capability preflight. A LOCAL report of which known frontier-agent
// CLIs are installed on PATH — filesystem stat only, never executing a command and
// never probing a model-supplied binary name. Presence on PATH is reported as
// presence on PATH, not as proof of working auth and not as SOTA/web research.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHostCapabilities, KNOWN_ROUTE_CLIS } from '../src/host.mjs';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

test('detects a known CLI placed on an injected PATH, and misses an absent one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superloop-bin-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, '#!/bin/sh\necho hi\n');
  chmodSync(bin, 0o755);
  const report = detectHostCapabilities({ env: { PATH: dir }, platform: 'linux' });
  const claude = report.routes.find((r) => r.name === 'claude');
  const codex = report.routes.find((r) => r.name === 'codex');
  assert.equal(claude.installed, true);
  assert.equal(claude.path, bin);
  assert.equal(codex.installed, false);
  assert.equal(codex.path, null);
  assert.equal(report.installed.includes('claude'), true);
});

test('the allowlist is fixed — exactly the known frontier CLIs, nothing model-supplied', () => {
  const report = detectHostCapabilities({ env: { PATH: '' }, platform: 'linux' });
  assert.deepEqual(report.routes.map((r) => r.name), KNOWN_ROUTE_CLIS.map((c) => c.name));
  assert.match(report.method, /no command executed/i);
  assert.match(report.boundary, /not.*auth|not.*research/i);
});

test('the tool surfaces the report and the honest boundary', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'HP1', task: SPECIFIC_TASK });
  const r = engine.host_capability_preflight({ runId: 'HP1' });
  assert.equal(r.status, 'OK');
  assert.ok(Array.isArray(r.routes) && r.routes.some((x) => x.name === 'claude'));
  assert.match(r.method, /filesystem stat only/i);
  assert.match(r.advisory, /not.*SOTA|not.*research/i);
});

test('preflight works without a run (library-level) and rejects a path-like runId', () => {
  const { engine } = freshEngine();
  const ok = engine.host_capability_preflight({});
  assert.equal(ok.status, 'OK');
  const bad = engine.host_capability_preflight({ runId: '../escape' });
  assert.equal(bad.status, 'BLOCKED');
  assert.equal(bad.code, 'BAD_INPUT');
});
