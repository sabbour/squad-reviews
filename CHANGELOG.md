# @sabbour/squad-reviews

## 1.1.0

### Major Changes

- Full feature release: CLI alignment with squad-identity pattern, --json flag, per-role bot tokens, gateRule conditional logic, issue reviews, extension tools, and review gate governance.

  ### Features

  - `setup` command: full guided multi-phase flow (recommended entry point)
  - `init` command: file-only install (advanced)
  - `--json` global flag for structured output on human-facing commands
  - `--force` flag on setup to overwrite existing config
  - Per-role bot token resolution via squad-identity
  - `gateRule` config: always/conditional/optional per reviewer
  - Conditional gate logic: evaluates changed files + PR labels at runtime
  - Stale label clearing on synchronize event
  - Bypass labels support (`skip-docs`, `docs:not-applicable`)
  - Issue review workflow (request + execute)
  - `scaffold-gate` command with dry-run support
  - `gate-status` command to check PR gate without CI
  - `report` command for review metrics
  - `migrate` command for config schema upgrades
  - `squad_reviews_init` extension tool
  - APPROVE event support in execute-pr-review
  - Audit logging (append-only JSONL)
  - Config schema migration (1.0.0 → 1.1.0)
