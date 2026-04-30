const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const GITHUB_API_VERSION = '2022-11-28';

function buildHeaders(token, { accept = 'application/vnd.github+json', contentType } = {}) {
  const headers = {
    Accept: accept,
    Authorization: `token ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  return headers;
}

async function readResponseBody(response) {
  const body = await response.text();
  return body || '<empty response body>';
}

async function ensureSuccess(response, method, url) {
  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new Error(`${method} ${url} failed with ${response.status}: ${body}`);
  }

  return response;
}

async function requestJson(url, { method = 'GET', token, body, accept } = {}) {
  const response = await fetch(url, {
    method,
    headers: buildHeaders(token, {
      accept,
      contentType: body === undefined ? undefined : 'application/json',
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  await ensureSuccess(response, method, url);
  return response.json();
}

async function requestText(url, { method = 'GET', token, accept } = {}) {
  const response = await fetch(url, {
    method,
    headers: buildHeaders(token, { accept }),
  });

  await ensureSuccess(response, method, url);
  return response.text();
}

function getNextPageUrl(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') {
      return match[1];
    }
  }

  return null;
}

async function requestPaginatedJson(url, token) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      method: 'GET',
      headers: buildHeaders(token),
    });

    await ensureSuccess(response, 'GET', nextUrl);
    const pageItems = await response.json();
    items.push(...pageItems);
    nextUrl = getNextPageUrl(response.headers.get('link'));
  }

  return items;
}

async function graphqlRequest(token, query, variables) {
  const payload = await requestJson(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    token,
    body: { query, variables },
  });

  if (payload.errors?.length) {
    throw new Error(`POST ${GITHUB_GRAPHQL_URL} failed with GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

async function fetchReviewThreadMetadata(token, owner, repo, prNumber) {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100, after: $after) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  id
                  databaseId
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  const metadata = new Map();
  let after = null;

  do {
    const data = await graphqlRequest(token, query, {
      owner,
      repo,
      prNumber,
      after,
    });

    const reviewThreads = data?.repository?.pullRequest?.reviewThreads;
    const nodes = reviewThreads?.nodes ?? [];

    for (const thread of nodes) {
      const rootComment = thread.comments?.nodes?.[0];
      if (!rootComment?.id) {
        continue;
      }

      metadata.set(rootComment.id, {
        threadId: thread.id,
        isResolved: Boolean(thread.isResolved),
        commentDatabaseId: rootComment.databaseId ?? null,
      });
    }

    after = reviewThreads?.pageInfo?.hasNextPage ? reviewThreads.pageInfo.endCursor : null;
  } while (after);

  return metadata;
}

export async function fetchPrDiff(token, owner, repo, prNumber) {
  const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}`;
  return requestText(url, {
    token,
    accept: 'application/vnd.github.diff',
  });
}

export async function fetchPrHead(token, owner, repo, prNumber) {
  const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}`;
  const pr = await requestJson(url, { token });
  return pr.head?.sha || null;
}

export async function fetchPrReviews(token, owner, repo, prNumber) {
  const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`;
  return requestPaginatedJson(url, token);
}

export async function fetchPrThreads(token, owner, repo, prNumber) {
  const commentsUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`;
  const [comments, threadMetadata] = await Promise.all([
    requestPaginatedJson(commentsUrl, token),
    fetchReviewThreadMetadata(token, owner, repo, Number(prNumber)),
  ]);

  return comments
    .filter((comment) => comment.in_reply_to_id == null)
    .map((comment) => {
      const metadata = threadMetadata.get(comment.node_id);

      return {
        threadId: metadata?.threadId ?? comment.node_id,
        commentId: comment.node_id,
        commentDatabaseId: metadata?.commentDatabaseId ?? comment.id ?? null,
        author: comment.user?.login ?? null,
        body: comment.body ?? '',
        path: comment.path ?? null,
        line: comment.line ?? comment.original_line ?? null,
        isResolved: metadata?.isResolved ?? false,
      };
    });
}

export async function postReview(token, owner, repo, prNumber, payload) {
  const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
  // payload may be { body, event } or { body, event, comments }
  // Support legacy (body, event) signature for backward compat
  let reviewBody;
  if (typeof payload === 'string') {
    // Legacy: postReview(token, owner, repo, pr, body, event)
    const event = arguments[5];
    reviewBody = { body: payload, event };
  } else {
    reviewBody = payload;
  }
  const review = await requestJson(url, {
    method: 'POST',
    token,
    body: reviewBody,
  });

  return review.id;
}

export async function postComment(token, owner, repo, issueNumber, body) {
  const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const comment = await requestJson(url, {
    method: 'POST',
    token,
    body: { body },
  });

  return comment.id;
}

export async function replyToThread(token, owner, repo, prNumber, commentId, body) {
  const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`;
  const reply = await requestJson(url, {
    method: 'POST',
    token,
    body: { body },
  });

  return reply.id;
}

export async function resolveThread(token, threadId) {
  const mutation = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          isResolved
        }
      }
    }
  `;

  const data = await graphqlRequest(token, mutation, { threadId });
  const resolved = Boolean(data?.resolveReviewThread?.thread?.isResolved);

  if (!resolved) {
    throw new Error(`POST ${GITHUB_GRAPHQL_URL} failed with unresolved thread: ${threadId}`);
  }

  return { resolved: true };
}

export async function applyLabel(token, owner, repo, issueNumber, label) {
  const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/issues/${issueNumber}/labels`;
  await requestJson(url, {
    method: 'POST',
    token,
    body: { labels: [label] },
  });
}
