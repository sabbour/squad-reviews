---
'@sabbour/squad-reviews': patch
---

Wire `npm run version` into the changesets action.

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
