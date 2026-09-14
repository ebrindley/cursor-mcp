# Poetic Project Directory

This `.poetic/` directory contains project-local configuration and runtime artifacts for the Poetic CLI.

## Directory Structure (High-Level)

```
.poetic/
 .artifacts/                      # Legacy/generated artifacts (gitignored)
 config/
    providers.yaml              # Provider defaults (recommended)
    poetic.config.jsonc            # Optional advanced config
    project-context.json        # Project detection output
 telemetry/
    db/                         # Telemetry SQLite DBs (gitignored)
       variants.db
       validations.db
    invocations.db              # Cost/token tracking DB (gitignored)
    logs/                       # JSONL/log output (gitignored)
 state/                          # Runtime markers/locks (gitignored)
 worktrees/                      # Temporary worktrees (gitignored)
 .gitignore                      # Ignores runtime artifacts
 README.md                       # This file
```

## Configuration

- Preferred: edit `.poetic/config/providers.yaml` to set provider defaults (without hardcoding model versions unless you need to).
- Optional: edit `.poetic/config/poetic.config.jsonc` for advanced settings like quality gates and execution tuning.

## Useful Commands

```bash
poetic doctor
poetic doctor --fix
poetic config user get
```
