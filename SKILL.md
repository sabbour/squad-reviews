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

For each unresolved thread, choose exactly one path:

- **Addressed** — fix the code, then resolve with action `addressed` and include the commit SHA containing the fix.
- **Dismissed** — keep the code as-is, then resolve with action `dismissed` and include a clear justification.

Do not ignore feedback from humans or the Copilot bot.

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

## 7) Anti-patterns

Avoid these failures:

- Resolving threads without replying first
- One-line reviews that do not reference the relevant charter dimension
- Self-approving: an agent reviewing its own PR
- Ignoring review feedback from humans or Copilot
- Using labels for PR reviews instead of native review events

## Quick flow

1. Request review with the target reviewer role slug.
2. Reviewer reads artifact, applies charter, and executes review.
3. Implementer acknowledges unresolved feedback.
4. Each thread is answered and resolved as either `addressed` or `dismissed`.

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
4. Never self-approve — an agent must not approve its own PR.
5. Do not manually apply `{role}:approved` labels — the gate handles this automatically.

### Scaffolding the gate

Use `squad_reviews_scaffold_gate` (or `squad-reviews scaffold-gate --roles <roles>`) to generate the workflow files. The command produces:

- `.github/workflows/squad-review-gate.yml` — reusable workflow
- `.github/workflows/review-gate.yml` — caller workflow

After scaffolding, set the Review Gate as a required status check in branch protection.
