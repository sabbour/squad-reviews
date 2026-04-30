---
name: "changeset-automation"
description: "Agents create changeset files for every user-visible change"
domain: "version-control"
confidence: "high"
source: "manual"
---

## Context

This project uses [changesets](https://github.com/changesets/changesets) for versioning and changelog generation. Every user-visible change needs a changeset file committed alongside the code. The CI release workflow (`squad-release.yml`) uses these files to determine version bumps and changelog entries.

**When to create a changeset:** After committing any `feat:`, `fix:`, or `refactor:` change.
**When to skip:** `docs:`, `chore:`, `test:`, `ci:`, Scribe commits, `.squad/` state changes.

## Patterns

### 1. Create the Changeset File

After your code commits, create a file at `.changeset/{kebab-case-slug}.md`:

```markdown
---
"@sabbour/squad-reviews": {bump}
---

{One-line summary of the user-visible change}
```

**Bump type:**
- `feat:` → `minor`
- `fix:` or `refactor:` → `patch`
- Breaking change (rare) → `major`

**Slug:** Derive from the change description (e.g., `add-json-flag`, `fix-role-slug-inference`). Must be unique within `.changeset/`.

**Summary:** Write for the CHANGELOG — describe what changed from the user's perspective, not implementation details.

### 2. Commit the Changeset

```bash
git add .changeset/{slug}.md
git commit -m "changeset: {brief description}"
```

### 3. One Changeset Per PR

If your PR has multiple commits, create ONE changeset summarizing the overall change. Use the highest bump type across all commits (e.g., if you have a `feat:` and a `fix:`, the changeset is `minor`).

## Examples

**Feature addition:**
```markdown
---
"@sabbour/squad-reviews": minor
---

Add --json flag for machine-readable output from all commands
```

**Bug fix:**
```markdown
---
"@sabbour/squad-reviews": patch
---

Fix role slug inference to handle more role names and fall back to slugify
```

**Multiple changes in one PR:**
```markdown
---
"@sabbour/squad-reviews": minor
---

Consolidate CLI from 12 to 7 commands and extension from 12 to 7 tools
```

## Anti-Patterns

- ❌ **Running `npx changeset` interactively** — This requires user input. Write the file directly instead.
- ❌ **Skipping changesets for user-visible changes** — CI won't publish without them.
- ❌ **Creating changesets for docs-only or chore changes** — These don't affect the published package.
- ❌ **One changeset per commit** — Create one per PR summarizing the overall change.
- ❌ **Implementation-focused summaries** — Write for users reading the CHANGELOG, not developers reading the diff.
