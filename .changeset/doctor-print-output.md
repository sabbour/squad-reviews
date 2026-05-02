---
'@sabbour/squad-reviews': patch
---

Fix `squad-reviews doctor` printing nothing in human mode.

The `doctor` command was registered as a "human" command (suppressing the
default JSON output) but never logged anything itself, so `squad-reviews
doctor` exited silently with no feedback. It now prints each check with a
✓/⚠/✗ icon and a final pass/fail summary, matching the output style used
by `setup`. `--json` still emits the structured result unchanged.
