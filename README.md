# super-loop-mcp

A **local-first Sling supervisor/harness** for evidence-gated agent loops — The Strip Miner Loop, Loop-de-loop (Loop 2), human-in-the-loop — without letting a model fake its way to "done". Sling is not a prompt and not passive tools: it owns campaign state, the lane/target queue, transitions, benchmark math, the dashboard, and stop policy. A worker only proposes; only a supervisor-accepted transition counts as progress. Two surfaces share one engine: the **reactive MCP** (a host calls its tools — the in-conversation hook) and the **autonomous driver** (`super-loop-run` CLI / `run_campaign` tool) that drives the whole campaign itself and only stops on the operator stop-file.

The whole point: a model **cannot** promote, upgrade, or call a loop "perfect" from reasoning alone. Every decision is hooked through a tool that demands **tool-measured artifacts on disk**, and **the operator is the only stop condition**.

> Built fresh, zero dependencies, runs on plain Node ≥18. The full private 345-line Strip Miner and the full private 75-line Loop-de-loop (Loop 2) live **inside** the supervisor, byte-identical to source and hash-locked, streamed one section at a time.

---

## Why this exists

Drop a 300+ line loop into a model's context and it may ingest the whole thing, skip the structure, and treat an unverified argument as a test. This server fixes that with five hard mechanics:

1. **Ask-once** — starts with a brief explanation plus a few short questions *once* (goal, starting point, what "better" means, any task-specific limit, and a final deeper-explanation offer that is honored in the same response). It never asks you to choose the model, promotion mode, or benchmark policy — the tool decides those from the task — and afterward it does not ask again or mark the campaign complete by itself.
2. **Phase-gated streaming** — holds the loop inside the MCP and hands you the next section only after the current one has recorded evidence. No 1k-line dump.
3. **Benchmark-first** — the baseline is hash-locked and the scorecard is frozen *before* any challenger. Model self-reported metrics never count.
4. **Frontier hypothesis engine** — full tests need 3–5 hypotheses on frontier routes (haiku/mini/nano/lite/prior-gen rejected); one no-improvement run is never "perfect".
5. **Promotion gate** — promotion requires a tool-measured, deep-**reverified** result that moves the quality/cost frontier past threshold. Otherwise: `BLOCKED`.

The campaign never marks itself complete. The dashboard keeps the stop condition visible:

```
WARNING: You are the stop condition. This loop does not stop until you stop it.
```

---

## The bundled loops (hash-locked)

| id | file | lines | sha256 | trigger |
|----|------|-------|--------|---------|
| `strip-miner` | `loops/strip-miner.txt` | 345 | `5270d691…ed9ec9` | `/loop strip-miner` (The Strip Miner Loop / cross-agent source miner) |
| `loop-de-loop` | `loops/loop-de-loop.md` | 75 | `70090e03…022b44` | `/loop loop-de-loop` (Loop 2 / improve an approved loop) |

These are the **local big** sources. The Strip Miner is based on `../loop-de-loop-cross-agent-strip-miner-latest.txt` with the old pause/complete language patched into checkpoint/continue semantics; the server refuses to start, and the test suite fails, if either file's hash or line count drifts — so the short public miner can never be silently substituted.

### Add your own loops (local loop library)

Users add their own loops to the local MCP through a **tool**, not by hand-editing source:

```
loop_register { id:"my-loop", title:"My Loop", content:"<full loop text>" }   → hash-locked, sectionized, persisted locally
loop_library                                                                   → lists mandated (hash-locked) + your custom loops
loop_start  { loop:"my-loop" }                                                 → streams it phase-gated, exactly like the mandated loops
```

Custom loops are sha256 hash-locked (write-once per version; `overwrite:true` makes a new version), get a safe id (no path traversal), persist under `SUPER_LOOP_HOME/custom-loops/`, and **cannot collide with or overwrite** the mandated Strip Miner / Loop-de-loop. They stream through the same phase gate. Nothing leaves your machine.

---

## Tools (25)

| tool | what it enforces |
|------|------------------|
| `run_campaign` | **autonomous supervisor (opt-in `SUPER_LOOP_ALLOW_EXEC=1`)** — one call drives the whole campaign (intake → target queue mine→improve → FullTestBatches → reverify → promote/bank Stone → advance/retire → re-mine) until the operator stop-file. Every worker output is **validated** (summary-only/early-stop/fake-metric/self-promote/phase-skip/copied-public rejected + re-entered); invalid batches don't count. `maxBatches` is a safety cap, not completion. Unbounded via the `super-loop-run` CLI. Returns `MISSING_FULL_PRIVATE_LOOPS` if a full loop is absent. |
| `initialize_loop_run` | ask-once (brief + a few short Qs incl. mine-vs-improve; no model/promotion/policy/cap questions — the supervisor decides those); stores every user message with a sha256 hash; picks a frontier model; surfaces the stop-condition notice up front; honors the "deeper explanation" answer in the same response |
| `loop_register` | **add your own loop** to the local MCP: hash-lock, safe id, sectionize, persist locally; never overwrites a mandated loop |
| `loop_library` | list mandated (hash-locked) + custom local loops |
| `loop_start` | begin phase-gated streaming of any loop (mandated or custom); returns section 0 only |
| `request_next_phase` / `loop_next` | next section **iff** the current one has evidence, else `PHASE_SKIP` |
| `observation_record` | lightweight phase evidence |
| `artifact_record` | persist a raw artifact + sha256; `role:"baseline"` hash-locks (write-once); `measurement` makes the MCP **derive** a tool-computed measurement from the bytes; pass explicit `content` (`sourcePath` reads refused) |
| `benchmark_propose` / `benchmark_select` | propose scorecards (≥1 value dim, ≥1 cost dim, ≥1 case, optional deterministic `oracle`) and **freeze** one |
| `benchmark_run` | set the tool-**computed** baseline bar; a caller-reported measurement is rejected |
| `register_hypotheses` | 3–5 frontier hypotheses; benchmark-first; rejects banned routes |
| `test_hypothesis` | one full test = 3–5 frontier agents, each tool-computed; aggregates vs the bar; reports quality authority |
| `execute_full_test` | **opt-in (`SUPER_LOOP_ALLOW_EXEC=1`)** — the supervisor itself launches 3–5 allowlisted workers (`execFile`, no shell, prompt via temp file), captures output, parses real token usage, and gates on the tool-captured bytes; off by default → `EXEC_DISABLED` |
| `reverify_run` | **re-derive** metrics from the sealed raw bytes and confirm they reproduce (a tampered number cannot survive) |
| `promotion_request` | promote only on measured + reverified frontier movement; a quality win the MCP can't tool-verify routes to the dashboard (`QUALITY_UNVERIFIED`) |
| `cycle_decision_request` | **the supervisor hook** — a worker proposes a transition packet (promote/advance_phase/change_baseline/change_benchmark/saturate); only a supervisor-accepted transition is progress; completion/stop intents refused |
| `report_saturation` | mark a lane saturated → supervisor **auto-transitions** to the next lane (Strip Miner → Loop-de-loop); never pauses/stops |
| `campaign_status` | read-only lane/target queue, auto-transitions, 30-batch retirement + 10–15 advisory accounting, pending dashboard review (never blocks) |
| `continue_run` | records the next lane + first concrete action; it does **not** clear the obligation until a real progress tool runs |
| `human_review_request` | queue/list Approve/Sludge items only; model-callable resolve is blocked |
| `update_dashboard` | render the polished always-on local dashboard with the stop-condition notice |
| `report_export` | reproducible markdown campaign report |
| `host_capability_preflight` | local report of which frontier-agent CLIs are installed on PATH — filesystem stat only, never executes a command, not SOTA/web research |

### Block codes you will see
`NOT_INITIALIZED · PHASE_SKIP · BASELINE_FIRST · BASELINE_LOCKED · BENCHMARK_FIRST · BENCHMARK_FROZEN · WEAK_BENCHMARK · BASELINE_BAR_FIRST · HYPOTHESIS_COUNT · BANNED_ROUTE · BUILDER_ROUTE · FULLTEST_AGENTS · MODEL_REPORTED · MEASUREMENT_AUTHORITY · QUALITY_UNVERIFIED · NO_SCORE_MATRIX · NOT_REVERIFIED · BELOW_THRESHOLD · BELOW_FLOOR · STAGED_TRADEOFF · OPERATOR_IS_STOP · DASHBOARD_ONLY · NO_ACTIVE_LANE · EXEC_DISABLED · EXEC_FAILED · LOOP_EXISTS · LOOP_SOURCE`

### Live execution + autonomous harness (option B, opt-in)
By default the server **never executes commands** (audited posture). Set `SUPER_LOOP_ALLOW_EXEC=1` to let Sling own benchmark execution end-to-end: `execute_full_test` launches the frontier workers itself (allowlisted `claude`/`codex`/`glm`/`gemini` only, via `execFile` with no shell, prompt passed as a temp file so untrusted text never reaches argv), captures each output, parses real token usage when the CLI reports it, enforces a hard timeout, and feeds the **tool-captured** bytes through the same gate. This closes the last self-report hole — when the supervisor launches the worker, there is no model-supplied run-log to fabricate. A failed/timed-out/non-allowlisted launch is an invalid batch and does not count toward retirement.

The **autonomous driver** sits on top of that — it's the difference between "a supervisor you call" and "a harness that drives itself":

```bash
SUPER_LOOP_ALLOW_EXEC=1 node scripts/run-campaign.mjs --config campaign.json --stop-file ./STOP
```

It runs the whole loop unattended (intake → mine → improve targets → validate every worker → bank Stones → advance/retire → re-mine) and **only stops when you create the stop-file**. The same logic is the `run_campaign` MCP tool, bounded by `maxBatches` for the in-call version. An MCP alone is reactive (a host calls it); the supervisor is what makes Sling self-driving.

Workers run on the real CLIs via **stdin** (`claude -p --output-format json`, `codex exec --json`) — the prompt never touches argv (no injection), and the real answer text + token usage are extracted for benchmarking. **Benchmark modes:** `oracle` (deterministic → auto-promote on a measured win) and `judge` (an independent Opus/GLM judge scores baseline-vs-challenger *real outputs* under a rubric → subjective → queues to the dashboard, never auto-promotes; the challenger never scores itself).

---

## Run it

```bash
cd super-loop-mcp
npm test          # node --test — unit + integration + transport
npm run demo      # spawns the real server, drives a full campaign over stdio
npm run verify    # prove bundled loop hashes against the mandated contract
```

`npm test` needs no install (zero deps). `npm run demo` writes `proof/PROOF.md` and `proof/demo-transcript.txt`, and a live dashboard + report under `proof/.super-loop-demo/runs/`.

### Register with Claude Code

The server speaks MCP over stdio. Point your host at either entrypoint:

```json
{
  "mcpServers": {
    "super-loop": {
      "command": "node",
      "args": ["/path/to/super-loop-mcp/src/server.mjs"]
    }
  }
}
```

State lives under `SUPER_LOOP_HOME` (default `<package>/.super-loop`). Nothing leaves your machine.

---

## A full campaign, in order

```
initialize_loop_run            → brief + ask-once (a few Qs) → answer → INITIALIZED
loop_start strip-miner         → section 0
  observation_record (phase 0) → request_next_phase → section 1 → … (gated)
artifact_record role=baseline  → hash-locked
benchmark_propose → benchmark_select        → scorecard frozen
artifact_record measurement → benchmark_run arm=baseline   → bar set (tool-measured)
register_hypotheses (3–5 frontier)
test_hypothesis (3–5 agents, tool-measured) → MOVED_FRONTIER | NO_IMPROVEMENT
reverify_run → promotion_request            → PROMOTE | BLOCKED
update_dashboard / report_export            → checkpoint; lanes keep running
```

Two distinct thresholds, neither of which stops the campaign:
- **Risk advisory (10–15, configurable):** after ~12 consecutive valid no-improvement full tests the supervisor raises an **economic-exhaustion risk advisory** and opens dashboard review — it only **reports risk**, it does not stop.
- **Branch retirement (30 valid batches):** a branch retires only after **30 valid full real test batches** (3–5 frontier workers each) with no qualifying improvement, then the supervisor **auto-pivots to the next lane**. Invalid / fake-metric / early-stopped / summary-only batches are blocked upstream and never count.

If the Strip Miner saturates, the supervisor **auto-transitions** (Strip Miner → Loop-de-loop, or the next improvement lane) via `report_saturation` — never a pause/await/stop. Checkpoint/report/dashboard/refused-terminal/saturation/retirement events persist a machine-readable continuation obligation until a real progress tool runs. `continue_run` records the model's next-lane commitment but deliberately cannot clear the obligation by itself. **Only the operator stops the campaign.**

---

## Design notes

- **Zero dependencies on purpose.** No SDK, nothing to `npm install` that can fail or time out, nothing phoning home. The MCP transport is ~90 lines of newline-delimited JSON-RPC in `src/server.mjs`. This directly answers "it kept failing / timing out": there is nothing to install.
- **Tool-computed measurement authority.** The MCP **derives** every metric from the recorded raw bytes — `tokenCost` always (a deterministic token estimate), `quality` via the frozen benchmark's deterministic oracle when one exists. A number the model types is `caller-reported` and is refused by the benchmark/test gates (`MEASUREMENT_AUTHORITY`). `reverify_run` re-derives from the sealed bytes, so a tampered number cannot survive. **The honest boundary, stated plainly:** the MCP cannot prove the recorded bytes came from a real frontier-agent run (true external-runner authority — the MCP spawning agents and metering real tokens — is out of v0 scope and an MCP cannot enforce it without executing untrusted commands), and it cannot judge subjective quality without an oracle. Subjective quality routes to the dashboard for a human and **never auto-promotes** (`QUALITY_UNVERIFIED`); deterministic, oracle-scored quality promotes autonomously. In short: deterministic → tool-measured, subjective → dashboard.
- **Host capability preflight, no execution.** `host_capability_preflight` resolves known frontier-agent CLI names against `PATH` with a filesystem stat — it never spawns a command, never probes a model-supplied binary, and is not SOTA/web research. Presence on PATH ≠ working auth, and it says so.
- **Anti-tampering.** Baseline and benchmark are write-once within a cycle; changing either needs an explicit new epoch + rationale.
- **Path hardening.** `runId` and artifact ids are validated before touching disk, and `sourcePath` reads are refused so a model cannot turn the MCP into a local-file reader. Submit artifact bytes through `content`.
- **Dashboard-only human review.** The model can queue/list Approve/Sludge items, but `human_review_request { action:"resolve" }` returns `DASHBOARD_ONLY`. The model cannot approve its own work. There is **no** model-callable path to resolve a review; applying dashboard decisions is an out-of-band human action, never an MCP tool.
- **Continuation is a host obligation, stated honestly.** An MCP cannot force the host agent loop to keep running — only the host can. What the MCP *can* do, and does: every report / dashboard / saturation / no-improvement / refused-terminal event persists a machine-readable **continuation obligation** with a concrete next tool+lane, and `continue_run` records intent without clearing it (only a real progress tool clears it). The MCP makes stopping early visibly incomplete; it does not pretend to be the host scheduler. The operator is the only stop condition.
- **Never overwrites your canonical loop.** Promotion records an *internal champion*; changing the canonical loop file is HUMAN-GATED and left to you.
- Not integrated with FoldOps or Design Router — standalone by design.

## Layout

```
loops/            bundled hash-locked loop sources (+ MANIFEST in constants)
src/
  server.mjs      MCP stdio JSON-RPC transport + tool schemas
  engine.mjs      Sling core — every tool handler + gate
  loops.mjs       registry, hash-lock, sectionizer (mandated + custom loaders)
  measure.mjs     tool-computed measurement (derive cost/quality from bytes) + honest boundary
  host.mjs        host capability preflight (PATH presence only, no execution)
  models.mjs      frontier-route policy (banlist/allowlist)
  scorecard.mjs   promotion frontier rule + score matrix
  store.mjs       local atomic JSON persistence (runs + custom-loops)
  dashboard.mjs   polished dashboard.html + markdown report
  constants/util  shared facts + helpers
scripts/          demo.mjs (live proof), verify-sources.mjs
test/             node:test suites (sources, ask-once, phase gate, benchmark,
                  hypotheses, promotion, hook, dashboard, transport, security,
                  loop library, measurement authority, host preflight)
```
