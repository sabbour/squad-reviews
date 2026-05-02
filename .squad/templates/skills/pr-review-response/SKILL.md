---
name: "pr-review-response"
description: "Teaches agents to batch PR review feedback fixes, post one consolidated update, and resolve threads traceably"
domain: "pull-requests, code-review, traceability"
confidence: "low"
source: "observed (agents fix review feedback silently — reviewers can't tell which comments were addressed)"
tools:
  - name: "github-mcp-server-pull_request_read"
    description: "Read PR review threads and comments"
    when: "Step 1 — fetching review comments to understand what needs fixing"
  - name: "gh api (REST)"
    description: "Reply to review comment threads and resolve threads via GraphQL"
    when: "Step 3 — posting reply to each comment thread after fixing"
---

## Context

When an agent fixes code in response to PR review comments (from Copilot, a human reviewer, or any GitHub reviewer), the fix alone is not enough. The reviewer needs to see — on the PR thread itself — which comments were addressed and how. Without replies, comments stay visually unresolved, reviewers must re-read the entire diff to verify fixes, and there's no traceable link between feedback and resolution.

Use this skill whenever:
- You are fixing code based on PR review feedback
- You are addressing Copilot review suggestions
- You are responding to reviewer-requested changes on a PR
- A squad member hands you review comments to resolve

## SCOPE

✅ THIS SKILL PRODUCES:
- One batched implementation pass for related feedback on a PR
- One consolidated PR update/comment with the batch commit SHA
- Concise reply comments on each review thread explaining the fix or dismissal
- Optionally resolved threads (via GraphQL when appropriate)
- Commit messages that reference the PR and review context

❌ THIS SKILL DOES NOT PRODUCE:
- The code fixes themselves (that's the agent's domain work)
- New review comments or reviews
- PR descriptions or summaries

## Patterns

### Step 1: Read the review comments

**Using MCP tools (preferred when available):**

```
github-mcp-server-pull_request_read
  method: "get_review_comments"
  owner: "{owner}"
  repo: "{repo}"
  pullNumber: {pr_number}
```

This returns review threads with metadata: `isResolved`, `isOutdated`, `isCollapsed`, and their associated comments. Each comment has an `id` you'll need for replies.

**Using gh CLI (fallback):**

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments --paginate
```

Each comment object contains `id`, `body`, `path`, `line`, and `in_reply_to_id`. Top-level comments have no `in_reply_to_id` — those are the ones you reply to.

### Step 2: Fix the code as a batch

Make the actual code changes in one implementation pass for all related actionable feedback on the PR. This is your normal domain work — the skill does not prescribe how to fix, only how to communicate the fix. Do not use one commit/push cycle per thread unless feedback items are truly unrelated and cannot be safely batched.

**Track what you changed.** For each review comment, note:
- The comment `id` (top-level, not a reply)
- The file and line referenced
- What you actually changed (brief description)
- The commit SHA after pushing (if available)

### Step 3: Commit once and post a consolidated PR update

After fixing and validating, create one feedback-fix commit where possible. Post or update one PR-level feedback summary with the batch commit SHA and the list of threads covered before replying to individual threads.

### Step 4: Skip per-thread replies for addressed feedback

When you addressed the feedback, do NOT post a per-thread reply — the consolidated PR comment from Step 3 IS the acknowledgment. Posting `Fixed in {sha}` on every thread creates notification spam and is indistinguishable from a new change request.

**Only post a thread-level reply when you are dismissing or pushing back.** Substantive pushback belongs at the line so the original reviewer sees the justification in context.

```bash
# For dismissed feedback — reply IS required (justification at the line):
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies \
  -f body="Dismissed: {justification}"
```

### Step 5: Resolve threads (optional, GraphQL only)

Thread resolution is only available via the GitHub GraphQL API. For addressed feedback, you can resolve directly after posting the consolidated PR comment in Step 3 — no per-thread reply prerequisite. For dismissals, resolve only after posting the dismissal reply.

**First, get the thread IDs** (they're different from comment IDs):

```bash
gh api graphql -f query='
  query {
    repository(owner: "{owner}", name: "{repo}") {
      pullRequest(number: {pr_number}) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes { body databaseId }
            }
          }
        }
      }
    }
  }
'
```

Match thread IDs to comment IDs using `databaseId`, then resolve:

```bash
gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "{thread_node_id}"}) {
      thread { id isResolved }
    }
  }
'
```

**When to resolve vs. leave open:**
- ✅ Resolve: You fixed exactly what was requested, no ambiguity
- ❌ Don't resolve: You pushed back, applied a different fix, or the comment needs further discussion
- ❌ Don't resolve: The reviewer is a human — let them confirm and resolve themselves

**Rule of thumb:** Agent-to-agent threads (e.g., Copilot review → agent fix) can be resolved by the fixer. Human reviewer threads should be left for the human to resolve.

### Step 6: Commit message traceability

Commit messages should reference the PR context:

```
fix: address review feedback on PR #{pr_number}

- Switched to path.dirname() for worktree path resolution (comment #18234)
- Updated error message to include file path (comment #18235)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

For single-comment fixes, a shorter format works:

```
fix: use path.dirname() for worktree consistency (PR #{pr_number} review)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## AGENT WORKFLOW (Summary)

1. **READ** — Fetch review threads using MCP tool or `gh api`
2. **FIX** — Make code changes, tracking comment ID → change mapping
3. **COMMIT** — Push one traceable feedback-fix commit referencing PR and comments where possible
4. **BATCH UPDATE** — Post/update one consolidated PR comment with the batch commit SHA
5. **REPLY (only on dismiss/pushback)** — post per-thread replies only for dismissed feedback or new concerns; addressed feedback is covered by the consolidated PR comment from step 4.
6. **RESOLVE** — (Optional) Resolve agent-to-agent threads via GraphQL
7. **STOP** — Do not skip threads, do not resolve human threads, and do not create one commit/push/comment cycle per thread

## Examples

### Example: Copilot flags a potential null dereference

**Review comment (id: 55123):**
> `squadDir` could be undefined here. Consider adding a null check.

**Agent workflow:**
1. Read the comment via `get_review_comments`
2. Add the null check in `src/cli/core/detect-squad-dir.ts`
3. Commit: `fix: add null check for squadDir (PR #99 review)`
4. Post the consolidated PR comment via `squad_reviews_post_feedback_batch` listing this thread + the fix SHA
5. Resolve the thread (Copilot → agent, safe to resolve) — no per-thread reply needed; the consolidated PR comment is the audit record

### Example: Multiple review comments on one PR

**Comments:**
- id: 55123 — "Null check needed" on `detect-squad-dir.ts:42`
- id: 55124 — "Consider using path.join()" on `detect-squad-dir.ts:58`
- id: 55125 — "This log message is too verbose" on `output.ts:15`

**Agent batches one implementation pass, then resolves threads individually:**
```bash
# Fix all three, commit
git add packages/squad-cli/src/cli/core/detect-squad-dir.ts packages/squad-cli/src/cli/core/output.ts
git commit -m "fix: address 3 review comments on PR #99

- Added null check for squadDir (comment #55123)
- Switched to path.join() for cross-platform paths (comment #55124)
- Reduced log verbosity to debug level (comment #55125)"

git push

# Post/update one PR-level batch summary, then reply to each thread individually
gh api repos/bradygaster/squad/pulls/99/comments/55123/replies \
  -f body="Fixed — added early return when squadDir is undefined"

gh api repos/bradygaster/squad/pulls/99/comments/55124/replies \
  -f body="Fixed — switched to path.join(squadDir, 'config.json') for cross-platform consistency"

gh api repos/bradygaster/squad/pulls/99/comments/55125/replies \
  -f body="Fixed — changed from console.log to debug() so it only shows with --verbose flag"
```

### Example: Handling Copilot suggestion blocks

Copilot sometimes provides `suggestion` blocks with exact code to apply:

**Review comment (id: 55130):**
````
Consider using optional chaining:
```suggestion
const name = config?.agent?.name ?? 'default';
```
````

**Reply format when applying:**
```bash
gh api repos/bradygaster/squad/pulls/99/comments/55130/replies \
  -f body="Applied suggestion — using optional chaining with nullish coalescing"
```

**Reply format when not applying:**
```bash
gh api repos/bradygaster/squad/pulls/99/comments/55130/replies \
  -f body="Not applied — config is guaranteed non-null at this point (validated on line 12). Optional chaining would mask errors."
```

### Example: Pushing back on a review comment

Not every review comment should be accepted. When a suggestion is incorrect or doesn't apply:

```bash
gh api repos/bradygaster/squad/pulls/99/comments/55140/replies \
  -f body="Considered but not applied — this file is in the zero-dependency bootstrap set (see copilot-instructions.md § Protected Files). Adding path.join() would require importing from the SDK, which breaks the bootstrap constraint."
```

Do NOT resolve the thread when pushing back. Leave it open for the reviewer to confirm.

### When to post line-level comments (rule)

Line-level comments are for **change requests and pushback only**. Acknowledgments, observations, and "Fixed in {sha}" notices belong in the consolidated PR comment — not on individual lines.

## Anti-Patterns

- ❌ **Fixing silently** — Making code changes without replying to the review thread. The reviewer has no way to know which comments were addressed.
- ❌ **One thread, one commit loop** — Fixing/pushing/commenting each thread separately creates notification noise and repeatedly invalidates approvals/rebases; batch related feedback per PR.
- ❌ **Only batch-replying "all fixed"** — A consolidated PR comment is good, but each thread still needs its own concise reply so reviewers can verify and GitHub can resolve individually.
- ❌ **Resolving without explaining** — Marking threads resolved without posting a reply first. The resolution gives no context on what was done.
- ❌ **Resolving human reviewer threads** — Only resolve threads from automated reviewers (Copilot, bots). Let human reviewers confirm and resolve their own threads.
- ❌ **Vague replies** — "Fixed" or "Done" without saying what was changed. The reply should be specific enough that the reviewer doesn't need to re-read the diff.
- ❌ **Replying before pushing** — Reply after your fix is committed and pushed, not before. The reply should reference actual committed code.
- ❌ **Ignoring comments you disagree with** — If you don't apply a suggestion, reply explaining why. Silence looks like you missed it.
- ❌ **Replying to replies** — The REST API only supports replying to top-level review comments. Attempting to reply to a reply will fail with a 404.
