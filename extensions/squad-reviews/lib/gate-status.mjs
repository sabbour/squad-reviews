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

function anyLabelMatches(labels, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const normalized = labels.map(l => l.toLowerCase());
  return normalized.some(label => patterns.some(pat => label === pat.toLowerCase()));
}

const DOCS_LIKE_RE = /(\.mdx?$)|^docs\/|^docs-site\/|^\.squad\/|^\.changeset\//i;
const DEFAULT_SENSITIVE_PATHS = ['.github/workflows/**', '**/auth/**', '**/security/**', '**/guardrail/**', '**/guardrails/**'];

/**
 * Evaluate whether a role is required given PR context.
 * @param {object} gateRule - The role's gateRule config
 * @param {string[]} prLabels - Labels currently on the PR
 * @param {string[]} changedPaths - Changed file paths
 * @param {object} [labelAuthority] - Map of label name → actor login who applied it
 * @param {string[]} [authorizedActors] - Bot logins authorized to apply bypass labels for this role
 */
export function isRoleRequired(gateRule, prLabels, changedPaths, labelAuthority, authorizedActors) {
  if (!gateRule || gateRule.required === 'always') return { required: true };
  if (gateRule.required === 'optional') return { required: false, reason: 'optional' };

  // Conditional evaluation
  const normalizedLabels = prLabels.map(l => l.toLowerCase());

  if (gateRule.hardBlockLabel && normalizedLabels.includes(gateRule.hardBlockLabel.toLowerCase())) {
    return { required: true, blocked: true, reason: `hard block label present: ${gateRule.hardBlockLabel}` };
  }

  const bypassWhen = gateRule.bypassWhen || {};
  const isDocsOnly = changedPaths.length > 0 && changedPaths.every(p => DOCS_LIKE_RE.test(p));
  const hasArchitectureLabel = normalizedLabels.includes('architecture');
  const sensitivePaths = gateRule.sensitivePaths || DEFAULT_SENSITIVE_PATHS;
  const hasSensitivePath = anyPathMatches(changedPaths, sensitivePaths);
  const docsOnlyWaives =
    bypassWhen.docsOnly === true && isDocsOnly &&
    (bypassWhen.noArchitectureLabel !== true || !hasArchitectureLabel) &&
    (bypassWhen.noSensitivePaths !== true || !hasSensitivePath);
  if (docsOnlyWaives) {
    return { required: false, reason: 'docs-only PR; no sensitive paths or architecture label' };
  }

  // Check bypass labels
  const bypassLabels = (gateRule.bypassLabels || []).concat(bypassWhen.labels || []);
  const matchingBypass = bypassLabels.filter(bl => normalizedLabels.includes(bl.toLowerCase()));

  if (matchingBypass.length > 0) {
    // If authority enforcement is enabled, verify who applied the label
    if (authorizedActors && authorizedActors.length > 0 && labelAuthority) {
      const authorizedLower = authorizedActors.map(a => a.toLowerCase());
      const authorizedMatch = matchingBypass.some(bl => {
        const appliedBy = labelAuthority[bl.toLowerCase()];
        return appliedBy && authorizedLower.includes(appliedBy.toLowerCase());
      });

      if (!authorizedMatch) {
        // Bypass label present but applied by unauthorized actor — ignore it
        return { required: true, reason: 'bypass label applied by unauthorized actor' };
      }
    }

    // Check if required paths still trigger it
    const requiredPaths = gateRule.requiredWhen?.paths || [];
    if (requiredPaths.length > 0 && anyPathMatches(changedPaths, requiredPaths)) {
      return { required: true, reason: 'bypass label present but required paths matched' };
    }
    return { required: false, reason: 'bypass label present' };
  }

  // Check requiredWhen labels and paths
  const requiredLabels = gateRule.requiredWhen?.labels || [];
  if (requiredLabels.length > 0 && anyLabelMatches(normalizedLabels, requiredLabels)) {
    return { required: true, reason: 'labels match required labels' };
  }

  const requiredPaths = gateRule.requiredWhen?.paths || [];
  if (requiredPaths.length > 0) {
    if (anyPathMatches(changedPaths, requiredPaths)) {
      return { required: true, reason: 'changed files match required paths' };
    }
    return { required: false, reason: 'no changed files or labels match requiredWhen' };
  }

  if (requiredLabels.length > 0) {
    return { required: false, reason: 'no changed files or labels match requiredWhen' };
  }

  // No conditions specified — treat as required
  return { required: true };
}

/**
 * Fetch label events for an issue/PR to determine who applied each label.
 * Returns a map of label name (lowercase) → actor login.
 */
async function fetchLabelAuthority(owner, repo, issueNumber, token) {
  const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/issues/${issueNumber}/events?per_page=100`;
  try {
    const events = await paginatedGet(url, token);
    const labelMap = {};

    for (const event of events) {
      if (event.event === 'labeled' && event.label?.name) {
        // Last actor to apply the label wins (in case of remove + re-apply)
        labelMap[event.label.name.toLowerCase()] = event.actor?.login || null;
      } else if (event.event === 'unlabeled' && event.label?.name) {
        delete labelMap[event.label.name.toLowerCase()];
      }
    }

    return labelMap;
  } catch {
    // If we can't fetch events, skip authority check gracefully
    return null;
  }
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

  // Check if any role has bypassLabelAuthority — only fetch events if needed
  const needsAuthorityCheck = effectiveRoles.some(role => {
    const gateRule = config.reviewers[role]?.gateRule;
    return gateRule?.bypassLabelAuthority;
  });

  // Fetch reviews, PR labels, and changed files in parallel
  const reviewsUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${pr}/reviews?per_page=100`;
  const prUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${pr}`;
  const filesUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${pr}/files?per_page=100`;

  const fetches = [
    paginatedGet(reviewsUrl, token),
    fetch(prUrl, { headers: buildHeaders(token) }).then(r => r.json()),
    paginatedGet(filesUrl, token),
  ];

  // Only fetch label events if authority enforcement is needed
  if (needsAuthorityCheck) {
    fetches.push(fetchLabelAuthority(owner, repo, pr, token));
  }

  const [allReviews, prData, changedFiles, labelAuthority] = await Promise.all(fetches);

  const prLabels = (prData.labels || []).map(l => l.name);
  const changedPaths = changedFiles.map(f => f.filename);

  // For each role, evaluate if required and find the latest review
  const roleStatuses = [];
  const skippedRoles = [];
  const blockedRoles = [];

  for (const role of effectiveRoles) {
    const reviewer = config.reviewers[role];
    const gateRule = reviewer?.gateRule;
    const botLogin = resolveBotLogin(role, repoRoot);

    // Resolve authorized actors for bypass label enforcement
    let authorizedActors = null;
    if (gateRule?.bypassLabelAuthority) {
      const authorityRole = gateRule.bypassLabelAuthority;
      const authorityLogin = resolveBotLogin(authorityRole, repoRoot);
      authorizedActors = authorityLogin ? [authorityLogin] : [];
    }

    // Evaluate conditional requirements
    const requirement = isRoleRequired(gateRule, prLabels, changedPaths, labelAuthority || null, authorizedActors);
    if (requirement.blocked) {
      blockedRoles.push({ role, reason: requirement.reason });
    }
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
        blocked: false,
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
      blocked: requirement.blocked === true,
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
  const passed = pendingRoles.length === 0 && unresolvedCount === 0 && blockedRoles.length === 0;

  return {
    passed,
    pr,
    owner,
    repo,
    roles: roleStatuses,
    approvedRoles,
    pendingRoles,
    skippedRoles,
    blockedRoles,
    unresolvedThreads: unresolvedCount,
    summary: passed
      ? '✅ Review gate passed — all roles approved, no unresolved threads'
      : pendingRoles.length > 0
        ? `⏳ Missing approvals from: ${pendingRoles.join(', ')}`
        : `⚠️ ${unresolvedCount} unresolved thread(s) blocking merge`,
  };
}
