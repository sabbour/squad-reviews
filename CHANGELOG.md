# @sabbour/squad-reviews

## 1.5.3

### Patch Changes

- 19b65b5: Fix `squad-reviews doctor` looking in the wrong directories for the installed extension and skill. The doctor was checking `.copilot/extensions/squad-reviews/extension.mjs` and `.copilot/skills/squad-reviews/SKILL.md`, but `squad-reviews setup` installs to `.github/extensions/squad-reviews/` and `.squad/skills/squad-reviews/SKILL.md` — matching the org-wide convention used by `squad-identity`. As a result, every fresh install raised two `⚠` warnings whose remediation pointed users back to the same `setup` they had just run. The doctor now checks the same paths setup writes to. Also: `squad-reviews setup` now prints `✅ setup complete.` only when every Phase 5 check passes; otherwise it prints `⚠️ completed with N warning(s)` and exits non-zero so CI / scripts can detect partial success.
- b8fb919: scaffold-gate: normalize `[bot]` suffix on GitHub App actor logins (backport from kickstart #315)

  Per `~/GitWSL/upgrade-repro/REPORT.md`, this fix existed only in kickstart and was clobbered by
  `squad-reviews setup` overwriting `scaffold-gate.mjs` with the bundled (older) template.
  Backporting upstream so future upgrades preserve it.

  GitHub App reviews appear in the REST API with the `[bot]` suffix (e.g. `squad-lead[bot]`), but
  some surfaces — PR author attribution, commit author — drop the suffix (`squad-lead`). The
  pre-fix code compared `r.user?.login.toLowerCase()` directly against `botLogin.toLowerCase()`,
  which fails whenever the suffix is present on one side but not the other.

  This patch adds `normalizeBotLogin(login)` inside the generated reusable-workflow script and
  applies it on both sides of every bot-login comparison in the approval loop. The function strips
  the `[bot]` suffix case-insensitively before comparing, making bot-login matching robust to
  suffix drift across GitHub API surfaces.

## 1.5.2

### Patch Changes

- 9186e9d: Wire `npm run version` into the changesets action.

  The previous fix (1.5.1) updated the `version` npm script to refresh the
  lockfile, but `changesets/action@v1` invokes `changeset version`
  **directly** by default — it does not call `npm run version`. So the
  `version` script never ran, and Version Packages PR #18 shipped without
  a refreshed lockfile, breaking main again.

  Set `version: npm run version` on the `changesets/action@v1` step so the
  custom script (which runs `changeset version && npm install
--package-lock-only`) actually executes. Future Version Packages PRs
  will include the updated lockfile in the same commit as the package.json
  bump.

  Also refreshes `package-lock.json` from 1.5.0 → 1.5.1 to unblock current
  main.

## 1.5.1

### Patch Changes

- f5bddf9: Fix `squad-reviews doctor` printing nothing in human mode.

  The `doctor` command was registered as a "human" command (suppressing the
  default JSON output) but never logged anything itself, so `squad-reviews
doctor` exited silently with no feedback. It now prints each check with a
  ✓/⚠/✗ icon and a final pass/fail summary, matching the output style used
  by `setup`. `--json` still emits the structured result unchanged.

- 51b251f: Fix release pipeline blocked by lockfile drift.

  The `package-metadata.test.mjs` assertion requires `package.json` and
  `package-lock.json` root versions to match. The changesets bot bumps
  `package.json` via `changeset version` but does not refresh the
  lockfile, so every Version Packages PR shipped a stale lockfile and the
  next release run failed at `npm test`.

  Update the `version` npm script to run
  `changeset version && npm install --package-lock-only --no-audit --no-fund`.
  The bot will now commit a matching lockfile alongside each version bump,
  and the release pipeline will stop self-blocking after merges.

  Refresh `package-lock.json` to 1.5.0 to unblock the current main.

## 1.5.0

### Minor Changes

- 54aa58e: Improve upgrade and doctor experience:

  - `upgrade` now displays a clear `from → to` version transition and detects no-op upgrades (already on latest).
  - Managed coordinator block in `.github/copilot-instructions.md` is now stamped with the installed version (`<!-- squad-reviews: start vX.Y.Z -->`), enabling drift detection.
  - `setup` now injects/updates the coordinator block as a dedicated phase and reports the version transition.
  - `doctor` expanded to verify all injected artifacts: copilot-instructions block, gate workflow, extension wiring, and skill pointer (warn-only — never hard-fails on a missing optional injection).

## 1.4.0

### Minor Changes

- Refine review gate synchronization semantics with role-scoped approval invalidation for real content changes, approval preservation for base-sync and merge-base-only synchronize events, batched feedback response support via consolidated feedback comments, and docs gate migration to `docs:not-applicable` with no active `skip-docs` bypass guidance.

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
