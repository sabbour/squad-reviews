# Reviews configuration

This directory holds the repo-local review configuration. The config maps review roles to your team agents, defines how review threads are resolved, and limits which feedback sources are considered by the review workflow.

## Prerequisite

`@sabbour/squad-identity` must already be configured so agent names can be resolved to the identities your tooling expects.

## Setup

1. Copy `.squad/reviews/config.json.template` to `.squad/reviews/config.json`.
2. Edit `.squad/reviews/config.json` for your team.
3. Commit the new file.

Example:

```bash
cp .squad/reviews/config.json.template .squad/reviews/config.json
```

## reviewers

`reviewers` maps a role slug to the agent that owns that review dimension.

- `agent`: the team agent name to use for that role
- `dimension`: short human-readable scope for that reviewer
- `charterPath`: path to the agent charter in this repo

You can point these role slugs at any agents your team uses. Keep the slugs stable if other automation refers to `codereview`, `security`, `architecture`, or `docs`.

## threadResolution

`threadResolution` controls what must happen before a thread is closed.

- `requireReplyBeforeResolve: true` means the thread should get an explicit reply before it is resolved.
- `templates.addressed` is for fixes that landed. Use `{sha}` and `{description}` placeholders.
- `templates.dismissed` is for intentional non-actions. Use `{justification}`.

## feedbackSources

`feedbackSources` is an allowlist. Only feedback from listed source types is considered.

- `squad-agents`: comments from your configured Squad reviewers
- `humans`: comments from human reviewers
- `github-copilot-bot`: comments from Copilot review automation

Remove a source to ignore it. Add a source only if your review tooling supports that source type.
