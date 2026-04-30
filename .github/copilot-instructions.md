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
