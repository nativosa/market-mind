# MarketMind v0.8.0

Stage 2.7: investigator reliability policy, live subscription investigations and a closed controlled pilot.

MarketMind is read-only educational research. It cannot place trades, a quoted spread is not a guaranteed profit, stored history is discrete observations, and AI reports need critical reading.

## Added

- **Targeted collection.** `collect --market-id <id>` stores one named market with 4 GETs (at most 8 attempts) and no discovery, so you can build history for that market over repeated runs.
- **Live investigation on a Claude subscription.** `test-agent/live.ts` runs one bounded investigation of one real market through the Claude Code CLI. It has an authentication gate, exactly five MCP tools, a 16-request server ceiling, live-only data, and checks after the session. It consumes your subscription usage.
- **Investigator `policy-v2`.** A revised agent file, registered by hash in `agent-sdk/policy.ts` beside `policy-v1`. The skill and settings files are unchanged.
- **Reliability detectors.** REL-1 to REL-4 (`eval-graders/6`), additive and never part of a verdict. `eval-graders/7` corrects a D13b parser gap.
- **Controlled comparison harness.** `test-agent/experiment.ts`, `policySource.ts` and `eval/pairs.ts` run a frozen, paired `policy-v1`/`policy-v2` comparison under one code path.
- **CLI authentication modes.** The CLI harness takes `--auth subscription|api-key` explicitly, with an environment allowlist, a pre-run gate and stream checks.

## Fixed

- The CLI harness enforces the five-tool boundary with `--tools ""` and `--disallowedTools`, measured offline on the pinned CLI.
- `get_market_history` no longer fails its output schema when the median gap between samples ends in .5 ms, which happens with an even number of gaps. The live runner's error messages are clearer.

## Controlled pilot

Closed at 10 runs on 2026-11-02. The optional 20-run expansion was declined. Details are in `docs/stage-2.7-experiment.md`, under "Experiment decisions".

- 10 of 10 runs, in 5 of 5 valid pairs. Both policies had 5 of 5 strict classifications and 3 of 3 correct abstentions.
- REL-1 violations went from 3 (`policy-v1`) to 0 (`policy-v2`). REL-2 recorded one `policy-v2` violation (S10), with an unresolved evidence-tagging ambiguity.
- Automated safety checks passed, and no injection sign or invalid affirmative citation was found.
- A separate AI-assisted assessment found a possible S10 prompt-injection influence and further evidence-tagging defects. No independent human review has been done.
- The pilot claims no statistically demonstrated superiority and does not meet all adoption criteria. The grader, rubrics, policies and results are unchanged.

## Security note

Claude Code warns in each pilot and live log that it ignored five `permissions.allow` entries in an untrusted temp project. The harness supplies the same rules with `--settings`, and the tool pool comes from `--tools ""`. Every recorded session listed exactly the five MarketMind tools, with no permission denials. The warning does not affect the boundary.

## Compatibility

- The database schema and the MCP contract ids are unchanged. `medianMs` now accepts a fractional value, and the new `MARKETMIND_LIVE_ONLY` server setting is off by default. New observations record app version `0.8.0`.
- Node.js 24.15 or later. Use `npm ci`: the MCP server runs through `tsx`, a dev dependency.

## Known limitations

- The investigator's semantic quality is not validated by a human, and the evaluation is synthetic and small-sample.
- V2 markets are verified live with empty books only.
- History is sample-count statistics over discrete observations, not time-weighted, and says nothing about fills or execution.
- There is no web interface yet.
