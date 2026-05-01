# @sabbour/squad-reviews

## 1.3.3

### Patch Changes

- fix: preserve approval labels on merge-only branch updates

  The Review Gate workflow previously stripped all approval labels on every `pull_request.synchronize` event, including harmless branch catch-ups. Now uses the compare API to detect merge-only updates and preserves labels when no real code changes are pushed.

## 1.3.2

### Patch Changes

- fix(tests): align test expectations with numeric `commentId` format returned by `fetchPrThreads`
- fix(squad-identity): use tools array pattern instead of deprecated `session.registerTool()`

## 1.3.0

### Minor Changes

- d4ac6c0: Tokens are now auto-resolved internally via squad-identity's lease system. The `token` parameter has been removed from all tool schemas — tokens never appear in tool call parameters or chat UI. For tools with `roleSlug` (execute_pr_review, execute_issue_review), the token is resolved for that specific role to ensure correct bot attribution.

## 1.2.1

### Patch Changes

- f632ef8: Fix extension tool permissions and node binary resolution

  - Add `skipPermission: true` to all tool definitions to prevent "Permission denied" errors in Copilot CLI
  - Replace `process.execPath` with resolved `node` binary path — `process.execPath` returns the copilot binary in extension context, breaking child process spawns

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
