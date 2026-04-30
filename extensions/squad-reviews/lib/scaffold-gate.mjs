/**
 * Scaffold a review gate: generates reusable + caller workflow YAML files.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './review-config.mjs';

/**
 * Generate the reusable workflow YAML content.
 * @param {string[]} roles - reviewer role slugs
 * @param {object} config - loaded config (for botLogin lookups)
 * @returns {string}
 */
export function generateReusableWorkflow(roles, config = {}) {
  const rolesDefault = roles.join(',');

  // Build bot-login mapping from config if available
  const botLoginMap = {};
  for (const role of roles) {
    const reviewer = config.reviewers?.[role];
    if (reviewer?.botLogin) {
      botLoginMap[role] = reviewer.botLogin;
    }
  }

  const botLoginJson = JSON.stringify(botLoginMap);

  return `name: Squad Review Gate (Reusable)

on:
  workflow_call:
    inputs:
      roles:
        description: 'Comma-separated reviewer role slugs required for merge'
        required: false
        type: string
        default: '${rolesDefault}'
      pr_number:
        description: 'Pull request number to check'
        required: true
        type: number

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review-gate:
    name: Review Gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install squad-reviews
        run: npx --yes @sabbour/squad-reviews gate-status --help || true

      - name: Check review approvals and unresolved threads
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        uses: actions/github-script@v7
        with:
          script: |
            const roles = '\${{ inputs.roles }}'.split(',').map(r => r.trim()).filter(Boolean);
            const prNumber = \${{ inputs.pr_number }};
            const owner = context.repo.owner;
            const repo = context.repo.repo;

            // Bot login mapping from config (injected at scaffold time)
            const botLoginMap = ${botLoginJson};

            core.info(\`Checking review gate for PR #\${prNumber}\`);
            core.info(\`Required roles: \${roles.join(', ')}\`);

            // Fetch ALL reviews with pagination
            const allReviews = await github.paginate(
              github.rest.pulls.listReviews,
              { owner, repo, pull_number: prNumber, per_page: 100 }
            );

            // For each role, find the LATEST review from that role's bot
            const approvedRoles = new Set();
            const missingRoles = [];

            for (const role of roles) {
              const botLogin = botLoginMap[role] || null;

              // Filter reviews from this role's reviewer
              const roleReviews = allReviews.filter(r => {
                const login = (r.user?.login || '').toLowerCase();
                if (botLogin) return login === botLogin.toLowerCase();
                return (
                  login.includes(role.toLowerCase()) ||
                  login === \`\${role}-bot\` ||
                  login === \`squad-\${role}\`
                );
              });

              // Sort by submitted_at descending — only the latest review counts
              roleReviews.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
              const latestReview = roleReviews[0];

              if (latestReview && latestReview.state === 'APPROVED') {
                approvedRoles.add(role);
              } else {
                missingRoles.push(role);
                if (latestReview) {
                  core.info(\`Role \${role}: latest review is \${latestReview.state} (not APPROVED)\`);
                }
              }
            }

            // Check for unresolved threads
            let unresolvedCount = 0;
            try {
              const query = \`query($owner: String!, $repo: String!, $pr: Int!) {
                repository(owner: $owner, name: $repo) {
                  pullRequest(number: $pr) {
                    reviewThreads(first: 100) {
                      nodes { isResolved }
                    }
                  }
                }
              }\`;
              const result = await github.graphql(query, { owner, repo, pr: prNumber });
              const threads = result?.repository?.pullRequest?.reviewThreads?.nodes || [];
              unresolvedCount = threads.filter(t => !t.isResolved).length;
            } catch (e) {
              core.warning(\`Could not check unresolved threads: \${e.message}\`);
            }

            // Apply legacy labels for approved roles
            for (const role of approvedRoles) {
              try {
                await github.rest.issues.addLabels({
                  owner, repo, issue_number: prNumber,
                  labels: [\`\${role}:approved\`]
                });
                core.info(\`Applied label: \${role}:approved\`);
              } catch (e) {
                core.warning(\`Could not apply label \${role}:approved: \${e.message}\`);
              }
            }

            // Build summary
            let summary = '## 🔒 Review Gate Summary\\n\\n';
            summary += \`| Role | Status |\\n|------|--------|\\n\`;
            for (const role of roles) {
              const status = approvedRoles.has(role) ? '✅ Approved' : '⏳ Pending';
              summary += \`| \${role} | \${status} |\\n\`;
            }
            summary += \`\\n**Unresolved threads:** \${unresolvedCount}\\n\`;

            await core.summary.addRaw(summary).write();

            // Gate decision
            if (missingRoles.length > 0) {
              core.setFailed(\`Missing approvals from: \${missingRoles.join(', ')}\`);
            } else if (unresolvedCount > 0) {
              core.setFailed(\`\${unresolvedCount} unresolved review thread(s) must be addressed before merge\`);
            } else {
              core.info('✅ Review gate passed — all roles approved, no unresolved threads');
            }
`;
}

/**
 * Generate the caller workflow YAML content.
 * @param {string[]} roles - reviewer role slugs
 * @returns {string}
 */
export function generateCallerWorkflow(roles) {
  return `name: Review Gate

on:
  pull_request_review:
    types: [submitted, dismissed]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  gate:
    # Skip issue_comment events that aren't on PRs
    if: github.event_name != 'issue_comment' || github.event.issue.pull_request
    uses: ./.github/workflows/squad-review-gate.yml
    with:
      roles: '${roles.join(',')}'
      pr_number: \${{ github.event.pull_request.number || github.event.issue.number }}
    secrets: inherit
`;
}

/**
 * Scaffold the review gate workflows into the target repo.
 * @param {string} repoRoot - path to the repository root
 * @param {object} options
 * @param {string[]} [options.roles] - role slugs to require (defaults to all from config)
 * @param {boolean} [options.dryRun] - if true, return content without writing files
 * @returns {object} result summary
 */
export function scaffoldGate(repoRoot, { roles, dryRun = false } = {}) {
  const config = loadConfig(repoRoot);
  const configRoles = Object.keys(config.reviewers);

  const effectiveRoles = roles && roles.length > 0 ? roles : configRoles;

  // Validate that specified roles exist in config
  const invalidRoles = effectiveRoles.filter(r => !configRoles.includes(r));
  if (invalidRoles.length > 0) {
    throw new Error(
      `Unknown roles: ${invalidRoles.join(', ')}. Valid roles: ${configRoles.join(', ')}`
    );
  }

  const workflowsDir = join(repoRoot, '.github', 'workflows');
  const reusablePath = join(workflowsDir, 'squad-review-gate.yml');
  const callerPath = join(workflowsDir, 'review-gate.yml');

  const reusableContent = generateReusableWorkflow(effectiveRoles, config);
  const callerContent = generateCallerWorkflow(effectiveRoles);

  if (dryRun) {
    return {
      scaffolded: false,
      dryRun: true,
      roles: effectiveRoles,
      files: [reusablePath, callerPath],
      content: {
        [reusablePath]: reusableContent,
        [callerPath]: callerContent,
      },
    };
  }

  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(reusablePath, reusableContent, 'utf8');
  writeFileSync(callerPath, callerContent, 'utf8');

  return {
    scaffolded: true,
    roles: effectiveRoles,
    files: [reusablePath, callerPath],
    reusableWorkflow: reusablePath,
    callerWorkflow: callerPath,
    nextSteps: [
      'Commit the generated workflow files.',
      'Set the Review Gate as a required status check in branch protection.',
      'Ensure reviewer bots have write access to submit reviews.',
    ],
  };
}
