---
"@sabbour/squad-reviews": patch
---

scaffold-gate: normalize `[bot]` suffix on GitHub App actor logins (backport from kickstart #315)

Per `~/GitWSL/upgrade-repro/REPORT.md`, this fix existed only in kickstart and was clobbered by
`squad-reviews setup` overwriting `scaffold-gate.mjs` with the bundled (older) template.
Backporting upstream so future upgrades preserve it.

GitHub App reviews appear in the REST API with the `[bot]` suffix (e.g. `squad-lead[bot]`), but
some surfaces — PR author attribution, commit author — drop the suffix (`squad-lead`). The
pre-fix code compared `r.user?.login.toLowerCase()` directly against `botLogin.toLowerCase()`,
which fails whenever the suffix is present on one side but not the other.

This patch adds `normalizeBotLogin(login)` inside the generated reusable-workflow script and
applies it on both sides of every bot-login comparison in the approval loop. The function strips
the `[bot]` suffix case-insensitively before comparing, making bot-login matching robust to
suffix drift across GitHub API surfaces.
