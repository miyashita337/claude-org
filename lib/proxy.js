'use strict';
// Local proxy between Claude Code and the Anthropic API. It rewrites the
// Authorization header to the token of "the org that is currently usable" and,
// when it sees the 5h limit (HTTP 429 or response header
// anthropic-ratelimit-unified-5h-status: rejected), resends the same request
// with the next org's token. A running Claude Code session never sees the 429,
// so the org switches without a restart.
//
// Why a proxy instead of apiKeyHelper: an OAuth long-lived token is accepted as
// `Authorization: Bearer` alone, but if `x-api-key` is also present it is checked
// first and returns 401. The proxy drops x-api-key and sends Bearer only.
//
// Env (standalone mode):
//   PORT                   listen port (default 0 = OS picks; reported on the
//                          "listening on" stderr line)
//   CLAUDE_ORG_TOKEN_DIR   where <name>.token files live (~/.claude/org-tokens)
//   CLAUDE_ORG_ORDER       org priority, comma-separated (default: alphabetical)
//   CLAUDE_ORG_UPSTREAM    forward target (default https://api.anthropic.com)
//   CLAUDE_ORG_REJECT_FILE test seam: orgs listed comma-separated in this file
//                          are treated as rate-limited
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

function createProxy(opts = {}) {
  const TOKEN_DIR = opts.tokenDir || process.env.CLAUDE_ORG_TOKEN_DIR
    || path.join(os.homedir(), '.claude', 'org-tokens');
  const ORDER = opts.order
    || (process.env.CLAUDE_ORG_ORDER || '').split(',').map(s => s.trim()).filter(Boolean);
  const UPSTREAM = new URL(opts.upstream || process.env.CLAUDE_ORG_UPSTREAM || 'https://api.anthropic.com');
  const REJECT_FILE = 'rejectFile' in opts ? opts.rejectFile : (process.env.CLAUDE_ORG_REJECT_FILE || '');
  const out = opts.log || process.stderr;
  const transport = UPSTREAM.protocol === 'http:' ? http : https;

  function log(...a) {
    out.write(`[claude-org-proxy ${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}\n`);
  }

  function listOrgs() {
    const files = fs.readdirSync(TOKEN_DIR).filter(f => f.endsWith('.token')).map(f => f.slice(0, -6)).sort();
    if (ORDER.length === 0) return files;
    const known = new Set(files);
    return ORDER.filter(o => known.has(o)).concat(files.filter(f => !ORDER.includes(f)));
  }
  function readToken(name) {
    return fs.readFileSync(path.join(TOKEN_DIR, `${name}.token`), 'utf8').replace(/[\r\n]/g, '');
  }

  // Per-org "rate-limited" memory: name -> recovery epoch (ms). Expired entries
  // automatically re-enter the candidate pool.
  const rejectedUntil = new Map();
  function fileRejected(name) {
    if (!REJECT_FILE) return false;
    try {
      return fs.readFileSync(REJECT_FILE, 'utf8').split(',').map(s => s.trim()).includes(name);
    } catch {
      return false;
    }
  }
  function isRejected(name) {
    if (fileRejected(name)) return true;
    const until = rejectedUntil.get(name);
    if (until === undefined) return false;
    if (Date.now() >= until) { rejectedUntil.delete(name); return false; }
    return true;
  }
  // Usable orgs first, in priority order; rate-limited orgs are moved to the
  // tail (kept as a last resort when everything is limited).
  function pickOrder() {
    const orgs = listOrgs();
    return orgs.filter(o => !isRejected(o)).concat(orgs.filter(o => isRejected(o)));
  }

  function forward(org, method, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
      const h = { ...headers };
      for (const k of Object.keys(h)) {
        const lk = k.toLowerCase();
        if (lk === 'x-api-key' || lk === 'host' || lk === 'content-length' || lk === 'authorization') delete h[k];
      }
      h.authorization = `Bearer ${readToken(org)}`;
      h.host = UPSTREAM.host;
      if (body.length) h['content-length'] = String(body.length);
      const req = transport.request(
        { hostname: UPSTREAM.hostname, port: UPSTREAM.port || (transport === https ? 443 : 80), path: urlPath, method, headers: h },
        res => resolve(res),
      );
      req.on('error', reject);
      if (body.length) req.write(body);
      req.end();
    });
  }

  const server = http.createServer((clientReq, clientRes) => {
    const chunks = [];
    clientReq.on('data', c => chunks.push(c));
    clientReq.on('end', async () => {
      const body = Buffer.concat(chunks);
      const isModelReq = clientReq.url.startsWith('/v1/messages');
      const order = pickOrder();
      let attempt = 0;
      for (const org of order) {
        attempt++;
        let up;
        try {
          up = await forward(org, clientReq.method, clientReq.url, clientReq.headers, body);
        } catch (e) {
          log(`upstream error via ${org}: ${e.message}`);
          continue;
        }
        const status5h = up.headers['anthropic-ratelimit-unified-5h-status'];
        const reset5h = Number(up.headers['anthropic-ratelimit-unified-5h-reset']);
        const limited = up.statusCode === 429 || status5h === 'rejected';
        if (limited && isModelReq && attempt < order.length) {
          rejectedUntil.set(org, Number.isFinite(reset5h) ? reset5h * 1000 : Date.now() + 10 * 60 * 1000);
          log(`${org} is rate-limited (HTTP ${up.statusCode}, 5h=${status5h ?? '?'}) -> retrying with next org`);
          up.resume(); // discard the response body and try the next org
          continue;
        }
        if (isModelReq) {
          const util = up.headers['anthropic-ratelimit-unified-5h-utilization'];
          log(`${clientReq.method} ${clientReq.url} via ${org} -> ${up.statusCode} (5h ${status5h ?? '?'} ${util ?? '?'})`);
        }
        clientRes.writeHead(up.statusCode, { ...up.headers, 'x-claude-org': org });
        up.pipe(clientRes); // SSE streaming is piped through untouched
        return;
      }
      clientRes.writeHead(503, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ type: 'error', error: { type: 'claude_org_proxy', message: 'all orgs rate-limited or unreachable' } }));
    });
  });

  return { server, listOrgs, log, upstream: UPSTREAM };
}

// `claude-org proxy [claude args...]`: start an in-process proxy on a random
// port, point ANTHROPIC_BASE_URL at it, launch claude, and shut the proxy down
// when claude exits. One proxy per session, so parallel sessions never collide.
async function proxyLaunch(args) {
  const { listOrgs, tokenDir, resolvePrefer } = require('./config');
  const { runClaude } = require('./launch');

  const orgs = listOrgs();
  if (orgs.length < 2) {
    console.error(`claude-org: proxy には org トークンが 2 つ以上必要です（${tokenDir()} に ${orgs.join(' ')}）`);
    console.error(`  取得: claude setup-token でもう片方の org を選び、${tokenDir()}/<name>.token に保存`);
    return 1;
  }

  const order = process.env.CLAUDE_ORG_ORDER || resolvePrefer();
  const logf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-org-proxy-')), 'proxy.log');
  const logStream = fs.createWriteStream(logf);
  const { server, log, upstream } = createProxy({ order: order.split(','), log: logStream });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        log(`listening on http://127.0.0.1:${server.address().port} orgs=${listOrgs().join(',')} upstream=${upstream.host}`);
        resolve();
      });
    });
  } catch (e) {
    console.error(`claude-org: proxy が起動しませんでした: ${e.message}`);
    return 1;
  }
  const port = server.address().port;
  console.error(`-> proxy 127.0.0.1:${port} (order: ${order}, log: ${logf})`);

  // A custom ANTHROPIC_BASE_URL + AUTH_TOKEN makes Claude Code treat the session
  // as API-key auth: prompt cache TTL drops to 5min and MCP tool search is
  // disabled. Restore subscription-equivalent defaults; user-set values win.
  const envExtra = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: 'claude-org-proxy', // dummy; the proxy replaces it
    CLAUDE_ORG_PROXY: '1',                    // marker: "connector MCPs unavailable" session
  };
  if (!process.env.CLAUDE_CODE_PROMPT_CACHE_TTL) envExtra.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h';
  if (!process.env.ENABLE_TOOL_SEARCH) envExtra.ENABLE_TOOL_SEARCH = 'true';

  const rc = await runClaude(args, envExtra);
  server.close();
  logStream.end();
  return rc;
}

// Standalone mode: `node lib/proxy.js` (env-driven, same as the bash version's
// `node claude-org-proxy.js`).
if (require.main === module) {
  const PORT = Number(process.env.PORT || 0);
  const { server, listOrgs, log, upstream } = createProxy();
  server.listen(PORT, '127.0.0.1', () => {
    log(`listening on http://127.0.0.1:${server.address().port} orgs=${listOrgs().join(',')} upstream=${upstream.host}`);
  });
}

module.exports = { createProxy, proxyLaunch };
