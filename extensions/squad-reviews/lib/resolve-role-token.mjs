/**
 * Resolve a GitHub token for a specific reviewer role.
 *
 * The calling agent is expected to resolve per-role tokens via squad_identity_resolve_token
 * and pass them explicitly. This module provides the fallback chain when no explicit token is given.
 *
 * @param {string} roleSlug - reviewer role slug (e.g., 'security', 'codereview')
 * @param {string|null|undefined} explicitToken - token passed directly by the caller
 * @returns {string} resolved token
 */
export function resolveRoleToken(roleSlug, explicitToken) {
  if (explicitToken) return explicitToken;

  // Per-role env var (e.g., SQUAD_REVIEW_TOKEN_SECURITY)
  const roleEnvKey = `SQUAD_REVIEW_TOKEN_${roleSlug.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[roleEnvKey]) return process.env[roleEnvKey];

  // Generic fallback
  const generic = process.env.SQUAD_REVIEW_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
  if (generic) return generic;

  throw new Error(
    `No token available for role "${roleSlug}". ` +
    `Set ${roleEnvKey}, SQUAD_REVIEW_TOKEN, GH_TOKEN, or GITHUB_TOKEN. ` +
    `Agents should call squad_identity_resolve_token with roleSlug="${roleSlug}" first.`
  );
}
