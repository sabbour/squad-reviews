# Squad Decisions

## 2026-05-01

### Poe Release Job Fix

- **Date:** 2026-05-01T14:56:40.489-07:00
- **Decision:** Run the Changesets release action publish command as `npx changeset publish --no-git-tag`.
- **Reason:** This repository already has version commits and `vX.Y.Z` tags before the release workflow runs. Plain `npx changeset publish` publishes to npm and then creates/pushes the git tag, which fails when the remote tag already exists. `--no-git-tag` preserves npm publishing while preventing duplicate tag creation.
- **Commit mode:** Do not set `commitMode: github-api` for this fix; the failure is in the publish command's tag step, not the action's version-PR commit path.
- **Scope:** `.github/workflows/squad-release.yml` only; no manual GitHub release creation or npm publishing.

### Release Validation Repair

- **Date:** 2026-05-01T14:56:40.489-07:00
- **Proposed by:** Rose
- **Context:** The Release workflow failed after `changesets/action` attempted to publish `@sabbour/squad-reviews@1.4.0` and push `v1.4.0`; the push was rejected because the remote tag already exists, while npm still reports latest `1.3.3` and no `1.4.0`.
- **Decision:** Treat this as release state drift, not an application test failure. Before rerunning Release, reconcile the version/tag state by either deleting the stale `v1.4.0` tag and rerunning publish for `1.4.0`, or intentionally bumping to a new patch version with matching package metadata and publishing that version.
- **Validation:** Local validation should include `npm test`, a package metadata consistency check, `npm view @sabbour/squad-reviews versions --json`, and `git ls-remote --tags origin 'v<version>'`.
