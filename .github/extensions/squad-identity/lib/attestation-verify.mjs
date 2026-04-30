/**
 * Attestation verification — cross-checks GitHub API to confirm
 * a bot-authored write was performed by the claimed actor.
 */

const VALID_WRITE_TYPES = ['pr-create', 'pr-comment', 'issue-comment', 'commit-push', 'label-add'];

export async function verifyWrite({ owner, repo, writeType, writeRef, expectedActor, token }) {
  const base = { expectedActor, writeType, writeRef, checkedAt: Math.floor(Date.now() / 1000) };

  if (!VALID_WRITE_TYPES.includes(writeType)) {
    return { ...base, verified: false, actualActor: null, error: `Unknown writeType: ${writeType}` };
  }

  try {
    const actualActor = await resolveActor({ owner, repo, writeType, writeRef, token });
    return { ...base, verified: actualActor === expectedActor, actualActor };
  } catch (err) {
    return { ...base, verified: false, actualActor: null, error: err.message };
  }
}

async function resolveActor({ owner, repo, writeType, writeRef, token }) {
  const apiBase = 'https://api.github.com';
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let url;
  switch (writeType) {
    case 'pr-create':
      url = `${apiBase}/repos/${owner}/${repo}/pulls/${writeRef}`;
      break;
    case 'pr-comment':
    case 'issue-comment':
      url = `${apiBase}/repos/${owner}/${repo}/issues/comments/${writeRef}`;
      break;
    case 'commit-push':
      url = `${apiBase}/repos/${owner}/${repo}/commits/${writeRef}`;
      break;
    case 'label-add':
      url = `${apiBase}/repos/${owner}/${repo}/issues/${writeRef}/events`;
      break;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();

  switch (writeType) {
    case 'pr-create':
    case 'pr-comment':
    case 'issue-comment':
      return data.user?.login ?? null;
    case 'commit-push':
      return data.author?.login ?? data.committer?.login ?? null;
    case 'label-add': {
      const labelEvent = data.find((e) => e.event === 'labeled');
      if (!labelEvent) throw new Error('No label event found');
      return labelEvent.actor?.login ?? null;
    }
  }
}

// CLI mode
const scriptPath = new URL(import.meta.url).pathname;
const invoked = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === scriptPath;

if (invoked) {
  const args = process.argv.slice(2);

  function flag(name) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const opts = {
    owner: flag('owner'),
    repo: flag('repo'),
    writeType: flag('write-type'),
    writeRef: flag('write-ref'),
    expectedActor: flag('expected-actor'),
    token: flag('token'),
  };

  const missing = Object.entries(opts).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Missing required flags: ${missing.join(', ')}`);
    process.exit(1);
  }

  verifyWrite(opts).then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.verified ? 0 : 1);
  });
}
