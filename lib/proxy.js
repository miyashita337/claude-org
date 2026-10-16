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
// The proxy holds org tokens, so it only serves the one claude it was started
// for: each request must carry a per-session secret (Authorization: Bearer,
// what claude sends for ANTHROPIC_AUTH_TOKEN), name the proxy itself in Host
// (no DNS rebinding from a browser), and be a GET/POST/DELETE under /v1/.
//
// Env (standalone mode):
//   PORT                     listen port (default 0 = OS picks; reported on the
//                            "listening on" stderr line)
//   CLAUDE_ORG_PROXY_SECRET  the Bearer value clients must send (required)
//   CLAUDE_ORG_TOKEN_DIR     where <name>.token files live (~/.claude/org-tokens)
//   CLAUDE_ORG_ORDER         org priority, comma-separated (default: alphabetical)
//   CLAUDE_ORG_STRATEGY      "least-utilized": prefer the usable org with the
//                            lowest 5h utilization seen so far (default: ORDER)
//   CLAUDE_ORG_UPSTREAM      forward target (default https://api.anthropic.com;
//                            anything else needs CLAUDE_ORG_UNSAFE_UPSTREAM=1)
//   CLAUDE_ORG_REJECT_FILE   test seam: orgs listed comma-separated in this file
//                            are treated as rate-limited
//   CLAUDE_ORG_STATE_FILE    where the org and model of the last /v1/messages
//                            response are written as JSON (unset: not written)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { validOrgName, tokenFileProblem } = require('./config');

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
// How long an org stays out when it is org-wide limited but sent no reset time,
// and the longest a model-specific refusal keeps an (org, model) pair out.
const ORG_REJECT_FALLBACK_MS = 10 * 60 * 1000;
const MODEL_REJECT_MAX_MS = 10 * 60 * 1000;
// A real 429 body is well under 1 KiB. These caps keep a misbehaving upstream
// from exhausting memory: the raw body read, and the decompressed copy.
const ERROR_BODY_MAX_BYTES = 1024 * 1024;
const ERROR_DECODED_MAX_BYTES = 64 * 1024;
// The request body is buffered whole (it may be resent to another org). The
// API's own limit is 32 MB; this cap only keeps a runaway client from filling
// memory.
const REQUEST_BODY_MAX_BYTES = 64 * 1024 * 1024;
// Idle time on the upstream connection (no bytes in either direction) after
// which the request is given up and the next org tried. Claude Code's own
// API_TIMEOUT_MS defaults to the same 10 minutes.
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE']);
// Hop-by-hop headers (RFC 9110 §7.6.1) describe one connection and must not be
// forwarded; the body is re-framed by this proxy anyway.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade']);

// A copy of `headers` without the hop-by-hop ones and those the Connection
// header names.
function stripHopByHop(headers) {
  const named = new Set(String(headers.connection || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (!HOP_BY_HOP.has(lk) && !named.has(lk)) out[k] = v;
  }
  return out;
}

// Constant-time comparison that does not leak the secret's length either.
function secretMatches(given, secret) {
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(given), h(secret));
}

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

// Client input for the log: limited to safe characters and cut short.
function logModel(model) {
  return model.replace(/[^\w.:@/-]/g, '_').slice(0, 80);
}
// The query string is dropped: a client may put secrets there, and the log
// only needs to show which path was refused.
function logPath(url) {
  const s = String(url);
  const q = s.indexOf('?');
  return (q === -1 ? s : s.slice(0, q) + '?...').replace(/[^\w.:@/?-]/g, '_').slice(0, 120);
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
    // destroy() without an error (the client went away) emits neither
    res.on('close', () => reject(new Error('upstream closed before the 429 body ended')));
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
  const UPSTREAM = new URL(opts.upstream || process.env.CLAUDE_ORG_UPSTREAM || DEFAULT_UPSTREAM);
  const REJECT_FILE = 'rejectFile' in opts ? opts.rejectFile : (process.env.CLAUDE_ORG_REJECT_FILE || '');
  const STATE_FILE = 'stateFile' in opts ? opts.stateFile : (process.env.CLAUDE_ORG_STATE_FILE || '');
  const STRATEGY = 'strategy' in opts ? opts.strategy : (process.env.CLAUDE_ORG_STRATEGY || '');
  const SECRET = 'secret' in opts ? opts.secret : (process.env.CLAUDE_ORG_PROXY_SECRET || '');
  const ALLOW_ANY_UPSTREAM = 'allowAnyUpstream' in opts ? opts.allowAnyUpstream : process.env.CLAUDE_ORG_UNSAFE_UPSTREAM === '1';
  const MAX_BODY = opts.maxBodyBytes || REQUEST_BODY_MAX_BYTES;
  const UPSTREAM_TIMEOUT = opts.upstreamTimeoutMs || UPSTREAM_TIMEOUT_MS;
  const out = opts.log || process.stderr;
  const transport = UPSTREAM.protocol === 'http:' ? http : https;

  // Org tokens go to the upstream as Bearer, so the upstream is pinned to the
  // real API unless a test says otherwise.
  if (UPSTREAM.href !== `${DEFAULT_UPSTREAM}/` && !ALLOW_ANY_UPSTREAM) {
    throw new Error(`CLAUDE_ORG_UPSTREAM=${UPSTREAM.href} is not ${DEFAULT_UPSTREAM}; org tokens are only sent there (set CLAUDE_ORG_UNSAFE_UPSTREAM=1 for a test upstream)`);
  }
  if (!SECRET) {
    throw new Error('proxy secret missing: set CLAUDE_ORG_PROXY_SECRET (claude-org proxy generates one per session)');
  }

  function log(...a) {
    out.write(`[claude-org-proxy ${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}\n`);
  }
  const leastUtilized = STRATEGY === 'least-utilized';
  if (STRATEGY && !leastUtilized) log(`unknown CLAUDE_ORG_STRATEGY "${STRATEGY}" -> using the static order`);

  const reportedBadNames = new Set();
  function listOrgs() {
    const names = fs.readdirSync(TOKEN_DIR).filter(f => f.endsWith('.token')).map(f => f.slice(0, -6));
    for (const n of names) {
      if (validOrgName(n) || reportedBadNames.has(n)) continue;
      reportedBadNames.add(n);
      log(`ignoring ${TOKEN_DIR}/${logModel(n)}.token: not an org name (letters, digits, _ and - only)`);
    }
    const files = names.filter(validOrgName).sort();
    if (ORDER.length === 0) return files;
    const known = new Set(files);
    return ORDER.filter(o => known.has(o)).concat(files.filter(f => !ORDER.includes(f)));
  }
  // Throws when the file is missing or not private to the user (S5): the
  // caller skips that org for this request.
  function readToken(name) {
    const f = path.join(TOKEN_DIR, `${name}.token`);
    const problem = tokenFileProblem(f);
    if (problem) throw new Error(`token file ${f} ${problem}`);
    const tok = fs.readFileSync(f, 'utf8').replace(/[\r\n]/g, '');
    if (!tok) throw new Error(`token file ${f} is empty`);
    return tok;
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
  // Latest 5h utilization (0..1) each org reported, valid until that window's
  // reset: name -> { util, until (epoch ms) }. An org that is not picked would
  // otherwise keep its old high value after its window resets.
  const utilization = new Map();
  // Orgs that answered without a utilization header, so they are not put first
  // again and again as "not measured yet".
  const answeredUnmeasured = new Set();
  function utilOf(name) {
    const e = utilization.get(name);
    if (e === undefined) return undefined;
    if (Date.now() >= e.until) { utilization.delete(name); return undefined; }
    return e.util;
  }
  function recordUtil(name, util, reset) {
    const until = Number.isFinite(reset) ? reset * 1000 : Infinity;
    utilization.set(name, { util, until });
    answeredUnmeasured.delete(name);
  }
  // Usable orgs first, in priority order; rate-limited orgs are moved to the
  // tail (kept as a last resort when everything is limited).
  // least-utilized: among the usable orgs, those that have not been measured
  // come first (in priority order) so that each is measured once, then the
  // rest by utilization, lowest first, then those that answered without a
  // utilization. Utilization is a share of each org's own plan, not an
  // absolute amount, so a larger plan is picked more often.
  function pickOrder(model) {
    const orgs = listOrgs();
    const blocked = o => isRejected(o) || isModelRejected(o, model);
    let usable = orgs.filter(o => !blocked(o));
    if (leastUtilized) {
      const known = usable.filter(o => utilOf(o) !== undefined).sort((a, b) => utilOf(a) - utilOf(b));
      const unknown = usable.filter(o => utilOf(o) === undefined);
      usable = unknown.filter(o => !answeredUnmeasured.has(o))
        .concat(known, unknown.filter(o => answeredUnmeasured.has(o)));
    }
    return usable.concat(orgs.filter(blocked));
  }

  // Claude Code does not show the x-claude-org response header, so the org in
  // use is written to a file that a statusline or hook can read. Written via a
  // rename so a reader never sees a half-written file. No prompt or token goes in.
  // The model is stored in full (JSON escapes it), unlike the cut log copy, so
  // two long model names stay distinguishable.
  // On Windows the rename fails while a reader holds the file open; that write
  // is skipped and only the first failure is logged, to keep the log readable.
  let stateWriteFailed = false;
  function writeState(org, model, status) {
    if (!STATE_FILE) return;
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ org, model, status, at: new Date().toISOString() }) + '\n');
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* the tmp file was never created */ }
      if (!stateWriteFailed) log(`cannot write state file ${STATE_FILE}: ${e.message} (further failures are not logged)`);
      stateWriteFailed = true;
    }
  }

  // One upstream request. Resolves with the response once its headers are in;
  // rejects on connection errors, on idle timeout, and when `signal` aborts
  // (the client went away). The response stream can still fail later; the
  // caller listens for that.
  function forward(token, method, urlPath, headers, body, signal) {
    return new Promise((resolve, reject) => {
      const h = stripHopByHop(headers);
      for (const k of Object.keys(h)) {
        const lk = k.toLowerCase();
        if (lk === 'x-api-key' || lk === 'host' || lk === 'content-length' || lk === 'authorization') delete h[k];
      }
      h.authorization = `Bearer ${token}`;
      h.host = UPSTREAM.host;
      if (body.length) h['content-length'] = String(body.length);
      const req = transport.request(
        {
          hostname: UPSTREAM.hostname,
          port: UPSTREAM.port || (transport === https ? 443 : 80),
          path: urlPath,
          method,
          headers: h,
          signal,
          timeout: UPSTREAM_TIMEOUT,
        },
        res => resolve(res),
      );
      req.on('timeout', () => req.destroy(new Error(`no data from upstream for ${UPSTREAM_TIMEOUT} ms`)));
      req.on('error', reject);
      if (body.length) req.write(body);
      req.end();
    });
  }

  function refuse(clientRes, status, message) {
    clientRes.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'claude_org_proxy', message } }));
  }

  // Checks done before any body is read or anything is forwarded. Returns
  // [status, message] for a request to refuse, or null.
  function gate(clientReq) {
    const auth = clientReq.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !secretMatches(auth.slice(7), SECRET)) {
      return [401, 'missing or wrong proxy secret (the Bearer token claude-org proxy gave this session)'];
    }
    const addr = server.address(); // null once the server is closing
    if (!addr) return [503, 'proxy is shutting down'];
    const expectedHost = `127.0.0.1:${addr.port}`;
    if (clientReq.headers.host !== expectedHost) return [403, `Host must be ${expectedHost}`];
    if (!ALLOWED_METHODS.has(clientReq.method)) return [405, `method ${clientReq.method} is not forwarded`];
    // The path is forwarded as is, so nothing that an upstream could
    // normalise out of /v1/ ("..", "//", "\\", %2e) is accepted.
    const pathOnly = clientReq.url.split('?')[0];
    if (!pathOnly.startsWith('/v1/') || /\.\.|\/\/|\\|%2e/i.test(pathOnly)) return [404, 'only /v1/* is forwarded'];
    const announced = Number(clientReq.headers['content-length']);
    if (announced > MAX_BODY) return [413, `request body larger than ${MAX_BODY} bytes`];
    return null;
  }

  async function handle(clientReq, clientRes, body) {
    // The client going away (Claude Code cancelled, or exited) cancels the
    // upstream request in flight and stops a response being piped, so no org
    // keeps generating for nobody.
    const abort = new AbortController();
    let clientGone = false;
    let up = null;
    clientRes.on('close', () => {
      if (clientRes.writableFinished) return;
      clientGone = true;
      abort.abort();
      if (up) up.destroy();
    });
    const isModelReq = clientReq.url.startsWith('/v1/messages');
    const model = isModelReq ? requestModel(body) : '';
    let order;
    try {
      order = pickOrder(model);
    } catch (e) {
      log(`cannot list orgs in ${TOKEN_DIR}: ${e.message}`);
      order = [];
    }
    let attempt = 0;
    let modelRefusals = 0;
    for (const org of order) {
      attempt++;
      if (clientGone) return;
      let token;
      try {
        token = readToken(org);
      } catch (e) {
        log(`skipping ${org}: ${e.message}`);
        continue;
      }
      try {
        up = await forward(token, clientReq.method, clientReq.url, clientReq.headers, body, abort.signal);
      } catch (e) {
        if (clientGone) return;
        log(`upstream error via ${org}: ${e.message}`);
        continue;
      }
      // A response that fails after its headers (idle timeout, reset) is only
      // logged here; whether the client is cut off is decided where it is piped.
      up.on('error', e => log(`upstream error via ${org} while reading the response: ${e.message}`));
      const hdr = name => up.headers[`anthropic-ratelimit-unified-${name}`];
      const status5h = hdr('5h-status');
      const status7d = hdr('7d-status');
      const claim = hdr('representative-claim');
      const util5h = Number(hdr('5h-utilization'));
      if (isModelReq && hdr('5h-utilization') !== undefined && Number.isFinite(util5h)) {
        recordUtil(org, util5h, Number(hdr('5h-reset')));
      } else if (isModelReq) {
        answeredUnmeasured.add(org);
      }
      const isLast = attempt >= order.length;
      // A 401 means the org's token is expired or revoked (they last about a
      // year), not that the request is bad: the org is kept out for a while
      // and the next one tried. The ALERT line is the fixed format a
      // supervisor can watch for (README, "Unattended use").
      if (isModelReq && up.statusCode === 401) {
        log(`ALERT token-rejected org=${org} status=401 -> run: claude setup-token (org ${org}) and overwrite ${path.join(TOKEN_DIR, `${org}.token`)}`);
        rejectedUntil.set(org, Date.now() + ORG_REJECT_FALLBACK_MS);
        if (!isLast) {
          up.resume();
          continue;
        }
      }
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
        log(`${clientReq.method} ${clientReq.url} via ${org} model=${logModel(model)} -> ${up.statusCode} (5h ${status5h ?? '?'} ${util ?? '?'})${reason ? ` ${reason}` : ''}`);
        writeState(org, model, up.statusCode);
        if (modelRefused && modelRefusals === attempt - 1) {
          log(`all orgs rejected model ${logModel(model)} -> switch the model (e.g. /model) or wait for that model's limit to reset; the org tokens are not the cause`);
        }
        if (limited) {
          log(`ALERT no-org-available model=${logModel(model)} reason=${modelRefused ? 'model-rejected' : 'rate-limited'} status=${up.statusCode}`);
        }
      }
      if (clientGone) { up.destroy(); return; }
      clientRes.writeHead(up.statusCode, { ...stripHopByHop(up.headers), 'x-claude-org': org });
      if (errBody) {
        clientRes.end(errBody);
      } else {
        up.once('error', () => clientRes.destroy()); // the client sees a reset, not a truncated OK
        up.pipe(clientRes); // SSE streaming is piped through untouched
      }
      return;
    }
    if (clientGone) return;
    if (isModelReq) {
      writeState(null, model, 503); // no org served it
      log(`ALERT no-org-available model=${logModel(model)} reason=${order.length ? 'unreachable' : 'no-tokens'} status=503`);
    }
    refuse(clientRes, 503, 'all orgs rate-limited or unreachable');
  }

  // Nothing in here may take the process down: with no proxy, every claude
  // behind it is stranded.
  const server = http.createServer((clientReq, clientRes) => {
    try {
      accept(clientReq, clientRes);
    } catch (e) {
      log(`internal error on ${clientReq.method} ${logPath(clientReq.url)}: ${e.stack || e.message}`);
      if (!clientRes.headersSent) refuse(clientRes, 500, 'proxy internal error (see the proxy log)');
      else clientRes.destroy();
    }
  });

  function accept(clientReq, clientRes) {
    clientReq.on('error', e => log(`client request error: ${e.message}`));
    clientRes.on('error', e => log(`client response error: ${e.message}`));
    const denied = gate(clientReq);
    if (denied) {
      log(`refused ${clientReq.method} ${logPath(clientReq.url)}: ${denied[1]} (HTTP ${denied[0]})`);
      refuse(clientRes, denied[0], denied[1]);
      return; // the rest of the request body is discarded by node
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    clientReq.on('data', c => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        log(`refused ${clientReq.method} ${logPath(clientReq.url)}: request body larger than ${MAX_BODY} bytes (HTTP 413)`);
        refuse(clientRes, 413, `request body larger than ${MAX_BODY} bytes`);
        return;
      }
      chunks.push(c);
    });
    clientReq.on('end', () => {
      if (tooLarge) return;
      handle(clientReq, clientRes, Buffer.concat(chunks)).catch(e => {
        log(`internal error on ${clientReq.method} ${logPath(clientReq.url)}: ${e.stack || e.message}`);
        if (!clientRes.headersSent) refuse(clientRes, 500, 'proxy internal error (see the proxy log)');
        else clientRes.destroy();
      });
    });
  }

  return { server, listOrgs, log, upstream: UPSTREAM, strategy: leastUtilized ? 'least-utilized' : 'order' };
}

// `claude-org proxy [claude args...]`: start an in-process proxy on a random
// port, point ANTHROPIC_BASE_URL at it, launch claude, and shut the proxy down
// when claude exits. One proxy per session, so parallel sessions never collide.
// A log that cannot be written (disk full, dir removed) must not take the
// proxy down with an unhandled 'error'. Once it fails, ALERT lines would vanish
// for an unattended session that only watches the log, so they are mirrored to
// stderr from then on.
function guardLogStream(logStream, logf) {
  let logFailed = false;
  logStream.on('error', e => {
    if (!logFailed) console.error(`claude-org: cannot write the proxy log ${logf}: ${e.message}`);
    logFailed = true;
  });
  return {
    write(line) {
      if (!line.includes('ALERT ')) return logStream.write(line);
      // After a confirmed failure, mirror directly (the stream is destroyed and
      // would only call back with an error again).
      if (logFailed) { process.stderr.write(line); return false; }
      // The write that first hits the failure only reports it asynchronously;
      // recover that line from the callback so a one-off ALERT is not lost.
      return logStream.write(line, err => { if (err) process.stderr.write(line); });
    },
  };
}

async function proxyLaunch(args) {
  const { listOrgs, tokenDir, resolvePrefer } = require('./config');
  const { runClaude } = require('./launch');

  // An org whose token file the proxy would refuse (S5) is reported here, at
  // launch, not only in the proxy log after every request has failed.
  const orgs = listOrgs().filter(name => {
    const f = path.join(tokenDir(), `${name}.token`);
    const problem = tokenFileProblem(f);
    if (problem) console.error(`claude-org: skipping org ${name}: token file ${f} ${problem}`);
    return !problem;
  });
  if (orgs.length < 2) {
    console.error(`claude-org: proxy には org トークンが 2 つ以上必要です（${tokenDir()} に ${orgs.join(' ')}）`);
    console.error(`  取得: claude setup-token でもう片方の org を選び、${tokenDir()}/<name>.token に保存`);
    return 1;
  }

  const order = process.env.CLAUDE_ORG_ORDER || resolvePrefer();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-org-proxy-'));
  const logf = path.join(runDir, 'proxy.log');
  const stateFile = path.join(runDir, 'state.json');
  const logStream = fs.createWriteStream(logf);
  const logOut = guardLogStream(logStream, logf);
  // Only this claude may use this proxy (and so the org tokens): it must send
  // this per-session secret as its Bearer token. It goes into the child's env
  // and nowhere else.
  const secret = crypto.randomBytes(32).toString('hex');
  let proxy;
  try {
    proxy = createProxy({ order: order.split(','), log: logOut, stateFile, secret });
  } catch (e) {
    console.error(`claude-org: ${e.message}`);
    logStream.end();
    return 1;
  }
  const { server, log, upstream, strategy } = proxy;

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        log(`listening on http://127.0.0.1:${server.address().port} orgs=${listOrgs().join(',')} upstream=${upstream.host} strategy=${strategy}`);
        resolve();
      });
    });
  } catch (e) {
    console.error(`claude-org: proxy が起動しませんでした: ${e.message}`);
    return 1;
  }
  const port = server.address().port;
  console.error(`-> proxy 127.0.0.1:${port} (order: ${order}, strategy: ${strategy}, log: ${logf})`);

  // A custom ANTHROPIC_BASE_URL + AUTH_TOKEN makes Claude Code treat the session
  // as API-key auth: prompt cache TTL drops to 5min and MCP tool search is
  // disabled. Restore subscription-equivalent defaults; user-set values win.
  const envExtra = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: secret,             // sent as Bearer; the proxy checks it, then swaps in an org token
    CLAUDE_ORG_PROXY: '1',                    // marker: "connector MCPs unavailable" session
    CLAUDE_ORG_STATE_FILE: stateFile,         // last org/model, for statusline and hooks
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
  let proxy;
  try {
    proxy = createProxy();
  } catch (e) {
    console.error(`claude-org-proxy: ${e.message}`);
    process.exit(1);
  }
  const { server, listOrgs, log, upstream, strategy } = proxy;
  server.once('error', e => {
    console.error(`claude-org-proxy: cannot listen on 127.0.0.1:${PORT}: ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    let orgs;
    try { orgs = listOrgs().join(','); } catch (e) { orgs = `<cannot list: ${e.message}>`; }
    log(`listening on http://127.0.0.1:${server.address().port} orgs=${orgs} upstream=${upstream.host} strategy=${strategy}`);
  });
}

module.exports = { createProxy, proxyLaunch, guardLogStream };
