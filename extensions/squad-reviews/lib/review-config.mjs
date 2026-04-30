import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_RELATIVE_PATH = join('.squad', 'reviews', 'config.json');
const SCHEMA_VERSION = '1.1.0';

function invalidConfig(reason) {
  throw new Error(`Invalid config: ${reason}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyString(value, fieldPath) {
  if (typeof value !== 'string' || value.trim() === '') {
    invalidConfig(`${fieldPath} must be a non-empty string`);
  }
}

const VALID_GATE_REQUIRED_VALUES = ['always', 'conditional', 'optional'];

function validateGateRule(roleSlug, gateRule) {
  if (!isPlainObject(gateRule)) {
    invalidConfig(`reviewers.${roleSlug}.gateRule must be an object`);
  }

  if (!VALID_GATE_REQUIRED_VALUES.includes(gateRule.required)) {
    invalidConfig(`reviewers.${roleSlug}.gateRule.required must be one of: ${VALID_GATE_REQUIRED_VALUES.join(', ')}`);
  }

  if (gateRule.bypassWhen !== undefined) {
    if (!isPlainObject(gateRule.bypassWhen)) {
      invalidConfig(`reviewers.${roleSlug}.gateRule.bypassWhen must be an object`);
    }
    if (gateRule.bypassWhen.labels !== undefined && !Array.isArray(gateRule.bypassWhen.labels)) {
      invalidConfig(`reviewers.${roleSlug}.gateRule.bypassWhen.labels must be an array`);
    }
  }

  if (gateRule.requiredWhen !== undefined) {
    if (!isPlainObject(gateRule.requiredWhen)) {
      invalidConfig(`reviewers.${roleSlug}.gateRule.requiredWhen must be an object`);
    }
    if (gateRule.requiredWhen.paths !== undefined && !Array.isArray(gateRule.requiredWhen.paths)) {
      invalidConfig(`reviewers.${roleSlug}.gateRule.requiredWhen.paths must be an array`);
    }
  }

  if (gateRule.bypassLabels !== undefined && !Array.isArray(gateRule.bypassLabels)) {
    invalidConfig(`reviewers.${roleSlug}.gateRule.bypassLabels must be an array`);
  }

  if (gateRule.bypassLabelAuthority !== undefined) {
    if (typeof gateRule.bypassLabelAuthority !== 'string' || gateRule.bypassLabelAuthority.trim() === '') {
      invalidConfig(`reviewers.${roleSlug}.gateRule.bypassLabelAuthority must be a non-empty string (role slug)`);
    }
  }
}

function validateReviewer(roleSlug, reviewer) {
  if (!isPlainObject(reviewer)) {
    invalidConfig(`reviewers.${roleSlug} must be an object`);
  }

  assertNonEmptyString(reviewer.agent, `reviewers.${roleSlug}.agent`);
  assertNonEmptyString(reviewer.dimension, `reviewers.${roleSlug}.dimension`);
  assertNonEmptyString(reviewer.charterPath, `reviewers.${roleSlug}.charterPath`);

  // gateRule is optional
  if (reviewer.gateRule !== undefined) {
    validateGateRule(roleSlug, reviewer.gateRule);
  }
}

function validateThreadResolution(threadResolution) {
  if (!isPlainObject(threadResolution)) {
    invalidConfig('threadResolution must be an object');
  }

  if (typeof threadResolution.requireReplyBeforeResolve !== 'boolean') {
    invalidConfig('threadResolution.requireReplyBeforeResolve must be a boolean');
  }

  if (!isPlainObject(threadResolution.templates)) {
    invalidConfig('threadResolution.templates must be an object');
  }

  assertNonEmptyString(threadResolution.templates.addressed, 'threadResolution.templates.addressed');
  assertNonEmptyString(threadResolution.templates.dismissed, 'threadResolution.templates.dismissed');
}

function validateFeedbackSources(feedbackSources) {
  if (!Array.isArray(feedbackSources)) {
    invalidConfig('feedbackSources must be an array');
  }

  for (const [index, source] of feedbackSources.entries()) {
    assertNonEmptyString(source, `feedbackSources[${index}]`);
  }
}

function validateConfig(config) {
  if (!isPlainObject(config)) {
    invalidConfig('config must be a JSON object');
  }

  if (config.schemaVersion !== SCHEMA_VERSION) {
    invalidConfig(`schemaVersion must be "${SCHEMA_VERSION}". ${config.schemaVersion === '1.0.0' ? 'Regenerate config with: squad-reviews setup --force' : `Got: "${config.schemaVersion}"`}`);
  }

  if (!isPlainObject(config.reviewers)) {
    invalidConfig('reviewers must be a non-empty object');
  }

  const reviewerEntries = Object.entries(config.reviewers);
  if (reviewerEntries.length === 0) {
    invalidConfig('reviewers must be a non-empty object');
  }

  for (const [roleSlug, reviewer] of reviewerEntries) {
    validateReviewer(roleSlug, reviewer);
  }

  validateThreadResolution(config.threadResolution);
  validateFeedbackSources(config.feedbackSources);

  return config;
}

export function loadConfig(repoRoot) {
  assertNonEmptyString(repoRoot, 'repoRoot');

  const configPath = join(repoRoot, CONFIG_RELATIVE_PATH);

  let rawConfig;
  try {
    rawConfig = readFileSync(configPath, 'utf-8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Config not found at ${configPath}`);
    }

    throw error;
  }

  let parsedConfig;
  try {
    parsedConfig = JSON.parse(rawConfig);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'could not parse JSON';
    invalidConfig(`could not parse JSON (${reason})`);
  }

  return validateConfig(parsedConfig);
}

export function resolveReviewer(config, roleSlug) {
  const validatedConfig = validateConfig(config);
  assertNonEmptyString(roleSlug, 'roleSlug');

  const reviewer = validatedConfig.reviewers[roleSlug];
  if (!reviewer) {
    throw new Error(`Unknown reviewer role: ${roleSlug}`);
  }

  return {
    agent: reviewer.agent,
    dimension: reviewer.dimension,
    charterPath: reviewer.charterPath,
    gateRule: reviewer.gateRule || null,
  };
}

export { SCHEMA_VERSION };

/**
 * Resolve the bot login for a role by reading squad-identity config.
 * Returns `{appSlug}[bot]` or null if identity is not configured.
 */
export function resolveBotLogin(roleSlug, repoRoot) {
  const identityConfigPath = join(repoRoot, '.squad', 'identity', 'config.json');
  try {
    const identityConfig = JSON.parse(readFileSync(identityConfigPath, 'utf-8'));
    const app = identityConfig.apps?.[roleSlug];
    if (app?.appSlug) {
      return `${app.appSlug}[bot]`;
    }
  } catch {
    // identity not configured — caller must handle
  }
  return null;
}

export function getThreadTemplates(config) {
  const validatedConfig = validateConfig(config);

  return {
    addressed: validatedConfig.threadResolution.templates.addressed,
    dismissed: validatedConfig.threadResolution.templates.dismissed,
  };
}
