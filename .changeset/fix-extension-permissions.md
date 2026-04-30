---
"@sabbour/squad-reviews": patch
---

Fix extension tool permissions and node binary resolution

- Add `skipPermission: true` to all tool definitions to prevent "Permission denied" errors in Copilot CLI
- Replace `process.execPath` with resolved `node` binary path — `process.execPath` returns the copilot binary in extension context, breaking child process spawns
