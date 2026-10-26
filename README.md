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

`model_status` is `available` (2xx), `unavailable` (refused while the 5h/7d windows are not rejected; exit 1) or `unknown` (no response, bad token or permission, timeout, server error, or a rejected window; the exit code then follows `status` alone). Setting `CLAUDE_ORG_PROBE_MODEL` applies the same check to `probe`, `status` and `auto`; `auto` then launches on the default org when the preferred org refuses that model.

The **preferred org** (used by `auto`, `watch`, and as `proxy`'s first candidate) resolves in this order: `CLAUDE_ORG_PREFER` -> first entry of `CLAUDE_ORG_ORDER` -> first `.token` file alphabetically.

## proxy mode

```
claude-org proxy --resume
```

1. A session-scoped proxy starts on `127.0.0.1:<random port>` (one per session; no port collisions).
2. `claude` launches with `ANTHROPIC_BASE_URL` pointing at the proxy and a **per-session secret** (generated with `crypto.randomBytes`; it exists only in that `claude`'s environment). How the secret is passed depends on your login (see [claude.ai connectors](#claudeai-connectors-slack--notion-) below):
   - you are signed in to claude.ai (`claude auth status` shows `"authMethod": "claude.ai"`): in an `x-claude-org-secret` header via `ANTHROPIC_CUSTOM_HEADERS`, and `claude` keeps its claude.ai login, so connector MCPs load. Your other `ANTHROPIC_CUSTOM_HEADERS` lines are kept;
   - otherwise (no login, an API key or token in your env, or `CLAUDE_ORG_NO_CONNECTORS=1`): as its bearer token (`ANTHROPIC_AUTH_TOKEN`), as in earlier versions.

   The launch prints which one was used: `-> claude.ai connectors: on (...)` / `off (<reason>)`.
3. The proxy serves only requests that carry that secret, name it in `Host` (`127.0.0.1:<port>`, so a web page cannot reach it by DNS rebinding) and are `GET` / `POST` / `DELETE` under `/v1/`; anything else is refused with 401 / 403 / 404 / 405 and never forwarded. Request bodies over 64 MB get 413.
4. The proxy replaces the `Authorization` header with a real org token (when `claude` keeps its claude.ai login, that login token arrives as `Authorization` and is discarded, never forwarded or logged), drops the `x-claude-org-secret` header and hop-by-hop headers, and forwards to `api.anthropic.com` (any other upstream is refused unless `CLAUDE_ORG_UNSAFE_UPSTREAM=1`). On a 429 or `anthropic-ratelimit-unified-5h-status: rejected` it marks that org limited until `5h-reset` and **resends the same request** with the next org's token. An org whose token is rejected (401: expired or revoked) is skipped the same way for 10 minutes.
5. Claude Code only ever sees the successful response — the org switched mid-session. SSE streaming is piped through untouched. When Claude Code cancels or exits mid-response, the upstream request is cancelled too; an upstream that sends nothing for 10 minutes is given up and the next org tried.

One log line per request (`via <org> model=<model> -> <status>`) goes to a temp file printed at launch (`-> proxy 127.0.0.1:<port> (order: ..., strategy: ..., log: ...)`). The prompt and the tokens are never logged.

**Spreading load by utilization**: with `CLAUDE_ORG_STRATEGY=least-utilized`, the proxy remembers the `5h-utilization` each org last reported and sends each request to the usable org with the lowest value. An org that has not reported yet is tried first (in priority order) so it gets measured once; one that answers without a utilization goes after the measured ones. A value is forgotten when that org's 5h window resets. Rate-limited orgs are still skipped. Utilization is a share of each org's own plan, not an absolute amount, so a larger plan is picked more often; if you want one org's allowance used up first (e.g. your company's), keep the default and set `CLAUDE_ORG_ORDER` instead.

**Which org is in use right now**: after each model request the proxy writes `{"org", "model", "status", "at"}` as JSON (`org` is `null` with `status` 503 when no org could serve) to `state.json` in the same temp directory as the log. Its path is exported to the `claude` process as `CLAUDE_ORG_STATE_FILE`, so a statusline command or hook can show it, e.g.:

```sh
[ -n "$CLAUDE_ORG_STATE_FILE" ] && [ -f "$CLAUDE_ORG_STATE_FILE" ] && node -p "require(process.env.CLAUDE_ORG_STATE_FILE).org"
```

**claude.ai connectors (Slack / Notion / …)**

Claude Code loads claude.ai connector MCPs (Gmail / Drive / Calendar / Notion / Slack …, `mcp__claude_ai_*`) only while it uses a claude.ai login: when `ANTHROPIC_AUTH_TOKEN` or an API key takes precedence it skips them (its debug log says `[claudeai-mcp] Disabled: API-key auth precedence active`; `ANTHROPIC_BASE_URL` alone does not disable them). So when you are signed in to claude.ai, `claude-org proxy` leaves the login in place and passes its secret in a header instead, and connectors work in proxy sessions:

- Connectors are those of your **claude.ai login** (the default org), whichever org the proxy sends model requests to. Their calls go from Claude Code straight to Anthropic, not through the proxy.
- The launch asks `claude auth status` first (about one second). If you are not signed in, have an API key or token in your env, or the check fails, the session starts the earlier way (Bearer secret, no connectors) and the launch line says why.
- `CLAUDE_ORG_NO_CONNECTORS=1` forces the earlier way. The session gets `CLAUDE_ORG_CONNECTORS=1` or `0` so hooks can tell which one it is.
- Claude Code may also send custom headers to other Anthropic endpoints. The secret is accepted only by this session's loopback proxy and is worthless once it exits.

**Claude in Chrome (browser automation)**

Claude in Chrome (`claude --chrome`, the `mcp__claude-in-chrome__*` tools) passes the same check as connectors: Claude Code does not start it while `ANTHROPIC_AUTH_TOKEN` takes precedence, and it also needs an OAuth token with a scope the Chrome extension accepts, which a claude.ai login has (measured with Claude Code 2.1.310). So it works in proxy sessions that kept the claude.ai login (launch line `claude.ai connectors: on`), and not otherwise:

- It drives the Chrome extension paired with your **claude.ai login** (the default org), while model requests go to whichever org the proxy picks. Page content the browser reads is processed under that org's token.
- It can pick a Chrome on another machine signed in to the same claude.ai account. Check `onThisComputer` in `list_connected_browsers` before driving a browser.
- To re-check after a Claude Code update: `claude-org proxy -p "reply ok" --chrome --debug-file dbg.log`, then look for `In-process Chrome MCP server started` in `dbg.log`.

**Limitations of proxy mode**

- Without a claude.ai login (see above), claude.ai connector MCPs, Claude in Chrome and Remote Control are **unavailable**. Local/plugin MCPs work either way. Open connectors in a plain `claude --resume` session — history is shared.
- Each proxy serves one session and dies when `claude` exits.

**Subagents**

- Subagents started with Claude Code's Agent tool run in the same process as the parent session and share its `ANTHROPIC_BASE_URL`, so they go through the same proxy with no setup and use the same orgs' limits. Their requests appear in the proxy log with their own `model=` (e.g. a Haiku subagent).
- Not covered: a `claude` started as a separate process (it needs its own `claude-org proxy`), and agents that run in the cloud (e.g. `isolation: remote`).
- Subagents get the same connector MCPs as the parent session (none when it started without a claude.ai login).
- When an org's 5h or 7d window is rejected, the org is taken out for every model, so subagents also move to the next org until the window resets. A 429 for one model only (#8) moves that model only; other models, including those of subagents, stay on the org.
- Work routed to a Team / Enterprise org (e.g. your company's) counts toward that org's usage, which its admins can see.

### Prompt cache & tool search

A custom `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (the mode without a claude.ai login) makes Claude Code treat the session as API-key auth, which changes two defaults:

- **Prompt cache TTL drops to 5 minutes** (subscription-direct sessions get 1 hour). The 1-hour TTL is requested via the `anthropic-beta` header, which the proxy forwards unchanged.
- **MCP tool search** (deferred tool-definition loading) is **disabled**.

`claude-org proxy` restores the subscription-equivalent behavior by launching `claude` with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` and `ENABLE_TOOL_SEARCH=true` (in both modes). If you have set either variable yourself, your value wins.

| Entry point | Mid-session switch | Connector MCPs | Claude in Chrome | Best for |
|---|---|---|---|---|
| `claude` | no (default org) | yes | yes | connector work |
| `claude-org auto --resume` | at launch only | no on preferred org / yes on default | no on preferred org / yes on default (expected; a `claude setup-token` token lacks the scope the extension accepts) | short tasks |
| `claude-org proxy --resume` | **automatic** | yes with a claude.ai login (those of the login) / no otherwise | yes with a claude.ai login / no otherwise | long-running work, agents, unattended runs |

### Unattended use (supervisors, `--dangerously-skip-permissions`)

When a supervisor starts `claude` without a person watching (e.g. `claude -p` with `--dangerously-skip-permissions`), launch it through `claude-org proxy`, not `claude-org <org>` / `auto`:

- **Use proxy mode only.** `claude-org <org>` and `auto` put the org token into `claude`'s environment as `CLAUDE_CODE_OAUTH_TOKEN`, where a prompt-injected `claude` can read it. In proxy mode the org tokens stay in the launcher process; `claude` only holds the per-session proxy secret, which is worth nothing outside that session (and, when you are signed in to claude.ai, its own claude.ai login, which it has without claude-org too; set `CLAUDE_ORG_NO_CONNECTORS=1` if the unattended session should not use the login).
- **Signals.** The launcher forwards `SIGTERM` / `SIGHUP` (and `SIGINT` when it has no terminal) to `claude`, waits for it to exit, and reports its exit code (`128+signal` when killed); after 10 s it sends `SIGKILL`. So a supervisor that kills the launcher pid does not leave an orphaned `claude`, and the proxy lives exactly as long as `claude` does. With a terminal, Ctrl-C goes to `claude` only (the launcher stays until `claude` exits).
- **Keep the token files away from `claude`'s shell.** A `claude` running with permissions skipped can `cat ~/.claude/org-tokens/*.token` from Bash. The proxy refuses token files that are not mode `0600` and owned by you, but that does not stop your own `claude`. Deny the directory to sandboxed commands and to the Read tool in the settings of the project the unattended session runs in (both are needed: the sandbox covers shell commands only, the Read tool follows permission rules):

  ```json
  {
    "permissions": { "deny": ["Read(~/.claude/org-tokens/**)"] },
    "sandbox": {
      "enabled": true,
      "credentials": { "files": [{ "path": "~/.claude/org-tokens", "mode": "deny" }] }
    }
  }
  ```

  Source: Claude Code docs, [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing) (`sandbox.credentials.files` with `"mode": "deny"` applies the same read block as `sandbox.filesystem.denyRead`; the sandbox runs on macOS, Linux and WSL2, not native Windows). Running the proxy as a separate daemon under another user would close the gap fully; it is not implemented, and would build on the shared proxy discussed in #14 / #18.
- **Detecting "no org works" from outside.** The proxy log (path on the `-> proxy` launch line) has one fixed-format line per such event, so a supervisor or a notifier can grep for `ALERT `:

  | Line | Meaning |
  |---|---|
  | `ALERT token-rejected org=<org> status=401 -> run: claude setup-token ...` | that org's token is expired or revoked; the org is skipped for 10 min |
  | `ALERT no-org-available model=<model> reason=rate-limited status=429` | every org is over its window; the 429 went to `claude` |
  | `ALERT no-org-available model=<model> reason=model-rejected status=429` | every org refuses this model; switch the model |
  | `ALERT no-org-available model=<model> reason=unreachable status=503` | no org answered (network, timeouts, bad token files) |
  | `ALERT no-org-available model=<model> reason=no-tokens status=503` | the token dir is missing or has no usable `.token` file |

  The state file (`CLAUDE_ORG_STATE_FILE`) records the same outcome as `status` (`503` with `"org": null`, or `401` with the org).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_ORG_PREFER` | (unset) | Preferred org for `auto` / `watch` / `proxy` |
| `CLAUDE_ORG_ORDER` | (unset) | Comma-separated org priority for `proxy`; unlisted orgs follow alphabetically |
| `CLAUDE_ORG_STRATEGY` | (unset: priority order) | `least-utilized`: `proxy` sends each request to the usable org with the lowest 5h utilization (see proxy mode) |
| `CLAUDE_ORG_PROBE_MODEL` | (unset: Haiku) | Model used by `probe` / `status` / `auto` to check the org; adds `model_status=` to the probe line |
| `CLAUDE_ORG_TOKEN_DIR` | `~/.claude/org-tokens` | Where `<name>.token` files live |
| `CLAUDE_ORG_NOTIFY_CMD` | (unset) | `watch` notification command, run as `<cmd> "<title>" "<message>"` via the OS shell |
| `CLAUDE_ORG_WATCH_MAX_SLEEP` | `18000` | Max seconds between `watch` re-checks (values < 60 also lower the 60s minimum — for tests) |
| `CLAUDE_ORG_UPSTREAM` | `https://api.anthropic.com` | API base URL for `probe` and `proxy` (stub upstream in tests). `proxy` refuses any other value unless `CLAUDE_ORG_UNSAFE_UPSTREAM=1`, since org tokens are sent there |
| `CLAUDE_ORG_UNSAFE_UPSTREAM` | (unset) | `1` lets `proxy` forward to a `CLAUDE_ORG_UPSTREAM` other than `api.anthropic.com` (tests only) |
| `CLAUDE_ORG_PROXY_SECRET` | (unset) | Standalone `node lib/proxy.js` only: the value clients must send (as `x-claude-org-secret` header or bearer token). `claude-org proxy` generates one per session itself |
| `CLAUDE_ORG_NO_CONNECTORS` | (unset) | `1`: `proxy` always passes the secret as `ANTHROPIC_AUTH_TOKEN` (no claude.ai login check, no connector MCPs, no Claude in Chrome) |
| `CLAUDE_ORG_PROXY` | `1` when launched via `proxy` | Marker env passed to the claude process so user hooks can detect proxy sessions |
| `CLAUDE_ORG_CONNECTORS` | `1` / `0` when launched via `proxy` | Marker env: `1` when the session kept its claude.ai login (connector MCPs and Claude in Chrome can load), `0` otherwise |
| `CLAUDE_ORG_STATE_FILE` | set when launched via `proxy` | Path of the JSON file holding the org and model of the last request (read it from a statusline or hook) |
| `CLAUDE_ORG_FORCE_PROBE` | (unset) | Test seam: `allowed` / `rejected[:<epoch>]` / `rejected_until:<epoch>` fakes `probe` results without API calls |
| `CLAUDE_ORG_REJECT_FILE` | (unset) | Test seam: orgs listed comma-separated in this file are treated as rate-limited by `proxy` |

## Notes

- **Token safety**: tokens are read from files only and never printed to logs, errors, or test snapshots. A token file must be mode `0600` and owned by you (`chmod 600 ~/.claude/org-tokens/*.token`); one that other users can read is refused. Org names are limited to letters, digits, `_` and `-`. The proxy binds to `127.0.0.1` only and serves only the `claude` it launched (see [Unattended use](#unattended-use-supervisors---dangerously-skip-permissions)).
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
