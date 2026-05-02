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

### 2026-05-02T04:14:12-07:00 (setup/doctor path alignment)
- Root cause: `commandSetup` writes the extension to `.github/extensions/squad-reviews/` and the skill to `.squad/skills/squad-reviews/SKILL.md`, but `commandDoctor` was looking under `.copilot/extensions/squad-reviews/extension.mjs` and `.copilot/skills/squad-reviews/SKILL.md`. The two paths never agreed, so doctor's `extension` and `skill` checks always warned even on a fresh install. Worse, the warning told users to "run `squad-reviews setup`" — exactly what they had just done, an infinite loop.
- Resolution: doctor now checks the canonical project-scoped paths that setup actually writes, with a fallback that still recognises a legacy `.copilot/...` install. Remediation messages now print the concrete expected file path and suggest `setup --force` / `init` for reinstall, never an empty re-run. `commandSetup` no longer prints `✅ setup complete` when Phase 5 has any failed or warned check; it prints a `❌` or `⚠️` summary instead and exposes `ok` + `doctor` on its JSON return for tooling. Added a regression test (`setup → doctor round-trip`) that runs `setup` against a fresh workspace and asserts every doctor check is green.
