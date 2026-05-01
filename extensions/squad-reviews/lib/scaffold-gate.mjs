/**
 * Scaffold a review gate: generates reusable + caller workflow YAML files.
 * The caller workflow ("Squad Review Gate") triggers on PR events and delegates
 * to the reusable workflow which contains the gate logic.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveBotLogin } from './review-config.mjs';

/**
 * Generate the reusable workflow YAML content.
 * @param {string[]} roles - reviewer role slugs
 * @param {object} config - loaded config
 * @param {string} repoRoot - repo root for identity config lookup
 * @returns {string}
 */
export function generateReusableWorkflow(roles, config = {}, repoRoot = '.') {
  const rolesDefault = roles.join(',');

  // Build role metadata — derive botLogin from squad-identity
  const botLoginMap = {};
  const gateRulesMap = {};
  for (const role of roles) {
    const reviewer = config.reviewers?.[role];
    const botLogin = resolveBotLogin(role, repoRoot);
    if (botLogin) {
      botLoginMap[role] = botLogin;
    }
    if (reviewer?.gateRule) {
      gateRulesMap[role] = reviewer.gateRule;
    }
  }

  const botLoginJson = JSON.stringify(botLoginMap);
  const gateRulesJson = JSON.stringify(gateRulesMap);

  return `name: Squad Review Gate

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
  pull_request_review:
    types: [submitted, dismissed]
  issue_comment:
    types: [created]
  pull_request:
    types: [labeled, unlabeled, opened, synchronize, reopened]

concurrency:
  group: squad-review-gate-\${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write

jobs:
  review-gate:
    name: Review Gate
    if: github.event_name != 'issue_comment' || github.event.issue.pull_request
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check review approvals and unresolved threads
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        uses: actions/github-script@v7
        with:
          script: |
            const allRoles = ('\${{ inputs.roles }}' || '${rolesDefault}').split(',').map(r => r.trim()).filter(Boolean);
            const prNumber = \${{ inputs.pr_number || 0 }} || context.payload.pull_request?.number || context.payload.issue?.number;
            const owner = context.repo.owner;
            const repo = context.repo.repo;

            // Config injected at scaffold time
            const botLoginMap = ${botLoginJson};
            const gateRules = ${gateRulesJson};

            // Helper: post commit status for the required check name
            async function postStatus(state, description) {
              const { data: prData } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
              await github.rest.repos.createCommitStatus({
                owner, repo,
                sha: prData.head.sha,
                state,
                description: \`Squad review gate: \${description}\`.slice(0, 140),
                context: 'squad/review-gate'
              });
            }

            core.info(\`Checking review gate for PR #\${prNumber}\`);

            // Fast-lane: squad:chore-auto bypasses the entire gate
            {
              const { data: prData } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
              const labels = prData.labels.map(l => l.name.toLowerCase());
              if (labels.includes('squad:chore-auto')) {
                core.info('⏭️ squad:chore-auto label detected — bypassing review gate');
                await postStatus('success', 'bypassed — squad:chore-auto');
                // Enable auto-merge on bypass
                try {
                  if (!prData.auto_merge) {
                    await github.graphql(\`mutation($prId: ID!) {
                      enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: SQUASH }) {
                        pullRequest { autoMergeRequest { enabledAt } }
                      }
                    }\`, { prId: prData.node_id });
                    core.info(\`🔀 Auto-merge enabled for PR #\${prNumber}\`);
                  }
                } catch (e) {
                  core.warning(\`Could not enable auto-merge: \${e.message}\`);
                }
                await core.summary.addRaw('## 🔒 Review Gate Summary\\n\\n⏭️ Bypassed — \`squad:chore-auto\` label present.\\n').write();
                return;
              }
            }

            // Fetch PR details (labels + changed files)
            const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
            const prLabels = pr.labels.map(l => l.name.toLowerCase());

            // Clear stale approval labels on synchronize — but only for real code pushes,
            // not merge-only branch catch-ups (e.g., update-branch API).
            if (context.eventName === 'pull_request' && context.payload.action === 'synchronize') {
              const before = context.payload.before;
              const after = context.payload.after;
              let isMergeOnly = false;

              if (before && after) {
                try {
                  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
                    owner, repo,
                    basehead: \`\${before}...\${after}\`
                  });
                  const newCommits = comparison.commits || [];
                  isMergeOnly = newCommits.length > 0 && newCommits.every(c => (c.parents || []).length > 1);
                } catch (e) {
                  core.warning(\`Could not compare commits to detect merge-only update: \${e.message}\`);
                }
              }

              if (isMergeOnly) {
                core.info('Branch update is merge-only (catch-up) — preserving approval labels');
              } else {
                core.info('New non-merge commits detected — clearing stale approval labels');
                for (const role of allRoles) {
                  const label = \`\${role}:approved\`;
                  try {
                    await github.rest.issues.removeLabel({ owner, repo, issue_number: prNumber, name: label });
                    core.info(\`Removed stale label: \${label}\`);
                  } catch (e) {
                    // Label may not exist — that's fine
                  }
                }
              }
            }

            // Fetch changed files for conditional gate rules
            const changedFiles = await github.paginate(
              github.rest.pulls.listFiles,
              { owner, repo, pull_number: prNumber, per_page: 100 }
            );
            const changedPaths = changedFiles.map(f => f.filename);

            // Determine which roles are actually required based on gate rules
            function matchesGlob(path, pattern) {
              const regex = new RegExp(
                '^' + pattern.replace(/\\*\\*/g, '@@GLOBSTAR@@')
                  .replace(/\\*/g, '[^/]*')
                  .replace(/@@GLOBSTAR@@/g, '.*')
                  .replace(/\\?/g, '[^/]') + '$'
              );
              return regex.test(path);
            }

            function anyPathMatches(paths, patterns) {
              if (!patterns || patterns.length === 0) return false;
              return paths.some(p => patterns.some(pat => matchesGlob(p, pat)));
            }

            const requiredRoles = [];
            const skippedRoles = [];

            for (const role of allRoles) {
              const rule = gateRules[role];

              if (!rule || rule.required === 'always') {
                requiredRoles.push(role);
                continue;
              }

              if (rule.required === 'optional') {
                skippedRoles.push({ role, reason: 'optional' });
                continue;
              }

              // Conditional logic
              if (rule.required === 'conditional') {
                // Check bypass labels (e.g., skip-docs, docs:not-applicable)
                const bypassLabels = rule.bypassLabels || [];
                if (bypassLabels.some(bl => prLabels.includes(bl.toLowerCase()))) {
                  skippedRoles.push({ role, reason: \`bypass label present\` });
                  continue;
                }

                // Check bypassWhen.labels (e.g., squad:chore-auto)
                const bypassWhenLabels = rule.bypassWhen?.labels || [];
                const hasBypassLabel = bypassWhenLabels.some(bl => prLabels.includes(bl.toLowerCase()));

                // Check requiredWhen.paths
                const requiredPaths = rule.requiredWhen?.paths || [];
                const hasRequiredPaths = anyPathMatches(changedPaths, requiredPaths);

                if (hasBypassLabel && !hasRequiredPaths) {
                  skippedRoles.push({ role, reason: \`bypass label + no matching paths\` });
                  continue;
                }

                if (requiredPaths.length > 0 && !hasRequiredPaths) {
                  skippedRoles.push({ role, reason: \`no files match requiredWhen paths\` });
                  continue;
                }

                requiredRoles.push(role);
              }
            }

            core.info(\`Required roles: \${requiredRoles.join(', ') || '(none)'}\`);
            for (const { role, reason } of skippedRoles) {
              core.info(\`Skipped role \${role}: \${reason}\`);
            }

            // Fetch ALL reviews with pagination
            const allReviews = await github.paginate(
              github.rest.pulls.listReviews,
              { owner, repo, pull_number: prNumber, per_page: 100 }
            );

            // For each required role, find the LATEST review
            const approvedRoles = new Set();
            const missingRoles = [];

            for (const role of requiredRoles) {
              const botLogin = botLoginMap[role] || null;

              const roleReviews = allReviews.filter(r => {
                const login = (r.user?.login || '').toLowerCase();
                if (botLogin) return login === botLogin.toLowerCase();
                return (
                  login.includes(role.toLowerCase()) ||
                  login === \`\${role}-bot\` ||
                  login === \`squad-\${role}\`
                );
              });

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
              } catch (e) {
                core.warning(\`Could not apply label \${role}:approved: \${e.message}\`);
              }
            }

            // Build summary
            let summary = '## 🔒 Review Gate Summary\\n\\n';
            summary += \`| Role | Status | Rule |\\n|------|--------|------|\\n\`;
            for (const role of requiredRoles) {
              const status = approvedRoles.has(role) ? '✅ Approved' : '⏳ Pending';
              const rule = gateRules[role]?.required || 'always';
              summary += \`| \${role} | \${status} | \${rule} |\\n\`;
            }
            for (const { role, reason } of skippedRoles) {
              summary += \`| \${role} | ⏭️ Skipped | \${reason} |\\n\`;
            }
            summary += \`\\n**Unresolved threads:** \${unresolvedCount}\\n\`;

            await core.summary.addRaw(summary).write();

            // Gate decision
            if (missingRoles.length > 0) {
              await postStatus('pending', \`waiting: \${missingRoles.join(', ')}\`);
              core.setFailed(\`Missing approvals from: \${missingRoles.join(', ')}\`);
            } else if (unresolvedCount > 0) {
              await postStatus('pending', \`\${unresolvedCount} unresolved thread(s)\`);
              core.setFailed(\`\${unresolvedCount} unresolved review thread(s) must be addressed before merge\`);
            } else {
              await postStatus('success', 'all roles approved, no unresolved threads');
              core.info('✅ Review gate passed — all roles approved, no unresolved threads');

              // Enable auto-merge (squash) when gate passes
              try {
                const { data: prData } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
                if (!prData.auto_merge) {
                  const prNodeId = prData.node_id;
                  await github.graphql(\`mutation($prId: ID!) {
                    enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: SQUASH }) {
                      pullRequest { autoMergeRequest { enabledAt } }
                    }
                  }\`, { prId: prNodeId });
                  core.info(\`🔀 Auto-merge enabled for PR #\${prNumber}\`);
                } else {
                  core.info(\`Auto-merge already enabled for PR #\${prNumber}\`);
                }
              } catch (e) {
                core.warning(\`Could not enable auto-merge: \${e.message}\`);
              }
            }
`;
}

/**
 * Generate the caller workflow YAML content.
 * @param {string[]} roles - reviewer role slugs
 * @returns {string}
 */
export function generateCallerWorkflow(roles) {
  return `name: Squad Review Gate

on:
  pull_request_review:
    types: [submitted, dismissed]
  issue_comment:
    types: [created]
  pull_request:
    types: [labeled, unlabeled, opened, synchronize, reopened]

concurrency:
  group: squad-review-gate-\${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true

jobs:
  gate:
    name: Review Gate
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

  const reusableContent = generateReusableWorkflow(effectiveRoles, config, repoRoot);
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
      'Set squad/review-gate as a required status check in branch protection.',
      'Ensure reviewer bots have write access to submit reviews.',
    ],
  };
}
