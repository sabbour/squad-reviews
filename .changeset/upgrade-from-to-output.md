---
"@sabbour/squad-reviews": minor
---

Improve upgrade and doctor experience:

- `upgrade` now displays a clear `from → to` version transition and detects no-op upgrades (already on latest).
- Managed coordinator block in `.github/copilot-instructions.md` is now stamped with the installed version (`<!-- squad-reviews: start vX.Y.Z -->`), enabling drift detection.
- `setup` now injects/updates the coordinator block as a dedicated phase and reports the version transition.
- `doctor` expanded to verify all injected artifacts: copilot-instructions block, gate workflow, extension wiring, and skill pointer (warn-only — never hard-fails on a missing optional injection).
