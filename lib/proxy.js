'use strict';
// Local proxy between Claude Code and the Anthropic API. It rewrites the
// Authorization header to the token of "the org that is currently usable" and,
// when it sees the 5h limit (HTTP 429 or response header
// anthropic-ratelimit-unified-5h-status: rejected), resends the same request
// with the next org's token. A running Claude Code session never sees the 429,
// so the org switches without a restart.
//
// Not every 429 means the org is used up. A model can have its own limit (for
// example a per-model weekly allowance, or usage credits that the org has not
// enabled) while the 5h and 7d windows are still "allowed" and other models
// work. Such a 429 only takes that org out for that model; the org keeps
// serving other models.
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
const zlib = require('zlib');

// How long an org stays out when it is org-wide limited but sent no reset time,
// and the longest a model-specific refusal keeps an (org, model) pair out.
const ORG_REJECT_FALLBACK_MS = 10 * 60 * 1000;
const MODEL_REJECT_MAX_MS = 10 * 60 * 1000;
// A real 429 body is well under 1 KiB. These caps keep a misbehaving upstream
// from exhausting memory: the raw body read, and the decompressed copy.
const ERROR_BODY_MAX_BYTES = 1024 * 1024;
const ERROR_DECODED_MAX_BYTES = 64 * 1024;

// The "model" field of a /v1/messages request body, or '?' when the body is
// not JSON (the proxy must still forward it). Used as is as the quarantine
// key, so two different model names never share a key.
function requestModel(body) {
  try {
    const m = JSON.parse(body.toString('utf8')).model;
    return typeof m === 'string' && m ? m : '?';
  } catch {
    return '?';
  }
}

// The model name for the log: client input, so limited to safe characters and
// cut short.
function logModel(model) {
  return model.replace(/[^\w.:@/-]/g, '_').slice(0, 80);
}

// Milliseconds from a Retry-After header, which is either delay-seconds or an
// HTTP-date. NaN when absent or unparsable.
function retryAfterMs(value) {
  if (value === undefined || value === '') return NaN;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : NaN;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : NaN;
}

function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', c => {
      size += c.length;
      if (size > maxBytes) {
        res.destroy();
        reject(new Error(`429 body larger than ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

// The API compresses error bodies (brotli was observed on 2026-10-10) when the
// client sent accept-encoding. Decode a copy for the log; the client still
// gets the original bytes with the original content-encoding header.
// maxOutputLength makes a decompression bomb throw instead of filling memory.
function decodeBody(buf, encoding) {
  const opts = { maxOutputLength: ERROR_DECODED_MAX_BYTES };
  switch ((encoding || '').trim().toLowerCase()) {
    case 'br': return zlib.brotliDecompressSync(buf, opts);
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(buf, opts);
    case 'deflate': return zlib.inflateSync(buf, opts);
    default: return buf;
  }
}

// "error.type: error.message" from an API error body, for the log line. The
// message is cut short; the full body still reaches the client.
function describeError(buf, encoding) {
  try {
    const e = JSON.parse(decodeBody(buf, encoding).toString('utf8')).error || {};
    const msg = String(e.message || '').replace(/\s+/g, ' ').slice(0, 160);
    return msg ? `${e.type || 'unknown_error'}: ${msg}` : (e.type || 'unknown_error');
  } catch {
    return 'non-JSON 429 body';
  }
}

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
  // Per-(org, model) memory for model-specific refusals: "org|model" -> epoch (ms).
  const modelRejectedUntil = new Map();
  function isModelRejected(name, model) {
    const key = `${name}|${model}`;
    const until = modelRejectedUntil.get(key);
    if (until === undefined) return false;
    if (Date.now() >= until) { modelRejectedUntil.delete(key); return false; }
    return true;
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
  function pickOrder(model) {
    const orgs = listOrgs();
    const blocked = o => isRejected(o) || isModelRejected(o, model);
    return orgs.filter(o => !blocked(o)).concat(orgs.filter(blocked));
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
      const model = isModelReq ? requestModel(body) : '';
      const order = pickOrder(model);
      let attempt = 0;
      let modelRefusals = 0;
      for (const org of order) {
        attempt++;
        let up;
        try {
          up = await forward(org, clientReq.method, clientReq.url, clientReq.headers, body);
        } catch (e) {
          log(`upstream error via ${org}: ${e.message}`);
          continue;
        }
        const hdr = name => up.headers[`anthropic-ratelimit-unified-${name}`];
        const status5h = hdr('5h-status');
        const status7d = hdr('7d-status');
        const claim = hdr('representative-claim');
        // The 5h and 7d windows cover every model of the org, so only those make
        // the org as a whole unusable. Other refusals are per model: a used-up
        // per-model weekly allowance (claim=seven_day_overage_included) or a model
        // that needs usage credits (429 with no window headers). The overall
        // "unified-status" header is not used: it also reads "rejected" for those.
        const orgWide = status5h === 'rejected' || status7d === 'rejected';
        const limited = up.statusCode === 429 || orgWide;
        const windows = `5h=${status5h ?? '?'}${claim ? `, claim=${claim}` : ''}`;
        // A 429 body is a small JSON error; buffer it to log the reason and,
        // if no org is left, to hand it to the client unchanged.
        let errBody = null;
        let reason = '';
        if (isModelReq && up.statusCode === 429) {
          try {
            errBody = await readBody(up, ERROR_BODY_MAX_BYTES);
          } catch (e) {
            log(`upstream error via ${org} while reading 429 body: ${e.message}`);
            continue;
          }
          reason = describeError(errBody, up.headers['content-encoding']);
        }
        const modelRefused = isModelReq && up.statusCode === 429 && !orgWide;
        if (modelRefused) {
          // retry-after is honoured when shorter (a transient per-minute limit
          // must not keep the preferred org out for long); a long one (a weekly
          // per-model allowance) is capped so the org is re-checked now and then.
          const ra = retryAfterMs(up.headers['retry-after']);
          const ms = Number.isFinite(ra) ? Math.min(ra, MODEL_REJECT_MAX_MS) : MODEL_REJECT_MAX_MS;
          modelRejectedUntil.set(`${org}|${model}`, Date.now() + ms);
        }
        const isLast = attempt >= order.length;
        if (limited && isModelReq && !isLast) {
          if (orgWide) {
            // When both windows are rejected the org is back only after the later reset.
            const resets = [['5h', status5h], ['7d', status7d]]
              .filter(([, s]) => s === 'rejected')
              .map(([w]) => Number(hdr(`${w}-reset`)))
              .filter(Number.isFinite);
            rejectedUntil.set(org, resets.length ? Math.max(...resets) * 1000 : Date.now() + ORG_REJECT_FALLBACK_MS);
            log(`${org} is rate-limited (HTTP ${up.statusCode}, ${windows}) -> retrying with next org${reason ? ` (${reason})` : ''}`);
          } else {
            modelRefusals++;
            log(`${org} rejected model ${logModel(model)} (HTTP ${up.statusCode}, ${windows}, ${reason}) -> retrying with next org; ${org} stays in use for other models`);
          }
          if (!errBody) up.resume(); // discard the response body and try the next org
          continue;
        }
        if (isModelReq) {
          const util = hdr('5h-utilization');
          log(`${clientReq.method} ${clientReq.url} via ${org} -> ${up.statusCode} (5h ${status5h ?? '?'} ${util ?? '?'})${reason ? ` ${reason}` : ''}`);
          if (modelRefused && modelRefusals === attempt - 1) {
            log(`all orgs rejected model ${logModel(model)} -> switch the model (e.g. /model) or wait for that model's limit to reset; the org tokens are not the cause`);
          }
        }
        clientRes.writeHead(up.statusCode, { ...up.headers, 'x-claude-org': org });
        if (errBody) {
          clientRes.end(errBody);
        } else {
          up.pipe(clientRes); // SSE streaming is piped through untouched
        }
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
