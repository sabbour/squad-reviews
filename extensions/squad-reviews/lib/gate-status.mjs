/**
 * Gate status: check review gate status for a PR without running as CI.
 */

import { loadConfig } from './review-config.mjs';

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

  // Fetch all reviews with pagination
  const reviewsUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${pr}/reviews?per_page=100`;
  const allReviews = await paginatedGet(reviewsUrl, token);

  // For each role, find the latest review from that role's bot
  const roleStatuses = [];

  for (const role of effectiveRoles) {
    const reviewer = config.reviewers[role];
    const botLogin = reviewer?.botLogin || null;

    // Find reviews from this role's bot — match on botLogin if configured,
    // otherwise fall back to heuristic matching
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

    // Find most recent review (latest submitted_at)
    const latestReview = roleReviews.sort(
      (a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)
    )[0] || null;

    const approved = latestReview?.state === 'APPROVED';

    roleStatuses.push({
      role,
      agent: reviewer?.agent || null,
      botLogin,
      approved,
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

  const approvedRoles = roleStatuses.filter(r => r.approved).map(r => r.role);
  const pendingRoles = roleStatuses.filter(r => !r.approved).map(r => r.role);
  const passed = pendingRoles.length === 0 && unresolvedCount === 0;

  return {
    passed,
    pr,
    owner,
    repo,
    roles: roleStatuses,
    approvedRoles,
    pendingRoles,
    unresolvedThreads: unresolvedCount,
    summary: passed
      ? '✅ Review gate passed — all roles approved, no unresolved threads'
      : pendingRoles.length > 0
        ? `⏳ Missing approvals from: ${pendingRoles.join(', ')}`
        : `⚠️ ${unresolvedCount} unresolved thread(s) blocking merge`,
  };
}
