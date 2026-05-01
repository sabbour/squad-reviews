# Rose — History

## Project Context
- **Project:** squad-reviews — Copilot CLI extension for review governance
- **Stack:** TypeScript, Node.js, npm package + GitHub Actions
- **Owner:** Ahmed Sabbour
- **Test framework:** node:test (native)

## Git Identity (2026-04-30)

**Role:** `tester`  
**Bot identity:** `squad-tester[bot]`  
**Use case:** All GitHub writes (commits, PR comments, reviews) must use `squad-identity` token for this role.

## Learnings

<!-- Append entries below -->
- 2026-05-01T14:56:40.489-07:00 — Release failures can leave split state: `package.json` bumped and a Git tag present while npm still lacks that version. Validate package metadata locally and compare npm versions with remote tags before rerunning release.

### 2026-05-01T22:01:15Z (Scribe Checkpoint)
- Rose decisions merged into .squad/decisions/decisions.md
- Orchestration log written: .squad/orchestration-log/2026-05-01T22:01:15Z-rose.md
- Session log updated

### 2026-05-01T22:04:45Z (Scribe: Corrected Release Fix)
- Release workflow fix confirmed: `npx changeset publish --no-git-tag` prevents duplicate tag pushes
- Release state remains: remote tag v1.4.0 exists; GitHub release v1.4.0 missing; npm latest = 1.3.3
- Validation checkpoint: npm test -- --test-reporter=dot passed (93 tests)
- Decision recorded in .squad/decisions/decisions.md for release validation repair protocol
