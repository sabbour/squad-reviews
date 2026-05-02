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

### 2026-05-02T04:14:12-07:00 (final: doctor paths align with setup + squad-identity convention)
- Final root cause (after comparing against the sibling `squad-identity` repo, the org reference implementation): the convention is `.github/extensions/{name}/extension.mjs` for the project-scoped Copilot CLI extension and `.squad/skills/{name}/SKILL.md` for the squad's skill — for BOTH install AND doctor. `squad-reviews setup` already follows this convention. `commandDoctor` was the buggy side: it was introduced in 8a168f4 ("feat(doctor): verify all injected artifacts") and incorrectly checked `.copilot/extensions/` and `.copilot/skills/`, which is a different concept (the `.copilot/skills/` location is for the coordinator's playbook skills per `.github/agents/squad.agent.md`, not for installed extension skills).
- Fix: doctor's `extension` check now reads `.github/extensions/squad-reviews/extension.mjs`; the `skill` check now reads `.squad/skills/squad-reviews/SKILL.md`. Setup is untouched. No migration needed — users who ran setup already have their files at the correct paths.
- UX fix kept from earlier iterations: `commandSetup` only prints `✅ squad-reviews setup complete.` when every Phase 5 check is `ok && !warn`. Otherwise `⚠️  squad-reviews setup completed with N warning(s)` and `process.exitCode = 1` so CI / scripts can catch partial success. JSON return now exposes `ok` and the full `doctor` report.
- Regression test: `setup → doctor round-trip` runs `setup` then `doctor` against the same fresh workspace and asserts every doctor check is green. This is the test that would have caught 8a168f4.
- Lesson learned for future me: when two pieces of code disagree on a path, the answer is in the sibling reference implementation. Read squad-identity FIRST, not after two flip-flops. (PRs #21 and #22 both got closed because I picked the wrong side without checking the convention. Apologies to the team.)
