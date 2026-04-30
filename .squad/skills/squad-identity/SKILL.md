<!-- squad-identity v1.1.0 | Source: github.com/Sabbour/squad-identity -->

# Squad Identity Protocol

This skill governs how Squad agents authenticate when writing to GitHub. Every
agent-authored write (PR, comment, label, push) MUST use the project's GitHub
App bot identity — never the human operator's ambient `gh` session.

---

## Available Tools (via squad-identity extension)

**Setup/Admin Tools:**

| Tool | Purpose |
|------|---------|
| `squad_identity_setup` | Show current status and guide to full CLI setup |
| `squad_identity_doctor` | Health check (config, keys, token resolution) |
| `squad_identity_configure` | Update charters with ROLE_SLUG and refresh copilot-instructions.md |

**Agent Runtime Tools:**

| Tool | Purpose |
|------|---------|
| `squad_identity_resolve_token` | Resolve bot GitHub App token for current agent |
| `squad_identity_rotate_key` | Rotate a GitHub App private key (guided flow) |

**Governance Tools:**

| Tool | Purpose |
|------|---------|
| `squad_identity_lease_token` | Issue scoped token lease (coordinator use only) |
| `squad_identity_attest_write` | Record and verify bot-authored GitHub writes |

---

## Your Role Slug

Your `ROLE_SLUG` is injected into your charter by `--update-charters`. Look for:

```
ROLE_SLUG="<slug>"  # injected by configure-identity --update-charters; do not edit
```

**If this line is absent from your charter:**
1. Call `squad_identity_doctor` — it shows the full identity status including `agentNameMap`
2. If `config.json` is missing: call `squad_identity_configure` to infer and populate it

The mapping is stored in `.squad/identity/config.json` under `agentNameMap`.
It is inferred from `.squad/team.md` (the `| Name | Role |` table) during setup.

### GitHub Apps: custom (recommended) vs. public (future)

Your role slug corresponds to a GitHub App. We support two types:

**Custom app (recommended):** `{your-github-username}-<role>[bot]`  
User-created, dedicated apps (e.g., `alice-backend[bot]`, `myteam-frontend[bot]`). You create and own these via `squad-identity create-app --role <role>`. This is the primary path because GitHub App PEM keys belong to the app owner and cannot be shared without a central token broker service.

**Public app (future possibility):** `sqd-<role>[bot]`  
Shared, pre-made apps (e.g., `sqd-backend[bot]`, `sqd-frontend[bot]`). These would be available in the future if a token broker service is built. Not recommended for current use.

Token resolution works the same way for both: `squad_identity_resolve_token` looks up your role slug in `.squad/identity/config.json`, finds the app ID, and retrieves the PEM from the OS keychain.

---

## GIT IDENTITY Steps — Before Any GitHub Write

Follow these steps in order. Each step is a hard requirement, not advisory.

### Step A — Fail-closed environment setup

```bash
TEAM_ROOT=$(git rev-parse --show-toplevel)
ROLE_SLUG="<from your charter>"   # the injected line above

unset GH_TOKEN GITHUB_TOKEN
export GH_CONFIG_DIR="$TEAM_ROOT/.squad/runtime/gh-config/$$"
mkdir -p "$GH_CONFIG_DIR"
```

This prevents any bare `gh` call from silently falling back to the human
operator's `~/.config/gh/hosts.yml`. Use `$$` (current PID) as the directory
suffix so concurrent sessions don't share state.

### Step B — Resolve the bot token

**Option 1: Direct token (standard agents):**
```bash
TOKEN=$(squad_identity_resolve_token  roleSlug="<from your charter>")
```

**Option 1b: Direct token from CLI (non-agent use):**
```bash
TOKEN=$(squad-identity resolve-token --role backend)
```

**Option 2: Leased token (coordinator-gated agents):**
```bash
# Coordinator issues lease before spawning agent
SCOPE_ID=$(squad_identity_lease_token  role="<slug>" maxOps="5" maxTime="600")

# Agent exchanges lease for token
TOKEN=$(squad_identity_exchange_lease  scopeId="$SCOPE_ID" role="<slug>")
```

Leases are time-bound and operation-counted. After expiry or ops exhaustion,
token resolution fails — no bypass possible.

### Step C — Use the token inline (never export)

```bash
# gh CLI
GH_TOKEN="$TOKEN" gh pr create --title "..." --body "..."
GH_TOKEN="$TOKEN" gh api /repos/{owner}/{repo}/issues -f title="..."

# git push
git push "https://x-access-token:${TOKEN}@github.com/{owner}/{repo}.git" HEAD

# REST API (curl)
curl -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/{owner}/{repo}/pulls
```

Always use tokens inline per-call. **Never `export GH_TOKEN`** — it persists in
the environment and bleeds into `set -x` tracing.

### Step D — Attest the write (audit trail)

After any GitHub write (PR, comment, push, label), record it:

```bash
squad_identity_attest_write \
  owner="myorg" repo="myrepo" \
  writeType="pr-create" writeRef="42" \
  roleSlug="<from charter>" \
  expectedActor="sqd-<role>[bot]" \
  token="$TOKEN" \
  verify="true"
```

Verification queries GitHub API to confirm the actual actor matches the expected
bot identity. Mismatches are flagged in `.squad/attestation/log-YYYYMMDD.jsonl`.

---

## Key Rotation

GitHub does not provide an API to regenerate private keys — rotation is done via the GitHub UI.

**Via CLI:**
```bash
squad-identity rotate-key --role <role>
# Opens the GitHub App settings page → generate new key → download PEM

squad-identity rotate-key --role <role> --pem ~/Downloads/<app-slug>*.pem
# Imports the downloaded PEM into the OS keychain (replaces the old key)
```

**Via tool (in Copilot CLI session):**
```
squad_identity_rotate_key  role=<role>                   # Step 1: opens browser
squad_identity_rotate_key  role=<role> pemPath=<path>    # Step 2: imports PEM
```

After import:
1. Delete the old key from the GitHub App settings page
2. Delete the downloaded PEM file from your machine
3. Run `squad_identity_doctor` to verify

---

## Anti-Patterns

Each of these is a P1 governance failure:

| ❌ Anti-pattern | Why |
|----------------|-----|
| `node resolve-token.mjs --required <role>` as a bare command | Token leaks to chat/log |
| `echo "$TOKEN"` or any print of the token value | Leaks token |
| `export GH_TOKEN; gh ...` | Token persists, bleeds into `set -x` |
| A bare `gh` call without `GH_TOKEN=...` in the same subshell | Falls back to `hosts.yml` (human account) |
| Pasting `ghs_` / `ghp_` / PEM material into any output | Leaks credential |
| Re-using `GH_CONFIG_DIR` across sessions | Cross-session token contamination |
| Using `/tmp` for `GH_CONFIG_DIR` | Violates repo runtime policy |
| `tmux capture-pane`, `history`, `/proc/*/environ` reads | Environment leak vector |
| Committing PEM keys or `apps/*.json` to version control | Credential commit |

| Bypassing lease expiry with stale `scopeId` | Unbounded token lifetime |
| Exchanging lease without verifying role matches scope | Wrong role token issued |
| Skipping `squad_identity_attest_write` after GitHub operation | Audit trail gap, actor unverified |
| Manual delete of `.squad/attestation/` logs | Tampering with immutable audit trail |

---

## After a `squad upgrade`

The upgrade overwrites `.github/copilot-instructions.md` and `.github/agents/squad.agent.md`.
Your identity setup in `.squad/identity/` and `.github/extensions/` is **never touched**.

To restore the identity references:
1. Run `squad_identity_configure` tool (or `squad-identity setup` from CLI)
2. This updates both charters and copilot-instructions in one step

Everything else (config.json, extension, skill) survives automatically.

---

## Rotation on Leak

If any credential leaks (token appears in output, chat, logs, commit), treat the
private key as compromised — GitHub's scanner revocation is a safety net, not
the primary control. The App private key has no expiry.

Runbook: see "Key rotation" section in the project README.md
