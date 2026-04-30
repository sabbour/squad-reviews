# Squad Decisions

## Active Decisions

### Holdo Identity Mapping (2026-04-29T17:20:56.371-07:00)

- **Decision:** Standardize project Git-writing identities to four per-role bots only: `lead`, `backend`, `tester`, and `scribe`.
- **Mapping:** Holdo→`lead`, Poe→`backend`, Rose→`tester`, Scribe→`scribe`.
- **Attribution rule:** All GitHub writes must use the token resolved by `squad-identity` for the mapped role slug and must be attributable to `squad-{roleSlug}[bot]`.
- **Non-authoring exception:** Ralph remains outside the Git-authoring roster and should not perform GitHub writes.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
