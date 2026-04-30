---
"@sabbour/squad-reviews": minor
---

Tokens are now auto-resolved internally via squad-identity's lease system. The `token` parameter has been removed from all tool schemas — tokens never appear in tool call parameters or chat UI. For tools with `roleSlug` (execute_pr_review, execute_issue_review), the token is resolved for that specific role to ensure correct bot attribution.
