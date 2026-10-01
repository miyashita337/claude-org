# Changelog

## 0.1.0 (unreleased)

Initial public release.

- `claude-org` CLI: `proxy` / `auto` / `<name>` / `probe` / `watch` / `status` / `list`
- Dependency-free Node.js 18+ implementation (fetch / child_process); works on Windows, macOS, Linux
- `proxy`: session-scoped localhost proxy that rewrites `Authorization` per request and fails over to the next org on HTTP 429 or `5h-status=rejected`; SSE passthrough
- `watch`: recovery polling with externalized notification via `CLAUDE_ORG_NOTIFY_CMD`
- Preferred-org resolution: `CLAUDE_ORG_PREFER` -> `CLAUDE_ORG_ORDER` head -> first token file alphabetically
- Compatibility exception vs the original bash version: `help`/`--help`/`-h` exit 0 (was 2)
