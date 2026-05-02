---
'@sabbour/squad-reviews': patch
---

Two fixes:

1. **`doctor` command was silent.** It was registered as a "human" command
   (suppressing the default JSON output unless `--json` was passed) but
   never logged anything itself, so `squad-reviews doctor` exited with no
   feedback. It now prints each check with a ✓/⚠/✗ icon and a final
   pass/fail summary, matching the output style used by `setup`. `--json`
   still emits the structured result unchanged.

2. **Release workflow broke after every version bump.** The changesets bot
   bumped `package.json` but never refreshed `package-lock.json`, leaving
   the two out of sync. The `package-metadata.test.mjs` assertion then
   failed in CI on the version-packages PR merge, blocking subsequent
   releases. The `version` npm script now runs
   `changeset version && npm install --package-lock-only`, so the bot
   commits a matching lockfile alongside each version bump.
