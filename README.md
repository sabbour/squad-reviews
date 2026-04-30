# @sabbour/squad-reviews

[![npm version](https://img.shields.io/npm/v/%40sabbour%2Fsquad-reviews)](https://www.npmjs.com/package/@sabbour/squad-reviews)
[![CI](https://github.com/sabbour/squad-reviews/actions/workflows/ci.yml/badge.svg)](https://github.com/sabbour/squad-reviews/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Copilot CLI extension and CLI for config-driven review governance across PRs, issues, review threads, and reviewer routing.

## Prerequisites

- Node.js 18+
- [`@sabbour/squad-identity`](https://www.npmjs.com/package/@sabbour/squad-identity) installed and configured
- A GitHub token available through one of:
  - `SQUAD_REVIEW_TOKEN`
  - `GH_TOKEN`
  - `GITHUB_TOKEN`

## Installation

Install the package:

```bash
npm install @sabbour/squad-reviews
```

Install the peer dependency if you have not already:

```bash
npm install @sabbour/squad-identity
```

Copy the extension into your repo and add the config template:

```bash
mkdir -p .github/extensions reviews
cp -R node_modules/@sabbour/squad-reviews/extensions/squad-reviews .github/extensions/
cp node_modules/@sabbour/squad-reviews/reviews/config.json.template reviews/config.json.template
```

## Quick Start

1. Create `reviews/config.json` from the template:

   ```bash
   npx squad-reviews setup
   ```

2. Edit `reviews/config.json` and map each review role to your team reviewer.
3. Validate the setup:

   ```bash
   npx squad-reviews status
   npx squad-reviews doctor
   ```

Minimal example:

```json
{
  "schemaVersion": "1.0.0",
  "reviewers": {
    "security": {
      "agent": "zapp",
      "dimension": "Security surface, injection, auth, trust boundaries",
      "charterPath": ".squad/agents/zapp/charter.md"
    },
    "docs": {
      "agent": "amy",
      "dimension": "Documentation completeness, changeset quality",
      "charterPath": ".squad/agents/amy/charter.md"
    }
  },
  "threadResolution": {
    "requireReplyBeforeResolve": true,
    "templates": {
      "addressed": "Addressed in {sha}: {description}",
      "dismissed": "Dismissed: {justification}"
    }
  },
  "feedbackSources": ["squad-agents", "humans", "github-copilot-bot"]
}
```

## Extension Tools

| Tool | Description |
| --- | --- |
| `squad_reviews_request_pr_review` | Request a PR review from a configured reviewer role. |
| `squad_reviews_execute_pr_review` | Execute a PR review using the reviewer charter and bot token. |
| `squad_reviews_acknowledge_feedback` | List unresolved PR review threads that still need action. |
| `squad_reviews_resolve_thread` | Reply to a PR review thread, then resolve it as addressed or dismissed. |
| `squad_reviews_request_issue_review` | Request an issue review from a configured reviewer role. |
| `squad_reviews_execute_issue_review` | Execute an issue review and optionally apply the approval label. |
| `squad_reviews_status` | Show the current review config and registered reviewers. |
| `squad_reviews_doctor` | Run health checks for config, identity, labels, and GitHub setup. |
| `squad_reviews_setup` | Create `reviews/config.json` from the template. |

## CLI Usage

```bash
squad-reviews status
squad-reviews doctor
squad-reviews setup
squad-reviews request-pr-review --pr <number> --reviewer <role> [--owner <owner> --repo <repo>]
squad-reviews execute-pr-review --pr <number> --role <role> --event <COMMENT|REQUEST_CHANGES> [--body <text>] [--owner <owner> --repo <repo>]
squad-reviews acknowledge-feedback --pr <number> [--owner <owner> --repo <repo>]
squad-reviews resolve-thread --pr <number> --thread <id> --comment <id> --reply <text> --action <addressed|dismissed> [--owner <owner> --repo <repo>]
squad-reviews request-issue-review --issue <number> --reviewer <role> [--owner <owner> --repo <repo>]
squad-reviews execute-issue-review --issue <number> --role <role> [--approved] [--body <text>] [--owner <owner> --repo <repo>]
```

Examples:

```bash
npx squad-reviews request-pr-review --pr 42 --reviewer security
npx squad-reviews execute-pr-review --pr 42 --role security --event REQUEST_CHANGES --body "Auth boundary is too permissive."
npx squad-reviews acknowledge-feedback --pr 42
npx squad-reviews resolve-thread --pr 42 --thread THREAD_ID --comment 123456 --reply "abc1234: tightened validation and added tests" --action addressed
npx squad-reviews request-issue-review --issue 29 --reviewer docs
npx squad-reviews execute-issue-review --issue 29 --role docs --approved --body "Approved from a docs completeness perspective."
```

Run command-specific help with:

```bash
squad-reviews <command> --help
```

## Configuration

`reviews/config.json` uses a small, validated schema:

- `schemaVersion`: currently must be `"1.0.0"`
- `reviewers`: non-empty object keyed by role slug
  - `agent`: Squad agent name that owns the review
  - `dimension`: human-readable review scope
  - `charterPath`: repo-local charter file used as the review rubric
- `threadResolution`:
  - `requireReplyBeforeResolve`: boolean guard for thread handling
  - `templates.addressed`: reply template for fixed feedback; supports `{sha}` and `{description}`
  - `templates.dismissed`: reply template for intentional non-action; supports `{justification}`
- `feedbackSources`: allowlist of feedback sources to consider during acknowledgment
  - `squad-agents`
  - `humans`
  - `github-copilot-bot`

## How It Works

1. **Request** — route a PR or issue to a configured reviewer role.
2. **Execute** — the reviewer uses its charter, reads the artifact, and posts review feedback.
3. **Acknowledge** — the implementer fetches unresolved feedback threads.
4. **Resolve** — each thread is replied to and resolved as either `addressed` or `dismissed`.

For PRs, the flow uses native GitHub review events (`COMMENT` or `REQUEST_CHANGES`). For issue reviews, approval is represented by the `{role}:approved` label.

## Integration with `@sabbour/squad-identity`

`@sabbour/squad-reviews` depends on `@sabbour/squad-identity` as a peer because review execution needs a bot identity and token source. In practice:

- `squad-identity` provisions or resolves the bot credentials
- `squad-reviews` consumes those credentials through `SQUAD_REVIEW_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`
- `doctor` also checks whether the `squad-identity` extension is installed under `.github/extensions/` or `extensions/`

Install and configure identity first, then wire review roles to the agent charters you want enforcing governance.

## Development

```bash
npm install
npm test
```

Contributions should keep the package config-driven, preserve the review-thread reply-before-resolve behavior, and update tests when behavior changes.

## License

MIT
