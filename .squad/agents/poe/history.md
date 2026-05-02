# Poe — History

## Project Context
- **Project:** squad-reviews — Copilot CLI extension for review governance
- **Stack:** TypeScript, Node.js, npm package + GitHub Actions
- **Owner:** Ahmed Sabbour
- **Dependency:** @sabbour/squad-identity for token resolution
- **Reference implementation:** github.com/sabbour/squad-identity

## Git Identity (2026-04-30)

**Role:** `backend`  
**Bot identity:** `squad-backend[bot]`  
**Use case:** All GitHub writes (commits, PR comments, reviews) must use `squad-identity` token for this role.

## Learnings

### 2026-04-29T17:26:28.335-07:00
- Scaffolded the npm package surface: `package.json`, `.changeset/config.json`, `LICENSE`, and `CHANGELOG.md`.
- Created the initial runtime and packaging directories: `bin/`, `extensions/squad-reviews/lib/`, `test/`, `reviews/`, and `squad-reviews/`.
- Mirrored the `@sabbour/squad-identity` package shape with ESM, Changesets scripts, a CLI bin entry, npm publish metadata, and a peer dependency on `@sabbour/squad-identity`.
- Updated `.gitignore` to exclude `node_modules/` and release tarballs (`*.tgz`).

<!-- Append entries below -->

### 2026-05-01T14:56:40.489-07:00
- Release workflow failures were caused by `npx changeset publish` creating and pushing a git tag after npm publish even though this repo already creates version commits/tags before the release workflow runs.
- Use `npx changeset publish --no-git-tag` in the release workflow so publishing does not try to recreate an existing `vX.Y.Z` tag.

### 2026-05-01T22:01:15Z (Scribe Checkpoint)
- Poe decisions merged into .squad/decisions/decisions.md
- Orchestration log written: .squad/orchestration-log/2026-05-01T22:01:15Z-poe.md
- Session log updated

### 2026-05-01T22:04:45Z (Scribe: Corrected Release Fix)
- Release workflow root cause clarified: `npx changeset publish` creates/pushes a git tag even when it already exists remotely
- Fix confirmed: Use `npx changeset publish --no-git-tag` in `.github/workflows/squad-release.yml` to prevent duplicate tag push
- Do not use `commitMode: github-api`; the failure is in the publish command's tag step
- Decision recorded in .squad/decisions/decisions.md and orchestration log 2026-05-01T22:04:45Z-poe-correction.md

### 2026-05-02T04:14:12-07:00 (setup install paths — canonical .copilot/ locations)
- Course-corrected after Ahmed verified the installed v1.5.2 binary: the doctor was right all along — `.copilot/extensions/{name}/extension.mjs` is the Copilot CLI's project-scoped extension discovery convention, and `.copilot/skills/{name}/SKILL.md` is the canonical location for Copilot-level skills (the coordinator's playbook). Setup was the buggy side, writing to `.github/extensions/squad-reviews/` and `.squad/skills/squad-reviews/`, which the Copilot CLI never picks up.
- Fix: both install paths in `commandSetup` and `commandInit` now point at `.copilot/extensions/squad-reviews/` and `.copilot/skills/squad-reviews/`. Factored shared install logic into `installExtensionAndSkill(packageRoot, target)` so the two callers can't drift apart again.
- Migration: the new helper detects stale legacy installs at `.github/extensions/squad-reviews/` and `.squad/skills/squad-reviews/` and removes them with a logged `🧹 Removed legacy …` line. Never silent.
- Setup-complete semantics: `✅ squad-reviews setup complete.` only when every Phase 5 check is `ok && !warn`; otherwise `⚠️  squad-reviews setup completed with N warning(s)` and `process.exitCode = 1` so CI can catch it.
- Tests: added `init migrates legacy install paths …` (planted stale files → asserts removal + canonical install) and `setup → doctor round-trip: doctor reports ok with no warnings after setup` (the regression test that would have caught v1.5.2). Strengthened the existing `init installs files` test to assert the canonical `.copilot/...` paths in the JSON return.
