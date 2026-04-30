# @sabbour/squad-reviews

[![npm version](https://img.shields.io/npm/v/%40sabbour%2Fsquad-reviews)](https://www.npmjs.com/package/@sabbour/squad-reviews)
[![CI](https://github.com/sabbour/squad-reviews/actions/workflows/squad-ci.yml/badge.svg)](https://github.com/sabbour/squad-reviews/actions/workflows/squad-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> [!WARNING]
> **Experimental** — This project is under active development. APIs, config schemas, and CLI commands may change without notice.

> Config-driven review governance for [Squad](https://github.com/bradygaster/squad) agents — PRs, issues, review threads, and reviewer routing.

## Why

Without `squad-reviews`, review governance is ad-hoc: agents don't know who reviews what, feedback threads get lost, and there's no enforced reply-before-resolve discipline. With a config-driven review system:

- Every PR and issue is routed to the right reviewer **by role**
- Feedback must be explicitly **addressed** or **dismissed** — no silent closes
- A CI gate blocks merges until all required roles have approved via **native GitHub reviews**
- Conditional requirements skip roles when they're not relevant (bypass labels, file-path triggers)
- The full review lifecycle is traceable through an append-only audit log

---

## Prerequisites

| Requirement | Check |
|-------------|-------|
| [Squad](https://github.com/bradygaster/squad) installed and initialized | `.squad/team.md` exists |
| Node.js ≥ 18 | `node --version` |
| [`@sabbour/squad-identity`](https://www.npmjs.com/package/@sabbour/squad-identity) installed and configured | `squad-identity doctor` |
| GitHub token | `SQUAD_REVIEW_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` available |

---

## Quick start

### Step 0: Squad + squad-identity

[Squad](https://github.com/bradygaster/squad) must be initialized in your repo. Each
reviewer agent needs a bot identity provisioned by `squad-identity`:

```bash
npm install -g @bradygaster/squad-cli @sabbour/squad-identity
cd /path/to/your-project
squad init
squad-identity setup
```

### Step 1: Install and setup

```bash
npm install -g @sabbour/squad-reviews

# Full guided setup (recommended): installs files, creates config, scaffolds gate, runs doctor
squad-reviews setup
```

Or install locally per-project:

```bash
npm install @sabbour/squad-reviews
npx squad-reviews setup
```

For advanced use, `init` installs files only without the guided flow:

```bash
squad-reviews init
```

### Step 2: Configure reviewers

Edit `.squad/reviews/config.json` and map each role slug to your team's reviewer agent:

```json
{
  "schemaVersion": "1.1.0",
  "reviewers": {
    "codereview": {
      "agent": "nibbler",
      "dimension": "Code quality, correctness, test coverage",
      "charterPath": ".squad/agents/nibbler/charter.md",
      "gateRule": { "required": "always" }
    },
    "security": {
      "agent": "zapp",
      "dimension": "Security surface, injection, auth, trust boundaries",
      "charterPath": ".squad/agents/zapp/charter.md",
      "gateRule": {
        "required": "conditional",
        "bypassWhen": { "labels": ["squad:chore-auto"] },
        "requiredWhen": { "paths": [".github/workflows/**", "**/auth/**"] }
      }
    },
    "docs": {
      "agent": "amy",
      "dimension": "Documentation completeness, changeset quality",
      "charterPath": ".squad/agents/amy/charter.md",
      "gateRule": {
        "required": "conditional",
        "requiredWhen": { "paths": ["packages/*/src/**", "src/**"] },
        "bypassLabels": ["skip-docs", "docs:not-applicable"]
      }
    }
  },
  "threadResolution": {
    "requireReplyBeforeResolve": true,
    "templates": {
      "addressed": "Addressed in {sha}: {description}",
      "dismissed": "Dismissed: {justification}"
    }
  },
  "feedbackSources": ["squad-agents", "humans", "github-copilot-bot"]
}
```

### Step 3: Scaffold the review gate

```bash
squad-reviews scaffold-gate
```

Commit the generated workflows, then add **Review Gate** as a required status check in your branch protection rules.

### Step 4: Validate

```bash
squad-reviews status   # show config and registered roles
squad-reviews doctor   # run health checks
```

---

## How it works

```mermaid
flowchart LR
    A[Request] -->|Route PR/issue to reviewer role| B[Execute]
    B -->|Reviewer posts native GitHub review| C[Acknowledge]
    C -->|Implementer fetches unresolved threads| D[Resolve]
    D -->|Reply + resolve as addressed/dismissed| A
```

1. **Request** — route a PR or issue to a configured reviewer role.
2. **Execute** — the reviewer reads the artifact using its charter and posts a native GitHub review (`COMMENT`, `REQUEST_CHANGES`, or `APPROVE`).
3. **Acknowledge** — the implementer fetches unresolved feedback threads.
4. **Resolve** — each thread is replied to and resolved. The reply-before-resolve guard ensures no thread is silently dismissed.

For PRs, the canonical approval signal is a native GitHub review with state `APPROVED`. For issues (design proposals), approval is represented by the `{role}:approved` label.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `squad-reviews setup [target-repo] [--force]` | Full guided setup (recommended) |
| `squad-reviews init [target-repo]` | Install files only (advanced) |
| `squad-reviews generate-config [--roles r1,r2] [--force]` | Generate `.squad/reviews/config.json` from squad-identity |
| `squad-reviews status` | Show current config and registered reviewers |
| `squad-reviews doctor` | Run health checks (config, identity, labels, GitHub setup) |
| `squad-reviews scaffold-gate [--roles r1,r2] [--dry-run]` | Generate review gate CI workflows |
| `squad-reviews gate-status --pr N [--owner O --repo R]` | Check gate status for a PR |
| `squad-reviews report --pr N [--owner O --repo R]` | Full review report for a PR |
| `squad-reviews request-pr-review --pr N --reviewer ROLE` | Route PR to reviewer |
| `squad-reviews execute-pr-review --pr N --role ROLE --event EVENT [--body TEXT]` | Post PR review |
| `squad-reviews acknowledge-feedback --pr N` | List unresolved threads |
| `squad-reviews resolve-thread --pr N --thread ID --comment ID --reply TEXT --action ACTION` | Resolve thread |
| `squad-reviews request-issue-review --issue N --reviewer ROLE` | Route issue to reviewer |
| `squad-reviews execute-issue-review --issue N --role ROLE [--approved] [--body TEXT]` | Post issue review |

All commands accept `--owner` and `--repo` overrides. Run `squad-reviews <command> --help` for full usage.

**`--json` flag:** Human-facing commands (`setup`, `init`, `doctor`) print progress to stderr and only emit JSON to stdout when `--json` is passed. Machine commands (`gate-status`, `report`, etc.) always emit JSON.

---

## Extension Tools

These tools are available to Copilot CLI agents when the extension is installed:

| Tool | Description |
|------|-------------|
| `squad_reviews_request_pr_review` | Request a PR review from a configured reviewer role |
| `squad_reviews_execute_pr_review` | Execute a PR review (COMMENT, REQUEST_CHANGES, or APPROVE) |
| `squad_reviews_acknowledge_feedback` | List unresolved PR review threads |
| `squad_reviews_resolve_thread` | Reply to and resolve a PR review thread |
| `squad_reviews_request_issue_review` | Request an issue review from a reviewer role |
| `squad_reviews_execute_issue_review` | Execute an issue review (optionally approve) |
| `squad_reviews_gate_status` | Check gate status for a PR without CI |
| `squad_reviews_status` | Show config and registered reviewers |
| `squad_reviews_doctor` | Run health checks |
| `squad_reviews_setup` | Create config from template (use `--force` to overwrite) |
| `squad_reviews_init` | Install extension files, SKILL.md, and template into target repo |
| `squad_reviews_scaffold_gate` | Scaffold review gate CI workflows |
| `squad_reviews_generate_config` | Generate config scaffold from squad-identity |
| `squad_reviews_dispatch_review` | **(Coordinator)** Assign a role to review a PR (label + comment) |
| `squad_reviews_blocked_prs` | **(Coordinator)** List PRs blocked on pending reviews |
| `squad_reviews_pending_reviews` | **(Coordinator)** Show which roles still need to approve a PR |

---

## Configuration Reference

`.squad/reviews/config.json` is the single source of truth for review governance.

### `schemaVersion`

Currently requires `"1.1.0"`. Bot login is derived automatically from `squad-identity` configuration.

### `reviewers`

Non-empty object keyed by role slug (e.g., `codereview`, `security`, `docs`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | ✅ | Squad agent name that owns the review |
| `dimension` | string | ✅ | Human-readable review scope |
| `charterPath` | string | ✅ | Repo-local charter file used as review rubric |
| `gateRule` | object | ❌ | Gate requirement configuration (see below) |

### `gateRule`

Controls whether a reviewer role is required for merge:

| Field | Type | Description |
|-------|------|-------------|
| `required` | `"always"` \| `"conditional"` \| `"optional"` | Requirement level |
| `bypassWhen.labels` | string[] | Skip this role if PR has any of these labels |
| `requiredWhen.paths` | string[] | Only require if changed files match these globs |
| `bypassLabels` | string[] | Shorthand bypass labels (e.g., `["skip-docs"]`) |
| `bypassLabelAuthority` | string | Role slug whose bot is authorized to apply bypass labels. If set, bypass labels applied by other actors are ignored. |

**Evaluation logic for `conditional` roles:**

1. If any `bypassLabels` match the PR → **skip**
2. If any `bypassWhen.labels` match the PR AND no `requiredWhen.paths` match changed files → **skip**
3. If `requiredWhen.paths` is set and no changed files match → **skip**
4. Otherwise → **required**

### `threadResolution`

| Field | Type | Description |
|-------|------|-------------|
| `requireReplyBeforeResolve` | boolean | If true, threads cannot be resolved without a reply |
| `templates.addressed` | string | Reply template for fixed feedback; supports `{sha}` and `{description}` |
| `templates.dismissed` | string | Reply template for dismissed feedback; supports `{justification}` |

### `feedbackSources`

Array of allowed feedback source identifiers: `"squad-agents"`, `"humans"`, `"github-copilot-bot"`.

---

## Review Gate

The review gate is a CI workflow that blocks PR merges until governance requirements are met.

### Scaffold the gate

```bash
squad-reviews scaffold-gate --roles codereview,security,docs
```

Generates:
- `.github/workflows/squad-review-gate.yml` — reusable workflow (gate logic)
- `.github/workflows/review-gate.yml` — caller workflow (triggers on PR events)

Use `--dry-run` to preview without writing files.

### What the gate checks

1. **Native GitHub reviews** — each required role must have a review with state `APPROVED` (the latest review per reviewer is used)
2. **Unresolved threads** — zero unresolved review conversation threads must remain
3. **Legacy labels** — `{role}:approved` labels are auto-applied as a side-effect for compatibility

### Conditional requirements

Roles with `gateRule.required: "conditional"` are evaluated at runtime:

```mermaid
flowchart TD
    Start[PR event triggers gate] --> CheckRole{For each role}
    CheckRole --> Always[required: always] --> MustApprove[Require approval]
    CheckRole --> Optional[required: optional] --> Skip[Skip — not required]
    CheckRole --> Conditional[required: conditional]
    Conditional --> BypassLabel{PR has bypass label?}
    BypassLabel -->|Yes| Skip
    BypassLabel -->|No| PathCheck{requiredWhen.paths match changed files?}
    PathCheck -->|Yes| MustApprove
    PathCheck -->|No paths configured| MustApprove
    PathCheck -->|No match| Skip
```

- The gate fetches changed files and PR labels
- If `requiredWhen.paths` is configured, the role is only required when changed files match those globs
- If `bypassWhen.labels` or `bypassLabels` match a PR label, the role is skipped

**Example:** The `docs` role is only required when `src/**` changes, and can be bypassed with the `skip-docs` label.

### Bypass labels

Add bypass labels to skip conditional roles:

```json
"gateRule": {
  "required": "conditional",
  "bypassLabels": ["skip-docs", "docs:not-applicable"]
}
```

When the PR has any listed label, the role is skipped and the gate passes without that role's approval.

### Stale approval clearing

When new commits are pushed to a PR (`synchronize` event), **all `{role}:approved` labels are automatically removed**. This ensures prior approvals are invalidated when code changes, forcing a fresh review cycle.

### Setup after scaffolding

1. Commit the generated workflow files
2. In branch protection settings, add **Review Gate** as a required status check
3. Ensure reviewer bots have write access to submit reviews on the repository

---

## Issue Reviews (Design Proposals)

For design proposals that live as GitHub issues, `squad-reviews` supports the same review lifecycle:

```bash
# Route a design proposal to a reviewer
squad-reviews request-issue-review --issue 29 --reviewer architecture

# Reviewer posts structured feedback and optionally approves
squad-reviews execute-issue-review --issue 29 --role architecture --approved --body "Architecture LGTM"
```

Approval is signaled by the `{role}:approved` label on the issue. This supports the "review proposal before code" workflow where design decisions are reviewed at the issue level before implementation begins.

---

## Integration with `@sabbour/squad-identity`

`@sabbour/squad-reviews` depends on `@sabbour/squad-identity` as an optional peer because review execution needs a bot identity and token source:

```mermaid
sequenceDiagram
    participant Agent
    participant squad-identity
    participant squad-reviews
    participant GitHub

    Agent->>squad-identity: resolve_token(role: "security")
    squad-identity-->>Agent: installation token for sqd-zapp[bot]
    Agent->>squad-reviews: execute_pr_review(pr, token, event: APPROVE)
    squad-reviews->>GitHub: POST review as sqd-zapp[bot]
    GitHub-->>squad-reviews: review created
    squad-reviews-->>Agent: { submitted: true }
```

### Per-role token resolution

The execute tools (`squad_reviews_execute_pr_review`, `squad_reviews_execute_issue_review`) accept an optional `token` parameter. The intended workflow for agents:

```
1. Call squad_identity_resolve_token({ roleSlug: "security" })
   → returns the installation token for sqd-zapp[bot]

2. Call squad_reviews_execute_pr_review({ ..., token: "<resolved token>" })
   → posts the review as sqd-zapp[bot]
```

This ensures each review is attributed to the correct bot account without squad-reviews needing to access squad-identity internals.

### Token fallback order

**Extension tools** require an explicit `token` parameter — agents must call `squad_identity_resolve_token` first.

**CLI commands** use an env-var fallback chain (for CI/scripting):

1. `SQUAD_REVIEW_TOKEN_<ROLE>` (e.g., `SQUAD_REVIEW_TOKEN_SECURITY`)
2. `SQUAD_REVIEW_TOKEN`
3. `GH_TOKEN`
4. `GITHUB_TOKEN`

Install and configure identity first. Bot login for each reviewer role is derived automatically from the `squad-identity` config (via `apps[role].appSlug`).

> **Note:** GitHub does not support requesting native reviews from bot accounts — only org members and teams can be requested as reviewers. The review-dispatch mechanism uses labels and comments instead.

---

## Review Quality Gate

Reviews are validated against quality standards before posting. If a review fails validation, it is rejected with actionable error messages — no review is posted to GitHub.

| Standard | Requirement |
|----------|-------------|
| Minimum length | 150 words (excluding code blocks) |
| Citations | Must cite `file:line` references or use inline comments |
| No shallow approvals | "LGTM", "Looks good", etc. are rejected |
| No approve with caveats | Use `REQUEST_CHANGES` if changes are needed |

### Native Change Suggestions

When requesting code changes, prefer GitHub's native suggestion blocks:

```markdown
```suggestion
if (token != null) {
  return validateToken(token);
}
```
```

Pass inline comments via the `comments` array on `squad_reviews_execute_pr_review`:

```json
{
  "comments": [{ "path": "src/auth.ts", "line": 45, "body": "```suggestion\n...\n```" }]
}
```

### Idempotent Reviews (Duplicate Guard)

If the reviewer bot already has a review on the current HEAD commit, re-executing returns `{ skipped: true, existingReviewId }` instead of posting a duplicate. This ensures safe retry behavior.

---

## Audit Log

Every review action is appended to `.squad/reviews/audit.jsonl` — an append-only log that records:

- Review requests, executions, and approvals
- Thread resolutions (addressed/dismissed)
- Timestamps, actors, and artifact references

This enables compliance auditing without external tooling. The file is auto-created on first write.

---

## Development

```bash
npm install
npm test          # runs all tests (Node.js test runner)
npm run lint      # ESLint
```

### Project structure

```mermaid
graph TD
    CLI[bin/squad-reviews.mjs<br/>CLI entrypoint] --> Config[lib/review-config.mjs<br/>Config loading & validation]
    CLI --> Gate[lib/scaffold-gate.mjs<br/>Gate workflow generation]
    CLI --> Status[lib/gate-status.mjs<br/>Gate status checking]
    CLI --> Token[lib/resolve-role-token.mjs<br/>Per-role token resolution]

    Ext[extension.mjs<br/>Copilot CLI extension] --> Config
    Ext --> Gate
    Ext --> Status
    Ext --> Exec[lib/execute-review.mjs<br/>PR/Issue review execution]
    Ext --> Resolve[lib/resolve-thread.mjs<br/>Thread resolution]
    Ext --> Audit[lib/audit-log.mjs<br/>Append-only JSONL audit]

    Exec --> Audit
    Resolve --> Audit
```

```
bin/                     CLI entrypoint
extensions/squad-reviews/
  extension.mjs          Copilot CLI extension (tool registrations)
  lib/
    review-config.mjs    Config loading, validation, bot-login derivation
    scaffold-gate.mjs    Gate workflow generation
    gate-status.mjs      Gate status checking
    execute-review.mjs   PR review execution
    resolve-thread.mjs   Thread resolution
    audit-log.mjs        Append-only audit logging
.squad/reviews/
  config.json.template   Config template for new repos
test/                    Test suites (Node.js test runner)
```

---

## License

MIT
