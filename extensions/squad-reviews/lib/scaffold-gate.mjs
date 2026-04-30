/**
 * Scaffold a review gate: generates reusable + caller workflow YAML files.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './review-config.mjs';

/**
 * Generate the reusable workflow YAML content.
 * @param {string[]} roles - reviewer role slugs
 * @returns {string}
 */
export function generateReusableWorkflow(roles) {
  const rolesDefault = roles.join(',');

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
        run: npm install -g @sabbour/squad-reviews

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

            core.info(\`Checking review gate for PR #\${prNumber}\`);
            core.info(\`Required roles: \${roles.join(', ')}\`);

            // Fetch all reviews on the PR
            const { data: reviews } = await github.rest.pulls.listReviews({
              owner, repo, pull_number: prNumber
            });

            // For each role, check if there's an APPROVED review
            // Reviews can come from bot accounts named after the role
            const approvedRoles = new Set();
            const missingRoles = [];

            for (const role of roles) {
              // Check for native approval from any reviewer whose login contains the role
              // or from a bot with the role name
              const hasApproval = reviews.some(r =>
                r.state === 'APPROVED' && (
                  r.user.login.toLowerCase().includes(role.toLowerCase()) ||
                  r.user.login.toLowerCase() === \`\${role}-bot\` ||
                  r.user.login.toLowerCase() === \`squad-\${role}\`
                )
              );

              if (hasApproval) {
                approvedRoles.add(role);
              } else {
                missingRoles.push(role);
              }
            }

            // Check for unresolved threads using squad-reviews CLI
            let unresolvedCount = 0;
            try {
              const { execSync } = require('child_process');
              const result = execSync(
                \`squad-reviews acknowledge-feedback --pr \${prNumber} --owner \${owner} --repo \${repo}\`,
                { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: process.env.GITHUB_TOKEN } }
              );
              const feedback = JSON.parse(result);
              unresolvedCount = feedback.unresolvedThreads?.length || 0;
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
 * @returns {object} result summary
 */
export function scaffoldGate(repoRoot, { roles } = {}) {
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
  mkdirSync(workflowsDir, { recursive: true });

  const reusablePath = join(workflowsDir, 'squad-review-gate.yml');
  const callerPath = join(workflowsDir, 'review-gate.yml');

  const reusableContent = generateReusableWorkflow(effectiveRoles);
  const callerContent = generateCallerWorkflow(effectiveRoles);

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
