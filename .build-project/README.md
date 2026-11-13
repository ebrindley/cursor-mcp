# Build Project Directory

This `.build-project/` directory contains project-local configuration and runtime artifacts for the Build CLI.

## Directory Structure (High-Level)

```text
.build-project/
 .artifacts/                      # Legacy/generated artifacts (gitignored)
 config/
    build.config.jsonc         # Project configuration
    project-context.json        # Project detection output
 telemetry/
    state/                      # Per-run competition/variant state (repo-local; gitignored)
    logs/                       # Flywheel workflow JSONL only (repo-local; gitignored)
 state/                          # Runtime markers/locks (gitignored)
 worktrees/                      # Temporary worktrees (gitignored)
 .gitignore                      # Ignores runtime artifacts
 README.md                       # This file
```

## Configuration

- Provider settings for this project live in the `providers` block of `.build-project/config/build.config.jsonc`; `build config resolved` shows the effective values.
- Registry-level overrides that should apply to every project on this machine (available models, per-provider defaults, timeouts) belong in `~/.build/config/providers.yaml`, not in this directory.
- The same file holds advanced settings such as quality gates and execution tuning.

Live SQLite databases (`variants.db`, `validations.db`, `invocations.db`) and the
main JSONL log stream live under the Build data root (`~/.build/data/telemetry/`
by default), not in this checkout. `build doctor --verbose` prints the resolved
directory. Do not delete the whole `.build-project/telemetry/` tree: `state/` is still
the live per-run store.

## Useful Commands

```bash
build doctor
build doctor --verbose
build doctor --fix
build config resolved
```
