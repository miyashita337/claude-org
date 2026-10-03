# Changelog

## 0.2.0 — 2026-10-03

- Add `ccorg` as a short command alias for `claude-org` (same binary)
- Docs: clarify Setup (org picker, token is printed and saved manually, repeat once per org); example labels are `work` / `personal` and explicitly arbitrary

## 0.1.0 — 2026-10-03

Initial public release.

- `claude-org` CLI: `proxy` / `auto` / `<name>` / `probe` / `watch` / `status` / `list`
- Dependency-free Node.js 18+ implementation (fetch / child_process); works on Windows, macOS, Linux
- `proxy`: session-scoped localhost proxy that rewrites `Authorization` per request and fails over to the next org on HTTP 429 or `5h-status=rejected`; SSE passthrough
- `proxy`: launches `claude` with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` and `ENABLE_TOOL_SEARCH=true` (user-set values win) to restore subscription-equivalent behavior under custom `ANTHROPIC_BASE_URL`; forwards `anthropic-beta` unchanged
- `watch`: recovery polling with externalized notification via `CLAUDE_ORG_NOTIFY_CMD`
- Preferred-org resolution: `CLAUDE_ORG_PREFER` -> `CLAUDE_ORG_ORDER` head -> first token file alphabetically
- Compatibility exception vs the original bash version: `help`/`--help`/`-h` exit 0 (was 2)
