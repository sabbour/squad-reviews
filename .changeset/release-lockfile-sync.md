---
'@sabbour/squad-reviews': patch
---

Fix release pipeline blocked by lockfile drift.

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
