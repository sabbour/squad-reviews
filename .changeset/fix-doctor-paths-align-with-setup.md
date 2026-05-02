---
"@sabbour/squad-reviews": patch
---

Fix `squad-reviews doctor` looking in the wrong directories for the installed extension and skill. The doctor was checking `.copilot/extensions/squad-reviews/extension.mjs` and `.copilot/skills/squad-reviews/SKILL.md`, but `squad-reviews setup` installs to `.github/extensions/squad-reviews/` and `.squad/skills/squad-reviews/SKILL.md` — matching the org-wide convention used by `squad-identity`. As a result, every fresh install raised two `⚠` warnings whose remediation pointed users back to the same `setup` they had just run. The doctor now checks the same paths setup writes to. Also: `squad-reviews setup` now prints `✅ setup complete.` only when every Phase 5 check passes; otherwise it prints `⚠️ completed with N warning(s)` and exits non-zero so CI / scripts can detect partial success.
