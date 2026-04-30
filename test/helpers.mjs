import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;

function matches(pattern, url, init) {
  if (typeof pattern === 'function') {
    return pattern({ url, init });
  }

  if (pattern instanceof RegExp) {
    return pattern.test(url);
  }

  if (typeof pattern === 'string') {
    return url.includes(pattern);
  }

  return false;
}

function toResponseBody(response) {
  if (typeof response.text === 'string') {
    return response.text;
  }

  if (typeof response.body === 'string') {
    return response.body;
  }

  if (response.body !== undefined) {
    return JSON.stringify(response.body);
  }

  if (response.json !== undefined) {
    return JSON.stringify(response.json);
  }

  return '';
}

function createResponse(response, url) {
  const status = response.status ?? 200;
  const headers = new Headers(response.headers ?? {});
  const bodyText = toResponseBody(response);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    url,
    async text() {
      return bodyText;
    },
    async json() {
      if (response.json !== undefined) {
        return response.json;
      }

      return JSON.parse(bodyText || 'null');
    },
  };
}

export function mockFetch(responses = []) {
  const configuredResponses = responses.map((response) => ({
    ...response,
    pattern: response.match ?? response.pattern ?? response.url,
  }));
  const calls = [];

  const spy = async (input, init = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    calls.push({ input, url, init });

    const response = configuredResponses.find((entry) => matches(entry.pattern, url, init));
    if (!response) {
      throw new Error(`Unexpected fetch call: ${url}`);
    }

    if (response.error) {
      throw response.error;
    }

    return createResponse(response, url);
  };

  spy.calls = calls;
  globalThis.fetch = spy;
  return spy;
}

export function createMockConfig() {
  return {
    schemaVersion: '1.1.0',
    reviewers: {
      codereview: {
        agent: 'nibbler',
        dimension: 'Code quality, correctness, test coverage, maintainability',
        charterPath: '.squad/agents/nibbler/charter.md',
      },
      security: {
        agent: 'zapp',
        dimension: 'Security surface, injection, auth, trust boundaries',
        charterPath: '.squad/agents/zapp/charter.md',
      },
      architecture: {
        agent: 'leela',
        dimension: 'Architecture alignment, pack boundaries, API contracts',
        charterPath: '.squad/agents/leela/charter.md',
      },
      docs: {
        agent: 'amy',
        dimension: 'Documentation completeness, changeset quality',
        charterPath: '.squad/agents/amy/charter.md',
      },
    },
    threadResolution: {
      requireReplyBeforeResolve: true,
      templates: {
        addressed: 'Addressed in {sha}: {description}',
        dismissed: 'Dismissed: {justification}',
      },
    },
    feedbackSources: ['squad-agents', 'humans', 'github-copilot-bot'],
  };
}

export function resetMocks() {
  if (originalFetch === undefined) {
    delete globalThis.fetch;
    return;
  }

  globalThis.fetch = originalFetch;
}

export function fixturePath(name) {
  return resolve(testDir, 'fixtures', name);
}

/**
 * A review body that passes quality validation (>150 words, has citations).
 * Use this in tests that need a valid review body but aren't testing quality.
 */
export const COMPLIANT_REVIEW_BODY = [
  'This change introduces a significant refactoring of the authentication module. ',
  'The implementation correctly separates the token validation logic from the session management layer. ',
  'Looking at src/auth.ts:45-62, the new validateToken function properly handles edge cases ',
  'including expired tokens, malformed JWTs, and missing claims. The error propagation through ',
  'the middleware chain at src/middleware.ts:12-30 follows the established patterns correctly. ',
  'Performance considerations: the new caching layer reduces redundant crypto operations by ',
  'memoizing validated tokens for their remaining TTL. Memory pressure is bounded by the LRU ',
  'eviction policy configured at src/cache.ts:8. Test coverage adequately exercises the happy ',
  'path and three key failure modes: expired token, invalid signature, and missing required claims. ',
  'The integration tests verify end-to-end behavior through the HTTP layer correctly. Overall this change ',
  'improves maintainability while preserving correctness and reliability. Security boundaries are respected — ',
  'no secrets leak across module boundaries and all cryptographic operations use constant-time ',
  'comparison functions as required by our security charter standards.',
].join('');
