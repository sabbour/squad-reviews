---
"@sabbour/squad-reviews": patch
---

Fix path mismatch between `squad-reviews setup` and `squad-reviews doctor`. Setup installs the extension to `.github/extensions/squad-reviews/` and the skill to `.squad/skills/squad-reviews/SKILL.md`, but the doctor was looking under `.copilot/extensions/` and `.copilot/skills/` and always reported them as missing — even immediately after a successful setup. The doctor now checks the canonical project-scoped paths (and accepts the legacy `.copilot/` location too), surfaces the actual expected file path in its remediation message instead of telling users to re-run the same `setup` command in a loop, and the `setup` command now prints a clear failure/warning summary instead of `✅ setup complete` when Phase 5 health checks did not pass.
