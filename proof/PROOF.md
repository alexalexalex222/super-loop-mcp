# super-loop-mcp — live demo proof

Driven over real stdio JSON-RPC against `src/server.mjs`. 38/38 checks passed.

## Checks
- PASS server lists all 25 tools incl. autonomous driver + supervisor lanes + live executor + loop library
- PASS explain-first brief + a few short questions returned once
- PASS ask-once never poses model/promotion-mode/policy choices to the operator
- PASS initialized with no further questions
- PASS init surfaces the stop-condition notice up front
- PASS no deeper explanation when the operator says keep moving
- PASS answering the last question yes returns a deeper explanation, no re-ask/no block
- PASS preflight reports known routes via PATH detection, no command executed
- PASS custom loop registered, hash-locked, phase-gated
- PASS cannot overwrite a mandated hash-locked loop
- PASS library lists 2 mandated + the custom loop
- PASS custom loop streams section 0 through the same phase gate
- PASS custom loop also blocks PHASE_SKIP without evidence
- PASS evidence unlocks the custom loop next section
- PASS section 0 carries the /loop loop-de-loop trigger
- PASS only one section streamed (not the whole 345-line file)
- PASS request_next_phase BLOCKED without evidence (PHASE_SKIP)
- PASS evidence unlocks the next section
- PASS saturation auto-transitions to loop-de-loop, not a stop
- PASS campaign_status reports lanes; pending review never blocks; 30-batch retirement; builder routes
- PASS benchmark frozen + tool-computed bar set
- PASS caller-reported measurement rejected (MEASUREMENT_AUTHORITY)
- PASS haiku route rejected (BANNED_ROUTE)
- PASS Codex as in-loop BUILDER is refused (builds route to Opus 4.8 / GLM 5.2)
- PASS 3 frontier hypotheses accepted
- PASS measured full test moved the frontier (tool-computed quality)
- PASS promotion blocked before reverify
- PASS deep reverify passes on sealed artifacts
- PASS tool-measured + reverified winner promoted
- PASS hypothesis with no score matrix is blocked
- PASS model cannot declare the campaign perfect/complete
- PASS blocked completion creates a continuation obligation
- PASS continue_run records intent but does not clear without real progress
- PASS a real progress tool clears the continuation obligation
- PASS model-callable human review resolve is blocked (dashboard-only)
- PASS dashboard written with the stop-condition notice
- PASS report exported
- PASS report export leaves a continuation obligation

Dashboard: `/path/to/super-loop-mcp/proof/.super-loop-demo/runs/demo-run/dashboard.html`
Report: `/path/to/super-loop-mcp/proof/.super-loop-demo/runs/demo-run/report.md`
Transcript: `proof/demo-transcript.txt`

_The campaign ended promoted, but not complete. The operator is the only stop condition._
