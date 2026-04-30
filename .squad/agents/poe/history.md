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
