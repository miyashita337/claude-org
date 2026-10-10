# claude-org

Launch [Claude Code](https://code.claude.com) under a specific Anthropic **organization** — and keep running when the 5-hour usage limit hits, by failing over to another org you belong to.

When one account has multiple Claude organizations (e.g. a personal org and your company's org, or several personal orgs), hitting the usage limit stalls your session. `claude-org` switches the credential `claude` starts with, and — in `proxy` mode — swaps it **mid-session** the moment the limit hits, so a long-running task never stops.

Requires Node.js 18+. Zero runtime dependencies. Works on Windows, macOS, and Linux.

## Install

```sh
npm install -g claude-org
```

This installs two commands that behave identically: `claude-org` and the shorter alias `ccorg`. Examples below use `claude-org`; substitute `ccorg` anywhere.

## Setup

Each org you want to switch between needs its own long-lived token, saved under a label you choose. The plain `claude` login (no token file) is called the **default org** and needs no setup.

Repeat steps 1–2 **once per org**:

1. Generate a token for one org (valid ~1 year):

   ```sh
   claude setup-token
   ```

   A browser opens. If your account belongs to several orgs, an **org picker** appears — choose the org this token is for. Approve, paste the auth code back into the terminal, and `claude setup-token` **prints the token to stdout**. It does not save it anywhere; you save it in the next step.

2. Save that token (no trailing newline) as `~/.claude/org-tokens/<name>.token`. `<name>` is just a label you pick — it does not need to match the org's plan or display name. `work` and `personal` are common; `client-a`, `personal2`, etc. are equally fine.

   ```sh
   # bash / macOS / Linux
   mkdir -p ~/.claude/org-tokens
   printf '%s' '<token>' > ~/.claude/org-tokens/work.token
   ```

   ```powershell
   # PowerShell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\org-tokens" | Out-Null
   Set-Content -NoNewline "$env:USERPROFILE\.claude\org-tokens\work.token" "<token>"
   ```

   The token may visually wrap onto two lines in the terminal — join it into one.

3. Check that each label points at the org you intended:

   ```sh
   claude-org status
   ```

## Commands

| Command | What it does |
|---|---|
| `claude-org proxy [claude args...]` | Launch via a local proxy: a **running** session fails over to another org the moment the 5h limit hits. Needs 2+ org tokens (incl. one for the default side). |
| `claude-org auto [claude args...]` | Launch on the preferred org if usable, else on the default org. Decided once at launch. |
| `claude-org <name> [claude args...]` | Launch with that org's token, e.g. `claude-org work --resume`. |
| `claude-org probe [<name>] [--model <id>]` | Print the org's 5h window state on one line (`status= 5h_util= 5h_reset= 5h_reset_local=`). Exit 0 when `allowed`. With `--model`, probe with that model and append `model= model_status=` (see below). |
| `claude-org watch` | Poll the preferred org until its window recovers, then notify (terminal + optional `CLAUDE_ORG_NOTIFY_CMD`). |
| `claude-org status [--model <id>]` | `claude auth status` and `probe` for every saved token + the default login. |
| `claude-org list` | List saved org names. |

`auto` and `<name>` only read env at launch — they cannot switch a running session. Settings, plugins, and session history live under `~/.claude/` and are shared across orgs, so `claude-org auto --resume` continues a session started under the other org.

**Checking a model, not just the window**: `probe` and `status` use Haiku by default, but an org can show `status=allowed` and still refuse another model (for example one that needs usage credits). Pass the model your session uses:

```sh
claude-org probe work --model claude-fable-5-1
# status=allowed 5h_util=0.34 ... model=claude-fable-5-1 model_status=unavailable model_error=rate_limit_error
```

`model_status` is `available` (2xx), `unavailable` (refused while the 5h/7d windows are not rejected; exit 1) or `unknown` (no response, bad token, server error, or a rejected window). Setting `CLAUDE_ORG_PROBE_MODEL` applies the same check to `probe`, `status` and `auto`; `auto` then launches on the default org when the preferred org refuses that model.

The **preferred org** (used by `auto`, `watch`, and as `proxy`'s first candidate) resolves in this order: `CLAUDE_ORG_PREFER` -> first entry of `CLAUDE_ORG_ORDER` -> first `.token` file alphabetically.

## proxy mode

```
claude-org proxy --resume
```

1. A session-scoped proxy starts on `127.0.0.1:<random port>` (one per session; no port collisions).
2. `claude` launches with `ANTHROPIC_BASE_URL` pointing at the proxy and a **dummy** bearer token.
3. The proxy replaces the `Authorization` header with a real org token and forwards to `api.anthropic.com`. On a 429 or `anthropic-ratelimit-unified-5h-status: rejected` it marks that org limited until `5h-reset` and **resends the same request** with the next org's token.
4. Claude Code only ever sees the successful response — the org switched mid-session. SSE streaming is piped through untouched.

One log line per request (`via <org> model=<model> -> <status>`) goes to a temp file printed at launch (`-> proxy 127.0.0.1:<port> (order: ..., log: ...)`). The prompt and the tokens are never logged.

**Which org is in use right now**: after each model request the proxy writes `{"org", "model", "status", "at"}` as JSON (`org` is `null` with `status` 503 when no org could serve) to `state.json` in the same temp directory as the log. Its path is exported to the `claude` process as `CLAUDE_ORG_STATE_FILE`, so a statusline command or hook can show it, e.g.:

```sh
[ -n "$CLAUDE_ORG_STATE_FILE" ] && [ -f "$CLAUDE_ORG_STATE_FILE" ] && node -p "require(process.env.CLAUDE_ORG_STATE_FILE).org"
```

**Limitations of proxy mode**

- claude.ai connector MCPs (Gmail / Drive / Calendar / Notion / Slack …) and Remote Control are **unavailable**: `ANTHROPIC_AUTH_TOKEN` makes Claude Code treat the session as external-token auth, so `mcp__claude_ai_*` tools do not appear. Local/plugin MCPs work. Open connectors in a plain `claude --resume` session — history is shared.
- Each proxy serves one session and dies when `claude` exits.

### Prompt cache & tool search

A custom `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` makes Claude Code treat the session as API-key auth, which changes two defaults:

- **Prompt cache TTL drops to 5 minutes** (subscription-direct sessions get 1 hour). The 1-hour TTL is requested via the `anthropic-beta` header, which the proxy forwards unchanged.
- **MCP tool search** (deferred tool-definition loading) is **disabled**.

`claude-org proxy` restores the subscription-equivalent behavior by launching `claude` with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` and `ENABLE_TOOL_SEARCH=true`. If you have set either variable yourself, your value wins.

| Entry point | Mid-session switch | Connector MCPs | Best for |
|---|---|---|---|
| `claude` | no (default org) | yes | connector work |
| `claude-org auto --resume` | at launch only | no on preferred org / yes on default | short tasks |
| `claude-org proxy --resume` | **automatic** | no | long-running work, agents |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_ORG_PREFER` | (unset) | Preferred org for `auto` / `watch` / `proxy` |
| `CLAUDE_ORG_ORDER` | (unset) | Comma-separated org priority for `proxy`; unlisted orgs follow alphabetically |
| `CLAUDE_ORG_PROBE_MODEL` | (unset: Haiku) | Model used by `probe` / `status` / `auto` to check the org; adds `model_status=` to the probe line |
| `CLAUDE_ORG_TOKEN_DIR` | `~/.claude/org-tokens` | Where `<name>.token` files live |
| `CLAUDE_ORG_NOTIFY_CMD` | (unset) | `watch` notification command, run as `<cmd> "<title>" "<message>"` via the OS shell |
| `CLAUDE_ORG_WATCH_MAX_SLEEP` | `18000` | Max seconds between `watch` re-checks (values < 60 also lower the 60s minimum — for tests) |
| `CLAUDE_ORG_UPSTREAM` | `https://api.anthropic.com` | API base URL for `probe` and `proxy` (stub upstream in tests) |
| `CLAUDE_ORG_PROXY` | `1` when launched via `proxy` | Marker env passed to the claude process so user hooks can detect connector-less sessions |
| `CLAUDE_ORG_STATE_FILE` | set when launched via `proxy` | Path of the JSON file holding the org and model of the last request (read it from a statusline or hook) |
| `CLAUDE_ORG_FORCE_PROBE` | (unset) | Test seam: `allowed` / `rejected[:<epoch>]` / `rejected_until:<epoch>` fakes `probe` results without API calls |
| `CLAUDE_ORG_REJECT_FILE` | (unset) | Test seam: orgs listed comma-separated in this file are treated as rate-limited by `proxy` |

## Notes

- **Token safety**: tokens are read from files only and never printed to logs, errors, or test snapshots. The proxy binds to `127.0.0.1` only.
- **probe cost**: each `probe` sends one `max_tokens=1` request (~11 tokens billed to that org), once per `auto` launch.
- **Token expiry**: tokens last ~1 year. If `probe` returns `status=unknown` or `status` shows `(auth status failed)`, rerun `claude setup-token` and overwrite the file.

## A note on terms

claude-org only switches between Anthropic organizations **you personally belong to**, using long-lived tokens you generated yourself via `claude setup-token`. All traffic stays on your machine (the proxy binds to 127.0.0.1). Per Anthropic's authentication docs, OAuth tokens are intended for ordinary use of Claude Code — do not use this tool to route other people's requests through your subscription credentials. Each org's usage is billed/limited to that org as usual. Check [Anthropic's Usage Policy](https://www.anthropic.com/legal/aup) and your plan's terms yourself before use. Commands that mention token env names may also be blocked by safety hooks in hardened Claude Code setups.

## Development

```sh
npm test            # node:test suite, no real API calls
npm pack --dry-run  # inspect the published file set
```

### Releasing

Write the changes under `## Unreleased` in `CHANGELOG.md`, then on an up-to-date `main`:

```sh
npm login                               # once per machine
npm run release -- patch --dry-run      # checks + tests only, changes nothing
npm run release -- patch                # or minor / major / X.Y.Z
```

The script refuses to run off `main`, with uncommitted tracked changes, out of sync with `origin/main`, with an existing tag or registry version, with files npm would publish that git does not track, or without npm login. It then runs the tests, renames `## Unreleased` to the new version heading, bumps `package.json`, commits `chore: release vX.Y.Z`, tags, pushes the commit and tag together (atomic), runs `npm publish` and waits until the registry serves the new version. `--no-publish` stops after the push.

Users update with `npm install -g claude-org@latest`.

## License

MIT
