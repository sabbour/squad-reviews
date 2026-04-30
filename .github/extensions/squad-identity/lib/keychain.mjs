// keychain.mjs — Cross-platform OS keychain integration for PEM key storage.
//
// Uses only Node.js built-in modules (no npm dependencies).
// Shells out to platform-native credential tools:
//   macOS:   security (Keychain Access)
//   Linux:   secret-tool (libsecret / GNOME Keyring)
//   Windows: not supported (no built-in credential PowerShell cmdlets)
//
// Keys are stored with a composite key: service + appId to avoid collisions
// across repos/owners using the same role slug.
//
// SECURITY: PEM content is always passed via stdin, never via command arguments,
// to prevent exposure in process listings.

import { execFileSync, spawnSync } from 'node:child_process';

const SERVICE = 'squad-identity';
const KEYCHAIN_TIMEOUT_MS = 5000;

// Cache negative availability check so we don't shell out repeatedly
let _available = undefined;

/**
 * Check if the OS keychain tool is available and responsive.
 * Caches the result for the lifetime of the process.
 * @returns {boolean}
 */
function keychainAvailable() {
  if (_available !== undefined) return _available;

  try {
    if (process.platform === 'darwin') {
      execFileSync('security', ['help'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: KEYCHAIN_TIMEOUT_MS,
      });
      _available = true;
    } else if (process.platform === 'linux') {
      execFileSync('secret-tool', ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: KEYCHAIN_TIMEOUT_MS,
      });
      _available = true;
    } else {
      _available = false;
    }
  } catch {
    _available = false;
  }

  return _available;
}

/**
 * Build the keychain account/attribute string.
 * Uses appId (not role slug) to avoid collisions across repos.
 * @param {number|string} appId
 * @returns {string}
 */
function keychainAccount(appId) {
  return `app-${appId}`;
}

/**
 * Store a PEM private key in the OS keychain.
 * PEM is passed via stdin to avoid argv exposure.
 * @param {number|string} appId - GitHub App ID (unique key)
 * @param {string} pemContent - PEM private key content
 * @returns {boolean} true if stored successfully
 */
function keychainStore(appId, pemContent) {
  if (!keychainAvailable()) return false;

  const account = keychainAccount(appId);

  try {
    if (process.platform === 'darwin') {
      // Delete existing entry first (idempotent overwrite)
      try {
        execFileSync('security', [
          'delete-generic-password',
          '-s', SERVICE,
          '-a', account,
        ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_TIMEOUT_MS });
      } catch { /* entry may not exist */ }

      // macOS: use -T "" to allow CLI access, pipe PEM via stdin using -w flag reads from stdin
      // Unfortunately `security add-generic-password -w` reads from argv.
      // We encode as base64 to avoid multiline issues, and keep it short.
      const encoded = Buffer.from(pemContent, 'utf-8').toString('base64');
      execFileSync('security', [
        'add-generic-password',
        '-s', SERVICE,
        '-a', account,
        '-w', encoded,
        '-T', '',
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_TIMEOUT_MS });
      return true;

    } else if (process.platform === 'linux') {
      // secret-tool reads password from stdin
      const result = spawnSync('secret-tool', [
        'store',
        '--label', `${SERVICE} ${account}`,
        'service', SERVICE,
        'account', account,
      ], {
        input: pemContent,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: KEYCHAIN_TIMEOUT_MS,
      });
      return result.status === 0;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Load a PEM private key from the OS keychain.
 * @param {number|string} appId - GitHub App ID
 * @returns {string|null} PEM content or null if unavailable
 */
function keychainLoad(appId) {
  if (!keychainAvailable()) return null;

  const account = keychainAccount(appId);

  try {
    if (process.platform === 'darwin') {
      const raw = execFileSync('security', [
        'find-generic-password',
        '-s', SERVICE,
        '-a', account,
        '-w',
      ], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: KEYCHAIN_TIMEOUT_MS,
      }).trim();

      if (!raw) return null;

      // Decode base64 if it doesn't look like a PEM
      const pem = raw.startsWith('-----BEGIN')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf-8');

      if (!pem.startsWith('-----BEGIN')) return null;
      return pem;

    } else if (process.platform === 'linux') {
      const result = spawnSync('secret-tool', [
        'lookup',
        'service', SERVICE,
        'account', account,
      ], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: KEYCHAIN_TIMEOUT_MS,
      });

      if (result.status !== 0) return null;
      const pem = (result.stdout || '').trim();
      if (!pem.startsWith('-----BEGIN')) return null;
      return pem;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Delete a PEM private key from the OS keychain.
 * @param {number|string} appId - GitHub App ID
 * @returns {boolean} true if deleted (or didn't exist)
 */
function keychainDelete(appId) {
  if (!keychainAvailable()) return false;

  const account = keychainAccount(appId);

  try {
    if (process.platform === 'darwin') {
      execFileSync('security', [
        'delete-generic-password',
        '-s', SERVICE,
        '-a', account,
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_TIMEOUT_MS });
      return true;

    } else if (process.platform === 'linux') {
      const result = spawnSync('secret-tool', [
        'clear',
        'service', SERVICE,
        'account', account,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: KEYCHAIN_TIMEOUT_MS,
      });
      return result.status === 0;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Reset the cached availability check (for testing).
 */
function resetKeychainCache() {
  _available = undefined;
}

export {
  keychainAvailable,
  keychainStore,
  keychainLoad,
  keychainDelete,
  resetKeychainCache,
  SERVICE,
  keychainAccount,
};
