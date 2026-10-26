# Changelog

## Unreleased

- `proxy`: claude.ai connector MCPs (Slack / Notion / Gmail …) now work in proxy sessions when you are signed in to claude.ai. The launch checks `claude auth status`; with a claude.ai login, `claude` keeps it and sends the per-session secret in an `x-claude-org-secret` header (`ANTHROPIC_CUSTOM_HEADERS`, your own lines kept) instead of `ANTHROPIC_AUTH_TOKEN`. The proxy discards the login token and the header and still sends only org tokens upstream. Without a login (or with `CLAUDE_ORG_NO_CONNECTORS=1`) the session starts as before. The launch line `-> claude.ai connectors: on/off (...)` and the `CLAUDE_ORG_CONNECTORS=1/0` env say which mode is in use (#35)

- `proxy`: each launch keeps its log dir (`claude-org-proxy-*` in the temp dir) for later investigation, but now removes all but the newest 20 at startup, so repeated and headless launches no longer pile up (#15)

## 0.4.0 — 2026-10-11

- `proxy`: hardened for unattended use under a supervisor (#22)
  - only the `claude` it launched can use it: a per-session secret is checked (constant time) on every request, `Host` must be `127.0.0.1:<port>`, only `GET` / `POST` / `DELETE` under `/v1/` are forwarded, and bodies over 64 MB get 413. Standalone `node lib/proxy.js` needs `CLAUDE_ORG_PROXY_SECRET`
  - it no longer crashes or hangs: an unreadable token dir gives 503, every request handler error is caught, hop-by-hop headers are dropped, an upstream that sends nothing for 10 min is given up and the next org tried, and a `claude` that cancels or exits mid-response cancels the upstream request
  - the launcher forwards `SIGTERM` / `SIGHUP` (and `SIGINT` without a terminal) to `claude`, waits for it, and sends `SIGKILL` after 10 s, so killing the launcher pid no longer orphans `claude`; with a terminal, Ctrl-C no longer kills the proxy under a running `claude`
  - token files must be mode `0600` and owned by the user, org names are limited to `[A-Za-z0-9_-]`, and `CLAUDE_ORG_UPSTREAM` other than `https://api.anthropic.com` is refused unless `CLAUDE_ORG_UNSAFE_UPSTREAM=1`
  - a 401 from an org (expired token) fails over to the next org, and "no org works" events are logged on fixed-format `ALERT ...` lines a supervisor can grep (README, "Unattended use")
  - the proxy log never records a request's query string (a refused `/v1/messages?...` is logged as such), so a secret put there cannot leak into the log
  - README: unattended runs must use proxy mode; how to keep the token dir away from `claude`'s shell and Read tool

## 0.3.0 — 2026-10-10

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
