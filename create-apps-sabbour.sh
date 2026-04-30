#!/usr/bin/env bash
# Recreate ALL squad apps on the 'sabbour' account with prefix "sqd".
# Mirrors the 10 apps on asabbour_microsoft EMU account (which use "squad-" prefix):
#
#   sqd-backend    — Squad Backend — APIs, data models, server-side logic
#   sqd-codereview — Squad Code Review — code review, quality gates
#   sqd-data       — Squad Data — data engineering, analytics, database
#   sqd-docs       — Squad Docs — documentation, technical writing
#   sqd-frontend   — Squad Frontend — UI components, styling, client-side logic
#   sqd-lead       — Squad Lead — triage, architecture, project boards
#   sqd-devops     — Squad DevOps — infrastructure, CI/CD, platform
#   sqd-scribe     — Squad Scribe — documentation, ADRs, changelogs
#   sqd-security   — Squad Security — vulnerability scanning, policy enforcement
#   sqd-tester     — Squad Tester — test plans, coverage, CI validation
#
# Each command opens a browser for OAuth approval — click "Create" for each.
# The --icon flag generates matching avatar icons.

set -euo pipefail

echo "=== Creating 10 sqd-* apps on 'sabbour' account ==="
echo "Each role will open a browser tab. Click 'Create GitHub App' for each."
echo ""

# Verify gh is authenticated as sabbour
CURRENT_USER=$(gh api user --jq .login 2>/dev/null || true)
echo "Currently authenticated as: ${CURRENT_USER:-<unknown>}"
if [[ "$CURRENT_USER" != "sabbour" ]]; then
  echo "⚠️  You're not logged in as 'sabbour'. Run: gh auth switch --user sabbour"
  echo "   Then re-run this script."
  exit 1
fi
echo ""

# All 10 roles matching the EMU apps
# Role mapping: data→squad-dataeng, devops→squad-platform, codereview→squad-codereview
ROLES=(backend codereview data docs frontend lead devops scribe security tester)

for role in "${ROLES[@]}"; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Creating: sqd-${role} (role: $role)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  squad-identity create-app --role "$role" --owner sabbour --prefix sqd --icon
  echo ""
  echo "✅ sqd-${role} created. Waiting 3s before next..."
  sleep 3
done

echo ""
echo "=== All 10 apps created! ==="
echo ""
echo "Next steps:"
echo "  1. Install apps on your repos:"
echo "     squad-identity install-apps"
echo "  2. Verify config updated with real app IDs:"
echo "     cat .squad/identity/config.json"
echo "  3. Test token-authenticated push:"
echo "     squad-identity resolve-token --role lead"
