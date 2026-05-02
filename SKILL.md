---
name: "squad-reviews"
description: "Review governance protocol for Squad agents"
domain: "review, governance, pull-requests"
confidence: "high"
---

# Squad Reviews Protocol

Use this skill when you need to request, perform, or close the loop on a review in the Squad review system.

## 1) Request a review

Ask the coordinator who should review by calling one of these tools with the reviewer's **role slug**:

- `squad_reviews_request_pr_review`
- `squad_reviews_request_issue_review`

The tool returns a structured instruction telling the coordinator which reviewer role to dispatch.

## 2) Execute a review

The reviewing agent must:

1. Read the PR diff (or the issue body for issue reviews).
2. Apply its own charter as the review rubric.
3. Write review feedback that names the charter dimension being evaluated.
4. Call:
   - `squad_reviews_execute_pr_review` for PRs
   - `squad_reviews_execute_issue_review` for issues

For PR reviews, submit both:

- the full review body
- the review event type

### Review event types

- `COMMENT` — non-blocking observations, suggestions, or follow-ups
- `REQUEST_CHANGES` — blocking issues that must be fixed before merge

Do **not** use labels to represent PR review state; use native GitHub review events.

## 3) Issue reviews

For Design Proposals, the reviewer posts a comment with the assessment and applies the label:

- `{role}:approved`

This is done via `squad_reviews_execute_issue_review`.

## 4) Acknowledge review feedback

After review feedback arrives, the implementing agent must call `squad_reviews_acknowledge_feedback` to fetch all unresolved review threads.

Batch related threads for the same PR into one implementation pass before pushing:

- fix all actionable feedback together
- validate once
- create one commit for the batch
- prefer one consolidated PR comment/update with the batch commit SHA and summary

Do **not** make one commit or push per thread; each synchronize can create notification noise and trigger repeated approval invalidation or rebases.

For each unresolved thread after the batch commit exists, choose exactly one path:

- **Addressed** — fix the code, then resolve with action `addressed` and include the commit SHA containing the fix.
- **Dismissed** — keep the code as-is, then resolve with action `dismissed` and include a clear justification.

Do not ignore feedback from humans or the Copilot bot.

After all threads are resolved, use the two-step closure rule:

1. Check the PR `reviewDecision`. If it is still `CHANGES_REQUESTED`, ping the human reviewer for re-review or dismissal. Thread resolution alone does not clear a human changes-requested decision.
2. Separately submit any required Squad role-gate approval with `squad_reviews_execute_pr_review`. Do not assume thread resolution or human dismissal satisfies Squad role gates.

## 5) Resolve threads correctly

Use `squad_reviews_resolve_thread` for every thread closure.

This operation is **indivisible**:

- it replies to the thread
- then resolves the thread through GraphQL
- and retries if the reply succeeds but the resolve step fails

**Never resolve a thread without replying first.** Silent dismissal is a governance failure.

## 6) Reviewer identity

All review posts use bot tokens from `squad-identity`.

The reviewing agent's **role slug** determines which bot identity authors the review. Reviews must be posted as the mapped Squad bot, not as the human operator.

### Token resolution for reviews

Before calling `squad_reviews_execute_pr_review` or `squad_reviews_execute_issue_review`, resolve the bot token for your role:

1. Call `squad_identity_resolve_token` with `roleSlug` set to your agent's role slug.
2. Pass the resolved token as the `token` parameter to the execute tool.

```
# Step 1: Resolve your bot token
squad_identity_resolve_token({ roleSlug: "security" })
# → returns token string

# Step 2: Execute review with that token
squad_reviews_execute_pr_review({ pr: 42, roleSlug: "security", event: "REQUEST_CHANGES", ..., token: "<resolved>" })
```

If `token` is omitted, the tool falls back to:
- `SQUAD_REVIEW_TOKEN_<ROLE>` env var (e.g., `SQUAD_REVIEW_TOKEN_SECURITY`)
- `SQUAD_REVIEW_TOKEN` env var
- `GH_TOKEN` / `GITHUB_TOKEN`

Per-role tokens ensure each review is attributed to the correct bot account (e.g., `sqd-zapp[bot]`).

## 7) Anti-patterns

Avoid these failures:

- Resolving threads without replying first
- One-line reviews that do not reference the relevant charter dimension
- Self-approving: an agent reviewing its own PR
- Ignoring review feedback from humans or Copilot
- Using labels for PR reviews instead of native review events

## 8) Review Quality Standards

All reviews are validated against quality standards before posting. Reviews that fail validation are rejected with actionable error messages.

### Standards

| Standard | Requirement |
|----------|-------------|
| **Minimum length** | 150 words minimum (excluding code blocks and citations) |
| **Citations** | Must cite specific file paths + line numbers (e.g., `src/auth.ts:45-62`) OR use inline review comments |
| **No shallow approvals** | One-liner approvals like "LGTM" or "Looks good" are rejected |
| **No approve with caveats** | If changes are needed, use `REQUEST_CHANGES` — never `APPROVE` with suggested fixes |
| **Native suggestions** | When proposing code changes, prefer GitHub's native suggestion blocks |

### Native Suggestion Format

When requesting code changes, use GitHub's native change suggestions instead of describing changes in prose:

```markdown
I found an issue at src/auth.ts:45-62. The null check is missing:

```suggestion
if (token != null) {
  return validateToken(token);
}
return null;
```
```

Native suggestions allow the PR author to apply the fix with one click.

### Inline Review Comments

Use the `comments` parameter on `squad_reviews_execute_pr_review` to attach comments directly to specific lines:

```json
{
  "comments": [
    {
      "path": "src/auth.ts",
      "line": 45,
      "body": "Missing null check:\n```suggestion\nif (token != null) {\n  return validateToken(token);\n}\n```"
    }
  ]
}
```

### Example of a Compliant Review

```
## Security Review — Trust Boundaries

Reviewed the authentication refactoring in src/auth.ts:45-62 and src/middleware.ts:12-30.

**Findings:**

1. The token validation at src/auth.ts:52 correctly uses constant-time comparison,
   preventing timing attacks on JWT signatures.

2. Session storage at src/session.ts:88-95 properly isolates per-request state.
   No cross-request leakage is possible through the middleware chain.

3. The new cache layer at src/cache.ts:8-15 bounds memory with LRU eviction.
   TTL is derived from token expiry — this prevents serving stale validations.

**Concern:** The error handler at src/middleware.ts:28 logs the full token on
auth failure. This leaks credentials to the log sink.

```suggestion
logger.warn('Auth failed', { tokenPrefix: token.slice(0, 8) });
```

Overall: REQUEST_CHANGES due to the credential leak above.
```

### Duplicate Review Guard

Reviews are idempotent. If the reviewing bot already has a review on the current HEAD commit, the tool returns `{ skipped: true }` with the existing review ID instead of posting a duplicate. This ensures safe retry behavior.

## Quick flow

1. Request review with the target reviewer role slug.
2. Reviewer reads artifact, applies charter, and executes review.
3. Implementer acknowledges unresolved feedback.
4. Each thread is answered and resolved as either `addressed` or `dismissed`.
5. Once all threads are resolved, check `reviewDecision`; if it remains `CHANGES_REQUESTED`, ping the human reviewer for re-review/dismissal.
6. Submit required Squad role-gate approval separately with `squad_reviews_execute_pr_review`.

## 8) Review Gate

A CI review gate blocks PR merges until all required reviewer roles have approved and all review threads are resolved.

### How the gate works

- The gate runs as a GitHub Actions workflow triggered on review submissions and PR events.
- For each configured role, it checks for a native GitHub review with state `APPROVED`.
- It checks that zero unresolved review threads remain on the PR.
- As a legacy side-effect, it auto-applies `{role}:approved` labels when a role has approved.

### Agent responsibilities

Before considering a PR ready to merge:

1. Call `squad_reviews_acknowledge_feedback` to list all unresolved threads.
2. For **every** unresolved thread, choose one path:
   - **Addressed** — fix the code, commit, then call `squad_reviews_resolve_thread` with action `addressed` and the fix commit SHA.
   - **Dismissed** — keep the code as-is, then call `squad_reviews_resolve_thread` with action `dismissed` and a justification.
3. Never leave threads unresolved — the gate will block the PR.
4. After all threads resolve, check `reviewDecision`; if it is still `CHANGES_REQUESTED`, ping the human reviewer for re-review/dismissal.
5. Submit required Squad role-gate approval separately with `squad_reviews_execute_pr_review`; thread resolution and human dismissal are not role-gate approvals.
6. Never self-approve — an agent must not approve its own PR.
7. Do not manually apply `{role}:approved` labels — the gate handles this automatically.
8. **Do not self-apply bypass labels** (e.g., `docs:not-applicable`). Only the role responsible for that review dimension is authorized to determine when a bypass is appropriate. The gate enforces this via `bypassLabelAuthority`.

### Bypass Label Authority

Bypass labels (e.g., `docs:not-applicable`, `skip-security`) can be restricted so only the reviewer role's bot can apply them. This prevents implementers from self-bypassing reviews.

Config example:

```json
"docs": {
  "agent": "amy",
  "gateRule": {
    "required": "conditional",
    "bypassLabels": ["docs:not-applicable"],
    "bypassLabelAuthority": "docs"
  }
}
```

With `bypassLabelAuthority: "docs"`, the gate ignores `docs:not-applicable` unless it was applied by the docs role's bot (e.g., `sqd-docs[bot]`). If any other actor applied it, the label is treated as if it doesn't exist.

### Scaffolding the gate

Use `squad_reviews_scaffold_gate` (or `squad-reviews scaffold-gate --roles <roles>`) to generate the workflow files. The command produces:

- `.github/workflows/squad-review-gate.yml` — reusable workflow
- `.github/workflows/review-gate.yml` — caller workflow

After scaffolding, set the Review Gate as a required status check in branch protection.
