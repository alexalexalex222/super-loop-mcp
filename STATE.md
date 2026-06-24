# super-loop-mcp — build state

Fresh rebuild (old build moved to `../super-loop-mcp.backup-20260623-pre-rebuild`).
Local-first Sling runtime. Zero runtime/dev dependencies (Node ESM). The operator is the only stop condition.

## Mandated sources (bundled, hash-locked, FULL PRIVATE, byte-identical to source)
- `loops/strip-miner.txt`   = The Strip Miner Loop, 345 lines, sha256 5270d691…ed9ec9  (byte-identical to `../loop-de-loop-cross-agent-strip-miner-latest.txt`; NOT patched — the SUPERVISOR owns stop policy, so the loop text stays verbatim)
- `loops/loop-de-loop.md`   = Loop-de-loop (Loop 2), 75 lines, sha256 70090e03…022b44  (byte-identical to `../loop-2-adaptive-metrics-latest.txt` = `../provenance_compare/ace/loop_de_loop_full.md`; product name is Loop-de-loop, NOT "loop hardener")

## Requirement checklist (12 non-negotiables)
1. [x] Fresh standalone local-first MCP package, no FoldOps/Design Router
2. [x] Bundle full 345-line miner + full hardener; verify hashes in tests
3. [x] Tools: initialize_loop_run, request_next_phase, register_hypotheses, test_hypothesis, cycle_decision_request, update_dashboard + artifact/benchmark/reverify/promotion/report
4. [x] Ask-once: 3-5 short questions at start; never ask/stop after init; store user messages + hashes
5. [x] Phase-gated streaming: hold loops in MCP, stream section only after prior section has evidence; else BLOCKED
6. [x] Benchmark-first: baseline hash-locked; scorecard frozen before challenger; model-reported metrics never promote
7. [x] Hypothesis engine: 3-5 hypotheses, frontier routes only; reject haiku/mini; one no-improvement run != perfect
8. [x] Score matrix: every hypothesis tool-measured Token Cost + Benchmark Quality; promotion needs threshold frontier movement
9. [x] 10-15 failure patience -> advisory economic-exhaustion/dashboard review, NOT campaign complete
10. [x] Dashboard file with a polished stop-condition notice + Approve/Sludge/notes; deterministic lanes don't wait
11. [x] Tests: BLOCKED states, ask-once, phase-skip, short-miner-not-used, 3-5 hypo, mini reject, fake-metric reject, old-green-without-matrix blocked, measured winner allowed, no-winner blocked, dashboard warning
12. [x] Build + tests run; README + proof artifacts

## Leak-sealing pass (2026-06-23, Opus hands)
Sealed the remaining band-aids that passing tests had hidden. New leaks closed:
1. [x] Leak #1 — first-class LOCAL loop library: `loop_register` / `loop_library` tools. Custom loops hash-locked, safe-id'd, persisted under `<home>/custom-loops/`, sectionized, streamed through the SAME phase gate; cannot collide with/overwrite the mandated loops.
2. [x] Leak #2 — ask-once "deeper explanation" answer is now honored: the 6th question's answer, if it asks to go deeper, returns `deeperExplanation` in the SAME initialized response, no re-ask/no block.
3. [x] Leak #3 — measurement authority: the MCP DERIVES metrics from recorded bytes (`src/measure.mjs`). tokenCost always tool-computed; quality tool-computed via the frozen benchmark's deterministic oracle. Caller-reported measurements refused by benchmark/test gates (`MEASUREMENT_AUTHORITY`); subjective quality routes to the dashboard, never auto-promotes (`QUALITY_UNVERIFIED`); `reverify_run` re-derives from sealed bytes. Honest boundary documented (no external-runner authority; no subjective quality judging).
4. [x] Leak #5 — polished stop-condition notice surfaced in every init response (`stopCondition`).
5. [x] Leak #6 — host-level "never stop" stated honestly (MCP ≠ host scheduler); continuation obligations unchanged + still proven.
6. [x] Leak #7 — `host_capability_preflight` (`src/host.mjs`): PATH presence detection only, no command execution, not SOTA/web research.
7. [x] Leaks #4/#8/#9/#10 preserved: dashboard-only review (no model resolve path), mandated loops hash-locked, no stop/pause terms, Sling/Super Loop naming.

## 2026-06-24 supervisor/harness pass (Opus) — Sling is the supervisor, not passive tools
Backups of every mutated file under `.backup-20260624-supervisor/`. Changes:
1. [x] Sling = supervisor/harness: campaign owns a lane/target queue (`mine` → Strip Miner, `improve` → Loop-de-loop). Only supervisor-accepted transitions count as progress; a worker summary/"done"/bare tool call never clears the continuation obligation.
2. [x] Full PRIVATE loops, byte-identical to source (no patches): restored `strip-miner.txt` to the verbatim 345-line source (hash 5270d691…). Never-stop is enforced by the SUPERVISOR, not by editing loop text.
3. [x] Saturation AUTO-TRANSITION: `report_saturation` (and cycle_decision intent `saturate`) marks the lane saturated and auto-pivots Strip Miner → Loop-de-loop / next lane. Never pauses/awaits/stops.
4. [x] Branch retirement = 30 VALID no-improvement test batches → retire branch + PIVOT (not a campaign stop). Invalid/fake-metric/summary-only batches are BLOCKED upstream and never count. 10–15 is a separate RISK ADVISORY that never stops.
5. [x] Renamed product loop to **Loop-de-loop** (id `loop-de-loop`, file `loop-de-loop.md`); "loop-hardener"/"hardener" kept only as back-compat resolution aliases. No "loop hardener" product name anywhere user-facing.
6. [x] Exact warning text: `WARNING: You are the stop condition. This loop does not stop until you stop it.`
7. [x] Ask-once adds the mine-vs-improve question + keeps the deeper-explanation offer; still asks NO model/promotion/policy/cap questions.
8. [x] Builder/gating routing: builds + in-loop gating route to Opus 4.8 / GLM 5.2 (`BUILDER_GATING_ROUTES`); Codex/GPT stays a host surface, refused as in-loop builder (`register_hypotheses.builderRoute` → BUILDER_ROUTE block). Codex NOT removed from any host config.
9. [x] New tools: `report_saturation`, `campaign_status` (21 → 23). Dashboard adds a lanes/target-queue panel + "pending review never blocks" copy.
10. [x] **Option B — live executor (`src/executor.mjs`, tool `execute_full_test`, 23 → 24).** OFF by default; opt in with `SUPER_LOOP_ALLOW_EXEC=1`. The SUPERVISOR launches 3-5 allowlisted workers (claude/codex/glm/gemini) via `execFileSync` (NO shell), prompt passed via temp FILE (never argv → no injection), captures output, parses real token usage when the CLI emits it, hard timeout+kill, then feeds the tool-captured bytes through the SAME gate as test_hypothesis. Closes the fabrication hole: no model-supplied run-log to fake. Failed/timed-out/non-allowlisted launch = INVALID batch (doesn't count toward retirement). Default no-exec posture preserved for anyone who doesn't opt in.
11. [x] ~~Autonomous DRIVER (`src/driver.mjs`)~~ — SUPERSEDED in step 12 by the real supervisor. driver.mjs/driver.test.mjs removed (snapshot in `.backup-20260624-supervisor-core/`); `run_campaign` + CLI repointed to the supervisor.
12. [x] **Sling SUPERVISOR — the active harness (`src/supervisor.mjs`, +`test/supervisor-core.test.mjs`).** The correction: an MCP tool is passive; a model calling a tool is not enforcement. The supervisor OWNS the transaction — compile phase contract (only the SLICE + loop hash, never the full loop) → dispatch worker → `validateWorkerPacket` (the enforcement boundary) → supervisor-run evals → accepted transition OR re-enter/retry/replace. Worker invalidation rejects: SUMMARY_ONLY, EARLY_STOP, MISSING_ARTIFACTS, MISSING_EVIDENCE, NO_COMPARABLE_OUTPUT, PHASE_SKIP, COPIED_PUBLIC, MODEL_REPORTED_METRIC, SELF_PROMOTION, SELF_STOP. A FullTestBatch = 1 hypothesis × 3-5 frontier workers; invalid workers make the batch invalid and it does NOT count toward the 30-batch retirement. Continuous campaign: target queue (mine→improve), bank Stones on measured+reverified wins, advance/retire→pivot, re-mine on empty; never self-completes. **Workers are INJECTED**, so the whole boundary is proven with MOCK workers (no exec). `requireFullLoops()` returns the exact `MISSING_FULL_PRIVATE_LOOPS` if a loop is absent. `run_campaign` tool + `super-loop-run` CLI drive it with the real `executorWorker` (exec opt-in); each improve target is its own measured sub-run (no baseline-lock collision). **Live-run caught a real bug** the mock tests couldn't: `dispatchWorker` passed `attempt` as the worker's 2nd positional, clobbering `executorWorker`'s `env` → exec read as disabled; fixed (attempt now rides inside the contract) + regression test added.

13. [x] **Real CLI integration + gaps finished + REAL validation.** Fixed the executor for real CLIs: prompt on **STDIN** (not a file-path arg — real `claude -p` ignores that), per-CLI args, codex `OPENAI_BASE_URL` unset, and `extractResult()` pulls the real answer text from the JSON envelope for benchmarking. **Gap #1 (real Strip Miner candidates):** `parseCandidates()` extracts a worker's `<CANDIDATES>` JSON, drops reference_only/public, never invents one; wired into the mine lane. **Gap #2 (benchmark evaluates REAL output):** judge mode — an INDEPENDENT judge (Opus/GLM only) scores baseline-vs-challenger final outputs under a rubric, supervisor parses the verdict (challenger never scores itself), subjective wins QUEUE to the dashboard (never auto-promote). PROVEN FOR REAL (not sandbox — operator authed): live `claude -p` via executorWorker returned "OK" metering 4348 real tokens; live claude judge scored a vivid-writing pair winner=challenger 0.97 with reasoning, parsed cleanly. Also caught+fixed a dispatch-arg bug via the live run. Remaining: a full real campaign on the 345-line loops with real frontier agents is exercisable via the CLI but is a cost/time call for the operator (orchestration proven by 118 tests + live CLI + real primitives).

## Verification completed (2026-06-24)
- `node --test` -> 118/118 passing (+parseCandidates, +parseJudgeVerdict, +judge-mode campaign, +judge-route guard)
- REAL frontier validation (operator authed, not a sandbox): executorWorker→live claude (4348 tokens, result captured); live claude judge (4606 tokens, verdict {winner:challenger, score:0.97} parsed). codex present (alias; base-url unset handled); glm has no local CLI.
- (superseded line) prior counts: (+supervisor-core.test: mock-worker enforcement boundary, FullTestBatch validity counting, Stone banking, saturation auto-transition, retirement pivot, dispatch-arg regression; -driver.test removed)
- `node scripts/verify-sources.mjs` -> strip-miner 345 lines / sha256 5270d691319120758423503e74c5aa6b378409b55f30bc6d2f2f7ca283ed9ec9 (byte-identical to source); loop-de-loop 75 lines / sha256 70090e033e995374710722771372d1afb17b6f0f823b2ce2911d9bfd38022b44
- `node scripts/demo.mjs` -> 38/38 demo checks passed through the real stdio MCP server (25 tools)
- executor proven against a FAKE allowlisted binary: allowlist mapping, no-shell/no-injection (sentinel never created), output capture, real-token parse (1234), timeout kill, invalid-batch-doesn't-count, OFF-by-default. A real frontier run is validated in the operator's authed env (cannot run authed CLIs in this sandbox).
- supervisor proven LIVE via the standalone CLI (`SUPER_LOOP_ALLOW_EXEC=1 node scripts/run-campaign.mjs`, fake workers): self-set-up then 2-3 VALID FullTestBatches (3-5 workers each, every output validated through the enforcement boundary), halted on the safety cap "(NOT completion)". The live run caught + fixed the dispatch-arg bug. Stop-file halts immediately; EXEC_DISABLED without opt-in; mock workers prove every invalidation reason offline.
- LIVE stdio drive: ask-once shows the mine-vs-improve question + new warning; `report_saturation` auto-transitions mine→loop-de-loop with continuation.required (never stops)
- Host exposure preserved: Codex `~/.codex/config.toml [mcp_servers.super-loop]` → `~/.local/bin/super-loop-mcp` (wraps node src/server.mjs); Claude Code `~/.claude.json "super-loop"` → src/server.mjs
- Full private sources: `strip-miner.txt` == `../loop-de-loop-cross-agent-strip-miner-latest.txt`; `loop-de-loop.md` == `../loop-2-adaptive-metrics-latest.txt` == `../provenance_compare/ace/loop_de_loop_full.md`

## Layout
src/{constants,util,models,measure,host,scorecard,loops,store,engine,dashboard,server}.mjs ; server.mjs (root entry) ; scripts/{demo,verify-sources}.mjs ; test/*.test.mjs ; proof/

## Resume
`cd super-loop-mcp && npm test && npm run verify && npm run demo`
