# Changelog

## Unreleased

- `proxy`: each log line now names the model (`via <org> model=<model> -> <status>`), and the org and model of the last request are written to a JSON state file whose path is passed to `claude` as `CLAUDE_ORG_STATE_FILE`, for statusline and hooks (#12)
- `probe` / `status`: `--model <id>` (or `CLAUDE_ORG_PROBE_MODEL`) checks that model instead of Haiku and appends `model_status=available|unavailable|unknown` (and `model_error=` when refused), so "5h allowed but this model is refused" is told apart. `auto` falls back to the default org when the preferred org refuses the model (#9)
- `proxy`: `CLAUDE_ORG_STRATEGY=least-utilized` sends each request to the usable org with the lowest 5h utilization it has reported (orgs not yet measured are tried first). Unset keeps the priority order; the launch line and the log now show the strategy (#7)
- Docs: proxy mode now explains that Agent-tool subagents go through the same proxy and what that implies (#16)

## 0.2.2 — 2026-10-10

- Development: `npm run release -- <patch|minor|major|X.Y.Z>` runs the whole release (checks, tests, CHANGELOG, version, commit, tag, push, npm publish, registry check)

## 0.2.1 — 2026-10-10

- `proxy`: a 429 is now classified before failing over (#8). Only a rejected 5h or 7d window takes the whole org out. Any other 429 (a used-up per-model allowance, a model that needs usage credits, a per-minute limit) takes the org out for that model only, for at most 10 minutes or the `retry-after` time, so other models keep using the org
- `proxy`: the log now shows the reason of each 429 (`error.type: message`, decoded from a brotli/gzip/deflate body) and the rate-limit claim, and says to switch the model when every org refused the same model
- Windows: launch `claude` without the Node DEP0190 deprecation warning (shell args passed as one quoted command string) (#10)

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
