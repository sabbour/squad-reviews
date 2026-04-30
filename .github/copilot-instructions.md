<!-- squad-identity: start -->
## GIT IDENTITY — Bot Authentication

This project uses GitHub App bot identity for all agent-authored writes.
Read `.squad/skills/squad-identity/SKILL.md` before any GitHub write.

**Use the `squad_identity_resolve_token` tool** to get a bot token for your ROLE_SLUG.

Your ROLE_SLUG is injected into your charter — look for:
```
ROLE_SLUG="<slug>"  # injected by configure-identity --update-charters
```

If absent, call `squad_identity_status` to see the full agentNameMap.

**Token usage (inline per-call, never export):**
```bash
GH_TOKEN="$TOKEN" gh pr create ...
GH_TOKEN="$TOKEN" gh api /repos/{owner}/{repo}/issues -f title="..." 
git push "https://x-access-token:${TOKEN}@github.com/{owner}/{repo}.git" HEAD
```
<!-- squad-identity: end -->

<!-- squad-reviews: start -->
## REVIEW GATE — PR Merge Requirements

This project enforces a CI review gate that blocks PR merges until:
1. All required reviewer roles have submitted a native GitHub review with `APPROVED` state.
2. All review conversation threads are resolved (no unresolved threads).

### Agent workflow before merge

1. After pushing changes, call `squad_reviews_acknowledge_feedback` to check for unresolved threads.
2. For each unresolved thread:
   - If you fixed the issue: call `squad_reviews_resolve_thread` with action `addressed` and reference the fix commit.
   - If the feedback does not apply: call `squad_reviews_resolve_thread` with action `dismissed` with a justification.
3. **Never** resolve a thread without replying first — silent dismissal is a governance failure.
4. **Never** self-approve your own PR.
5. Do not manually apply `{role}:approved` labels — the gate applies them automatically.

The gate will not pass until all threads are resolved and all required roles have approved.
<!-- squad-reviews: end -->
