---
"@sabbour/squad-reviews": patch
---

Fix `squad-reviews setup` installing the extension and skill to the wrong filesystem locations. Setup was writing to `.github/extensions/squad-reviews/` and `.squad/skills/squad-reviews/SKILL.md`, but the Copilot CLI discovers project-scoped extensions under `.copilot/extensions/{name}/extension.mjs` and Copilot-level skills under `.copilot/skills/{name}/SKILL.md`. As a result, the doctor (which checks the canonical paths) always reported both as missing immediately after a successful setup.

Setup now installs to the canonical `.copilot/...` paths in both `commandSetup` and `commandInit`, and removes any stale artifacts left behind at the legacy `.github/extensions/squad-reviews/` and `.squad/skills/squad-reviews/` locations (each cleanup is logged with `🧹 Removed legacy …`, never silent). The setup summary now prints `✅ squad-reviews setup complete.` only when every Phase 5 check is `ok && !warn`; otherwise it prints `⚠️ squad-reviews setup completed with N warning(s)` and exits non-zero so CI and scripts can detect partial success.
