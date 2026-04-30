# @sabbour/squad-reviews

## 1.2.0

### Minor Changes

- ### Features

  - **Bypass label authority enforcement** — new `bypassLabelAuthority` config field prevents agents from self-applying bypass labels to skip reviews
  - **Generate config CLI command** — `squad-reviews generate-config` scaffolds `.squad/reviews/config.json` from squad-identity
  - **Declarative tool registration** — extension tools now surface correctly in Copilot CLI agent tool lists
  - **Review quality gate** — duplicate guard, conditional gate evaluation
  - **Config simplification** — streamlined config schema with required token field

  ### Fixes

  - Detect 404/403 on label creation and suggest auth fix
  - Proper logging for label creation phase
  - Use `gh auth token` as fallback for CLI token resolution
  - Token check is now a warning in doctor, not a failure

  ### Refactors

  - Moved `reviews/` directory to `.squad/reviews/` for consistency with squad-identity
  - Aligned branching strategy to main-only

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
