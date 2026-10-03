'use strict';

// Usage text shown for `claude-org` with no args (exit 2) and for
// help/--help/-h (exit 0). Kept compatible with the original bash version.
const USAGE = `claude-org (alias: ccorg): launch Claude Code with a specific org's long-lived token
  (switch between the "default org" login and "token orgs").

Background: when one email has multiple Claude orgs (e.g. a personal org and
your company's org) and you hit the usage limit, you want to continue on the other
org with --resume. Claude Code has no org-switch command, but
CLAUDE_CODE_OAUTH_TOKEN (env) takes precedence over the saved OAuth login
(https://code.claude.com/docs/en/authentication "Authentication precedence").
Get a token per org with \`claude setup-token\` (valid 1 year) and store it as
~/.claude/org-tokens/<name>.token. <name> is any label you choose (e.g. work,
personal). The plain login (no env) org is called "default";
no token file is needed for it.

Usage (<prefer> resolves: CLAUDE_ORG_PREFER -> first of CLAUDE_ORG_ORDER -> first
token org alphabetically):
  claude-org proxy [claude args...]   launch via a local proxy; a running session
                                    fails over to another org the moment the 5h
                                    limit hits (needs 2+ org tokens; claude.ai
                                    connector MCPs are unavailable)
  claude-org auto [claude args...]    launch on <prefer> if usable, else default
                                    (decided once at launch)
  claude-org <name> [claude args...]  e.g. claude-org work --resume
  claude-org probe [<name>]           print the org's 5h window state on one line
                                    (exit 0 when allowed)
  claude-org watch                    wait until <prefer> recovers, then notify
                                    (terminal + optional CLAUDE_ORG_NOTIFY_CMD)
  claude-org status                   show \`claude auth status\` for each org token
  claude-org list                     list saved org names

auto / <name> only read env at launch, so they cannot switch mid-session. To keep
switching while running, use proxy (Claude Code never sees the 429; the proxy
resends on another org).
`;

function printUsage(exitCode) {
  process.stdout.write(USAGE);
  return exitCode;
}

module.exports = { USAGE, printUsage };
