# Evaluation archive

The v0.5.0 baseline's raw runs are not in Git, because traces and stderr hold local paths and session ids. This folder holds what can be published: [`v0.5.0-baseline.manifest.json`](v0.5.0-baseline.manifest.json), with the SHA-256 of all 118 files, each of the 23 runs' recorded check verdicts, and the recorded metrics.

| Item | Location | In Git |
|---|---|---|
| Manifest | `docs/evaluation-archive/v0.5.0-baseline.manifest.json` | Yes |
| Raw baseline, read-only | `.eval-out/archive/v0.5.0-baseline/` | No (ignored) |
| Compressed copy | `.eval-out/archive/v0.5.0-baseline.tar.gz` | No (ignored) |

`.eval-out/` is local to one clone: `git clean -fdx` deletes it, and a fresh clone does not have it. **Keep a copy of the `.tar.gz` outside the repository.** A clone without the archive still passes `npm test`: the baseline regrade test reports as skipped, and the manifest tests still run.

## Verify

```bash
npx tsx test-agent/eval/baselineArchive.ts verify
```

This checks every file against the manifest, regrades all 23 runs into a temporary directory with the current evaluator, compares verdicts and metrics with the recorded ones, and checks the files again. It needs no model, key or network, and it never writes to the archive.

To verify an archive somewhere else, pass its path or set `MARKETMIND_BASELINE_DIR`. The same variable points the test suite at it.

## Restore

The `.tar.gz` must have this SHA-256 (also `archive.sha256` in the manifest):

```text
f540043c31c54da19ea71add2f5b704efd10c3f39f778479abf5255e465f5fb7  v0.5.0-baseline.tar.gz
```

Then:

```bash
mkdir -p .eval-out/archive
tar -xzf /path/to/v0.5.0-baseline.tar.gz -C .eval-out/archive
npx tsx test-agent/eval/baselineArchive.ts verify
```

## Rules

- Never edit the archive. Its files are read-only, and `evaluate.ts` refuses to regrade over artifacts from another grader revision. Use `--output <newDir>`.
- Never commit it, or anything derived from its traces or stderr.
- `verify` fails on any missing, extra or changed file. Restore from the `.tar.gz` rather than regenerating the manifest. Regenerating is only for a deliberately new baseline.

The baseline was first held in a temporary session directory. It was copied here unchanged on 2026-10-31, and its hashes were compared with the source.
