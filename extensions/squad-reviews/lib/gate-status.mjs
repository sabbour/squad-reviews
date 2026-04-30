/**
 * Gate status: check review gate status for a PR without running as CI.
 */

import { loadConfig, resolveBotLogin } from './review-config.mjs';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

function buildHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `token ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

async function paginatedGet(url, token) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, { headers: buildHeaders(token) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GET ${nextUrl} failed with ${response.status}: ${body}`);
    }
    const page = await response.json();
    items.push(...page);

    const link = response.headers.get('link');
    nextUrl = null;
    if (link) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) nextUrl = match[1];
    }
  }

  return items;
}

function matchesGlob(path, pattern) {
  const regex = new RegExp(
    '^' + pattern.replace(/\*\*/g, '@@GLOBSTAR@@')
      .replace(/\*/g, '[^/]*')
      .replace(/@@GLOBSTAR@@/g, '.*')
      .replace(/\?/g, '[^/]') + '$'
  );
  return regex.test(path);
}

function anyPathMatches(paths, patterns) {
  if (!patterns || patterns.length === 0) return false;
  return paths.some(p => patterns.some(pat => matchesGlob(p, pat)));
}

/**
 * Evaluate whether a role is required given PR context.
 */
function isRoleRequired(gateRule, prLabels, changedPaths) {
  if (!gateRule || gateRule.required === 'always') return { required: true };
  if (gateRule.required === 'optional') return { required: false, reason: 'optional' };

  // Conditional evaluation
  const normalizedLabels = prLabels.map(l => l.toLowerCase());

  // Check bypass labels
  const bypassLabels = (gateRule.bypassLabels || []).concat(gateRule.bypassWhen?.labels || []);
  if (bypassLabels.some(bl => normalizedLabels.includes(bl.toLowerCase()))) {
    // Check if required paths still trigger it
    const requiredPaths = gateRule.requiredWhen?.paths || [];
    if (requiredPaths.length > 0 && anyPathMatches(changedPaths, requiredPaths)) {
      return { required: true, reason: 'bypass label present but required paths matched' };
    }
    return { required: false, reason: 'bypass label present' };
  }

  // Check requiredWhen paths
  const requiredPaths = gateRule.requiredWhen?.paths || [];
  if (requiredPaths.length > 0) {
    if (anyPathMatches(changedPaths, requiredPaths)) {
      return { required: true, reason: 'changed files match required paths' };
    }
    return { required: false, reason: 'no changed files match required paths' };
  }

  // No conditions specified — treat as required
  return { required: true };
}

/**
 * Check the review gate status for a PR.
 * @param {string} repoRoot
 * @param {string} token
 * @param {object} opts
 * @param {number} opts.pr
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string[]} [opts.roles] - roles to check (defaults to all from config)
 * @returns {object} gate status
 */
export async function checkGateStatus(repoRoot, token, { pr, owner, repo, roles }) {
  const config = loadConfig(repoRoot);
  const configRoles = Object.keys(config.reviewers);
  const effectiveRoles = roles && roles.length > 0 ? roles : configRoles;

  // Fetch reviews, PR labels, and changed files in parallel
  const reviewsUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${pr}/reviews?per_page=100`;
  const prUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${pr}`;
  const filesUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${pr}/files?per_page=100`;

  const [allReviews, prData, changedFiles] = await Promise.all([
    paginatedGet(reviewsUrl, token),
    fetch(prUrl, { headers: buildHeaders(token) }).then(r => r.json()),
    paginatedGet(filesUrl, token),
  ]);

  const prLabels = (prData.labels || []).map(l => l.name);
  const changedPaths = changedFiles.map(f => f.filename);

  // For each role, evaluate if required and find the latest review
  const roleStatuses = [];
  const skippedRoles = [];

  for (const role of effectiveRoles) {
    const reviewer = config.reviewers[role];
    const gateRule = reviewer?.gateRule;
    const botLogin = resolveBotLogin(role, repoRoot);

    // Evaluate conditional requirements
    const requirement = isRoleRequired(gateRule, prLabels, changedPaths);
    if (!requirement.required) {
      skippedRoles.push({ role, reason: requirement.reason });
      roleStatuses.push({
        role,
        agent: reviewer?.agent || null,
        botLogin,
        approved: null,
        required: false,
        skippedReason: requirement.reason,
        latestState: null,
        latestReviewedAt: null,
        reviewerLogin: null,
      });
      continue;
    }

    // Find reviews from this role's bot
    const roleReviews = allReviews.filter(r => {
      const login = r.user?.login?.toLowerCase() || '';
      if (botLogin) {
        return login === botLogin.toLowerCase();
      }
      return (
        login.includes(role.toLowerCase()) ||
        login === `${role}-bot` ||
        login === `squad-${role}`
      );
    });

    // Find most recent review
    const latestReview = roleReviews.sort(
      (a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)
    )[0] || null;

    const approved = latestReview?.state === 'APPROVED';

    roleStatuses.push({
      role,
      agent: reviewer?.agent || null,
      botLogin,
      approved,
      required: true,
      latestState: latestReview?.state || null,
      latestReviewedAt: latestReview?.submitted_at || null,
      reviewerLogin: latestReview?.user?.login || null,
    });
  }

  // Check unresolved threads via GraphQL
  let unresolvedCount = 0;
  try {
    const graphqlUrl = 'https://api.github.com/graphql';
    const query = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes { isResolved }
            }
          }
        }
      }
    `;
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify({ query, variables: { owner, repo, pr } }),
    });
    if (response.ok) {
      const data = await response.json();
      const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
      unresolvedCount = threads.filter(t => !t.isResolved).length;
    }
  } catch {
    // Non-fatal; gate status is best-effort for threads
  }

  const requiredStatuses = roleStatuses.filter(r => r.required);
  const approvedRoles = requiredStatuses.filter(r => r.approved).map(r => r.role);
  const pendingRoles = requiredStatuses.filter(r => !r.approved).map(r => r.role);
  const passed = pendingRoles.length === 0 && unresolvedCount === 0;

  return {
    passed,
    pr,
    owner,
    repo,
    roles: roleStatuses,
    approvedRoles,
    pendingRoles,
    skippedRoles,
    unresolvedThreads: unresolvedCount,
    summary: passed
      ? '✅ Review gate passed — all roles approved, no unresolved threads'
      : pendingRoles.length > 0
        ? `⏳ Missing approvals from: ${pendingRoles.join(', ')}`
        : `⚠️ ${unresolvedCount} unresolved thread(s) blocking merge`,
  };
}
