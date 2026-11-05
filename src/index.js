// Garmin personal MCP server for Cloudflare Workers.
//
// What it does: lets an AI assistant (Claude or any MCP client) read YOUR Garmin Connect data through Garmin's
// Personal API. It is read-only (Garmin's personal API cannot change anything)
// and single-owner: connecting requires a passphrase only you know.
//
// No third-party code. Needs:
//   KV namespace binding  OAUTH_KV          (stores sign-in sessions, hashed)
//   secret                GARMIN_API_KEY    (from Garmin Connect > Settings > Personal API Key)
//   secret                OWNER_PASSPHRASE  (a long random phrase you type once when connecting)
//   vars (optional)       TIMEZONE, ALLOWED_REDIRECT_HOSTS, TOKEN_VERSION
//
// To log everyone out instantly: change TOKEN_VERSION. To cut off Garmin data
// instantly: delete the key in Garmin Connect.

const GARMIN = 'https://personal.connectapi.garmin.com';
const GARMIN_TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ACCESS_TTL = 6 * 3600;          // seconds
const REFRESH_TTL = 30 * 24 * 3600;   // seconds
const MAX_FAILED_LOGINS_PER_DAY = 10;
const MAX_REGISTRATIONS_PER_DAY = 50;
const DAY = 864e5;

// ---------- small helpers ----------

const enc = new TextEncoder();
const b64url = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const SEC = {'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {status, headers: {'Content-Type': 'application/json', ...SEC, ...CORS, ...extra}});

class UserError extends Error {}
const userErr = (msg) => new UserError(msg);

function todayIn(env) {
  try {
    return new Intl.DateTimeFormat('en-CA', {timeZone: env.TIMEZONE || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d) => Date.parse(d + 'T00:00:00Z');

// KV counter per UTC day; returns false once `max` is reached.
async function underLimit(env, name, max, bump = true) {
  const key = `count:${name}:${isoDay(Date.now())}`;
  const n = Number(await env.OAUTH_KV.get(key)) || 0;
  if (n >= max) return false;
  if (bump) await env.OAUTH_KV.put(key, String(n + 1), {expirationTtl: 2 * 86400});
  return true;
}
async function bumpCounter(env, name) {
  const key = `count:${name}:${isoDay(Date.now())}`;
  const n = Number(await env.OAUTH_KV.get(key)) || 0;
  await env.OAUTH_KV.put(key, String(n + 1), {expirationTtl: 2 * 86400});
}

// ---------- entry point ----------

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      console.error(e && e.stack ? e.stack : String(e));
      return json({error: 'server_error'}, 500);
    }
  },
};

async function route(req, env) {
  const url = new URL(req.url);
  const origin = url.origin;
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: {...CORS, ...SEC}});
  if (!env.GARMIN_API_KEY || !env.OWNER_PASSPHRASE || !env.OAUTH_KV) {
    return new Response('Not configured: set GARMIN_API_KEY, OWNER_PASSPHRASE and the OAUTH_KV binding.', {status: 503, headers: SEC});
  }

  if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') {
    return json({resource: origin + '/mcp', authorization_servers: [origin], bearer_methods_supported: ['header'], scopes_supported: ['garmin.read']});
  }
  if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/oauth-authorization-server/mcp') {
    return json({
      issuer: origin,
      authorization_endpoint: origin + '/authorize',
      token_endpoint: origin + '/token',
      registration_endpoint: origin + '/register',
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['garmin.read'],
    });
  }
  if (p === '/register' && req.method === 'POST') return register(req, env);
  if (p === '/authorize') return req.method === 'POST' ? authorizePost(req, env, origin) : authorizeGet(env, url);
  if (p === '/token' && req.method === 'POST') return tokenEndpoint(req, env);
  if (p === '/mcp') return mcp(req, env, origin);
  if (p === '/') return new Response('Private Garmin MCP server.', {headers: {'Content-Type': 'text/plain', ...SEC}});
  return new Response('Not found', {status: 404, headers: SEC});
}

// ---------- OAuth: client registration ----------

function redirectAllowed(u, env) {
  try {
    const x = new URL(u);
    const hosts = (env.ALLOWED_REDIRECT_HOSTS || 'claude.ai,claude.com').split(',').map((s) => s.trim()).filter(Boolean);
    if (x.protocol === 'https:' && hosts.some((h) => x.hostname === h || x.hostname.endsWith('.' + h))) return true;
    if (env.ALLOW_LOCALHOST_REDIRECTS === 'true' && x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

async function register(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({error: 'invalid_client_metadata'}, 400); }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 5 || !uris.every((u) => redirectAllowed(u, env))) {
    return json({error: 'invalid_redirect_uri', error_description: 'Redirect URI not allowed for this server.'}, 400);
  }
  if (!(await underLimit(env, 'reg', MAX_REGISTRATIONS_PER_DAY))) return json({error: 'temporarily_unavailable'}, 429);
  const client_id = randomToken(16);
  const client = {redirect_uris: uris, client_name: String(body.client_name || '').slice(0, 100)};
  await env.OAUTH_KV.put('client:' + client_id, JSON.stringify(client), {expirationTtl: 365 * 86400});
  return json({
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.client_name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }, 201);
}

// ---------- OAuth: authorize (passphrase page) ----------

const AUTH_FIELDS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

async function checkAuthParams(env, params) {
  const client = params.client_id ? await env.OAUTH_KV.get('client:' + params.client_id, 'json') : null;
  if (!client) return 'Unknown client. Remove the connector in your app and add it again.';
  if (!params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri) || !redirectAllowed(params.redirect_uri, env)) return 'Redirect URI not allowed.';
  if (params.response_type !== 'code') return 'Unsupported response_type.';
  if (!params.code_challenge || params.code_challenge_method !== 'S256') return 'PKCE (S256) is required.';
  return null;
}

function page(title, inner, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;background:#f6f5f2;color:#1f1e1c;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
main{background:#fff;border:1px solid #e3e0da;border-radius:12px;padding:28px;max-width:380px;width:100%}
h1{font-size:20px;margin:0 0 8px}p{color:#5e5b55;font-size:14px;line-height:1.5}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:16px;margin:8px 0 14px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#1f1e1c;color:#fff;font-size:15px;cursor:pointer}
.err{color:#b3261e}
@media (prefers-color-scheme:dark){body{background:#1c1b19;color:#eee}main{background:#262522;border-color:#3a3833}p{color:#aaa}input[type=password]{background:#1c1b19;color:#eee;border-color:#555}button{background:#eee;color:#111}}
</style></head><body><main>${inner}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      ...SEC,
    },
  });
}

function loginForm(params, error) {
  const hidden = AUTH_FIELDS.map((k) => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join('');
  return page('Connect Garmin', `<h1>Connect your Garmin data</h1>
<p>An app is asking for read-only access to your Garmin Connect data. Enter your owner passphrase to allow it.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/authorize">${hidden}
<label for="pp">Owner passphrase</label>
<input id="pp" type="password" name="passphrase" autocomplete="current-password" required autofocus>
<button type="submit">Allow read-only access</button></form>`, error ? 401 : 200);
}

async function authorizeGet(env, url) {
  const params = Object.fromEntries(AUTH_FIELDS.map((k) => [k, url.searchParams.get(k) || '']));
  const problem = await checkAuthParams(env, params);
  if (problem) return page('Cannot connect', `<h1>Cannot connect</h1><p>${esc(problem)}</p>`, 400);
  return loginForm(params);
}

async function authorizePost(req, env, origin) {
  const fd = await req.formData().catch(() => null);
  if (!fd) return page('Cannot connect', '<h1>Cannot connect</h1><p>Bad request.</p>', 400);
  const params = Object.fromEntries(AUTH_FIELDS.map((k) => [k, String(fd.get(k) || '')]));
  const problem = await checkAuthParams(env, params);
  if (problem) return page('Cannot connect', `<h1>Cannot connect</h1><p>${esc(problem)}</p>`, 400);

  if (!(await underLimit(env, 'fail', MAX_FAILED_LOGINS_PER_DAY, false))) {
    return page('Locked', '<h1>Too many attempts</h1><p>Sign-in is locked until tomorrow (UTC).</p>', 429);
  }
  if (!(await safeEqual(String(fd.get('passphrase') || ''), env.OWNER_PASSPHRASE))) {
    await bumpCounter(env, 'fail');
    return loginForm(params, 'Wrong passphrase.');
  }

  const code = randomToken();
  await env.OAUTH_KV.put('code:' + (await sha256(code)), JSON.stringify({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
  }), {expirationTtl: 600});

  const back = new URL(params.redirect_uri);
  back.searchParams.set('code', code);
  if (params.state) back.searchParams.set('state', params.state);
  back.searchParams.set('iss', origin);
  return new Response(null, {status: 302, headers: {Location: back.toString(), ...SEC}});
}

// ---------- OAuth: token ----------

async function issueTokens(env, client_id) {
  const v = env.TOKEN_VERSION || '1';
  const at = randomToken();
  const rt = randomToken();
  await Promise.all([
    env.OAUTH_KV.put('at:' + (await sha256(at)), JSON.stringify({client_id, v}), {expirationTtl: ACCESS_TTL}),
    env.OAUTH_KV.put('rt:' + (await sha256(rt)), JSON.stringify({client_id, v}), {expirationTtl: REFRESH_TTL}),
  ]);
  return json({access_token: at, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: rt, scope: 'garmin.read'});
}

async function tokenEndpoint(req, env) {
  const ct = req.headers.get('content-type') || '';
  let f = {};
  if (ct.includes('application/json')) f = await req.json().catch(() => ({}));
  else {
    const fd = await req.formData().catch(() => null);
    if (fd) for (const [k, v] of fd.entries()) f[k] = String(v);
  }
  const g = (k) => (f[k] == null ? '' : String(f[k]));
  const bad = (error = 'invalid_grant') => json({error}, 400);

  if (g('grant_type') === 'authorization_code') {
    if (!g('code') || !g('code_verifier') || !g('client_id')) return bad('invalid_request');
    const key = 'code:' + (await sha256(g('code')));
    const rec = await env.OAUTH_KV.get(key, 'json');
    if (!rec) return bad();
    await env.OAUTH_KV.delete(key); // one-time use
    if (g('client_id') !== rec.client_id) return bad();
    if (g('redirect_uri') && g('redirect_uri') !== rec.redirect_uri) return bad();
    if ((await sha256(g('code_verifier'))) !== rec.code_challenge) return bad();
    return issueTokens(env, rec.client_id);
  }

  if (g('grant_type') === 'refresh_token') {
    if (!g('refresh_token')) return bad('invalid_request');
    const key = 'rt:' + (await sha256(g('refresh_token')));
    const rec = await env.OAUTH_KV.get(key, 'json');
    if (!rec || rec.v !== (env.TOKEN_VERSION || '1')) return bad();
    if (g('client_id') && g('client_id') !== rec.client_id) return bad();
    await env.OAUTH_KV.delete(key); // rotate
    return issueTokens(env, rec.client_id);
  }

  return bad('unsupported_grant_type');
}

// ---------- MCP endpoint (Streamable HTTP, JSON responses, stateless) ----------

async function mcp(req, env, origin) {
  const unauth = () => new Response(JSON.stringify({error: 'invalid_token'}), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      ...SEC, ...CORS,
    },
  });
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return unauth();
  const rec = await env.OAUTH_KV.get('at:' + (await sha256(m[1])), 'json');
  if (!rec || rec.v !== (env.TOKEN_VERSION || '1')) return unauth();

  if (req.method !== 'POST') return new Response('Method not allowed', {status: 405, headers: {Allow: 'POST', ...SEC, ...CORS}});

  let msg;
  try { msg = await req.json(); } catch { return json({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}, 400); }
  const batch = Array.isArray(msg);
  const out = [];
  for (const x of batch ? msg : [msg]) {
    const r = await handleRpc(x, env);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, {status: 202, headers: {...SEC, ...CORS}});
  return json(batch ? out : out[0]);
}

const rpcOk = (id, result) => ({jsonrpc: '2.0', id, result});
const rpcErr = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});

async function handleRpc(m, env) {
  if (!m || typeof m !== 'object' || typeof m.method !== 'string') return null; // responses or junk: ignore
  const isNotification = m.id === undefined;
  switch (m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion;
      return rpcOk(m.id, {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'garmin-personal', title: 'Garmin (personal)', version: '1.0.0'},
        instructions: 'Read-only access to the owner\'s own Garmin Connect data. Dates are YYYY-MM-DD in the owner\'s local calendar. Every tool returns {rows:[...]} with flat columns, plus notes when relevant. Distances are km, durations seconds, weights kg.',
      });
    }
    case 'ping':
      return rpcOk(m.id, {});
    case 'tools/list':
      return rpcOk(m.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
        })),
      });
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === (m.params && m.params.name));
      if (!t) return rpcErr(m.id, -32602, 'Unknown tool');
      try {
        const payload = await t.run((m.params && m.params.arguments) || {}, env);
        if (payload && payload.__file) {
          const {__file, ...rest} = payload;
          return rpcOk(m.id, {
            content: [
              {type: 'text', text: JSON.stringify(rest)},
              {type: 'resource', resource: {uri: __file.uri || 'garmin://file', mimeType: __file.mimeType, blob: __file.blob}},
            ],
            structuredContent: rest,
          });
        }
        return rpcOk(m.id, {content: [{type: 'text', text: JSON.stringify(payload)}], structuredContent: payload});
      } catch (e) {
        if (!(e instanceof UserError)) console.error(e && e.stack ? e.stack : String(e));
        const text = e instanceof UserError ? e.message : 'The request to Garmin failed.';
        return rpcOk(m.id, {content: [{type: 'text', text}], isError: true});
      }
    }
    default:
      return isNotification ? null : rpcErr(m.id, -32601, 'Method not found');
  }
}

// ---------- Garmin client ----------

let garminTok = null; // cached per Worker instance: {token, exp}

async function garminToken(env, force) {
  if (!force && garminTok && garminTok.exp > Date.now() + 60_000) return garminTok.token;
  let r;
  for (let i = 0; i < 4; i++) {
    r = await fetch(GARMIN + GARMIN_TOKEN_PATH, {method: 'POST', headers: {Authorization: 'ApiKey ' + env.GARMIN_API_KEY, Accept: '*/*'}});
    if (r.status !== 429 || i === 3) break;
    await sleepMs(1500 * (i + 1));
  }
  if (r.status === 401 || r.status === 403) throw userErr('Garmin rejected the API key. It may have expired or been deleted: create a new key in Garmin Connect and update the GARMIN_API_KEY secret.');
  if (!r.ok) throw userErr(`Garmin's token service answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const txt = await r.text();
  let token = null;
  let ttl = null;
  try {
    const j = JSON.parse(txt);
    if (typeof j === 'string') token = j;
    else {
      token = j.access_token || j.accessToken || j.token || null;
      ttl = Number(j.expires_in || j.expiresIn) || null;
    }
  } catch {
    token = txt.trim() || null;
  }
  if (!token) throw userErr('Garmin\'s token response was not understood.');
  garminTok = {token, exp: Date.now() + Math.min((ttl || 86400) * 1000, 23 * 3600 * 1000)};
  return token;
}

// Answers are remembered so that opening a dashboard again doesn't hit Garmin again:
// in memory for 5 minutes, and in KV for 6 hours when the request only covers past days.
const memo = new Map();
const MEMO_MS = 5 * 60_000;
const PAST_TTL_S = 6 * 3600;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function onlyPastDays(url, env) {
  const today = todayIn(env);
  const dates = (url.match(/\d{4}-\d{2}-\d{2}/g) || []);
  return dates.length > 0 && dates.every((d) => d < today);
}

async function garmin(env, path, query) {
  const u = new URL(GARMIN + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
    else u.searchParams.set(k, String(v));
  }
  const key = u.toString();
  const hit = memo.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const past = onlyPastDays(key, env);
  const kvKey = 'gc:' + (await sha256(key));
  if (past) {
    const cached = await env.OAUTH_KV.get(kvKey, 'json');
    if (cached) { memo.set(key, {exp: Date.now() + MEMO_MS, val: cached.v}); return cached.v; }
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const tok = await garminToken(env, refreshed);
    const r = await fetch(key, {headers: {Authorization: 'Bearer ' + tok, Accept: 'application/json, */*;q=0.8'}});
    if (r.status === 401 && !refreshed) { refreshed = true; continue; } // token expired early: get a new one once
    if (r.status === 429) { // rate limited: back off and try again
      if (attempt < 3) { await sleepMs(1500 * (attempt + 1) + Math.random() * 500); continue; }
      throw userErr('Garmin is rate-limiting requests. Try again in a little while.');
    }
    let val = null;
    if (r.status !== 204 && r.status !== 404) {
      if (!r.ok) throw userErr(`Garmin answered ${r.status} for ${path.split('/')[1]}: ${(await r.text()).slice(0, 200)}`);
      const t = await r.text();
      if (t) { try { val = JSON.parse(t); } catch { throw userErr('Garmin sent a response that is not JSON.'); } }
    }
    memo.set(key, {exp: Date.now() + MEMO_MS, val});
    if (memo.size > 500) memo.delete(memo.keys().next().value);
    if (past) await env.OAUTH_KV.put(kvKey, JSON.stringify({v: val}), {expirationTtl: PAST_TTL_S}).catch(() => {});
    return val;
  }
  throw userErr('Garmin did not accept a fresh token.');
}

// Raw GET for binary answers (activity file download).
async function garminRaw(env, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await garminToken(env, attempt > 0);
    const r = await fetch(GARMIN + path, {headers: {Authorization: 'Bearer ' + tok, Accept: '*/*'}});
    if (r.status === 401 && attempt === 0) continue;
    if (r.status === 404) return null;
    if (r.status === 429) throw userErr('Garmin is rate-limiting requests. Try again in a little while.');
    if (!r.ok) throw userErr(`Garmin answered ${r.status} for ${path.split('/')[1]}: ${(await r.text()).slice(0, 200)}`);
    return {contentType: r.headers.get('content-type') || 'application/octet-stream', disposition: r.headers.get('content-disposition') || '', buf: await r.arrayBuffer()};
  }
  throw userErr('Garmin did not accept a fresh token.');
}

// ---------- shaping data ----------

// Fields never passed on: location, other people, account identifiers.
const DROP = /latitude|longitude|polyline|owner|profileimage|userprofile|displayname|fullname|activitylike|likedby|numberofactivitylikes|comment|uuid|userid|deviceid|unitid|serial/i;
const DROP_NO_LOCATION = /owner|profileimage|userprofile|displayname|fullname|activitylike|likedby|numberofactivitylikes|comment|uuid|userid|deviceid|unitid|serial/i;

// Deep copy without dropped keys (for raw endpoint answers).
function scrub(v, re) {
  if (Array.isArray(v)) return v.map((x) => scrub(x, re));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!re.test(k)) o[k] = scrub(x, re);
    return o;
  }
  return v;
}

function flatten(obj, prefix = '', out = {}, depth = 0, re = DROP) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k)) continue;
    const key = prefix ? `${prefix}_${k}` : k;
    if (v === null || typeof v !== 'object') out[key] = v;
    else if (Array.isArray(v)) {
      if (v.length <= 30 && v.every((x) => x === null || typeof x !== 'object')) out[key] = v.join(',');
    } else if (depth < 3) flatten(v, key, out, depth + 1, re);
  }
  return out;
}

const rnd = (v, d) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(Number(v).toFixed(d)));
const kg = (v) => (v == null || isNaN(Number(v)) ? null : Number(v) > 500 ? rnd(Number(v) / 1000, 2) : rnd(v, 2));
function pace(mps) {
  if (!mps || mps <= 0) return null;
  const s = Math.round(1000 / mps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function slimActivity(a) {
  const type = (a.activityType && a.activityType.typeKey) || null;
  const sp = Number(a.averageSpeed) || null;
  const footSport = /running|walking|hiking|trail/.test(type || '');
  return {
    activity_id: a.activityId ?? null,
    name: a.activityName ?? null,
    type,
    start_local: a.startTimeLocal ?? null,
    distance_km: a.distance == null ? null : rnd(a.distance / 1000, 3),
    duration_s: rnd(a.duration, 0),
    moving_duration_s: rnd(a.movingDuration, 0),
    elapsed_duration_s: rnd(a.elapsedDuration, 0),
    avg_speed_kmh: sp ? rnd(sp * 3.6, 2) : null,
    avg_pace_min_per_km: footSport ? pace(sp) : null,
    elevation_gain_m: rnd(a.elevationGain, 1),
    avg_hr_bpm: rnd(a.averageHR, 0),
    max_hr_bpm: rnd(a.maxHR, 0),
    hr_zone_1_s: rnd(a.hrTimeInZone_1, 0),
    hr_zone_2_s: rnd(a.hrTimeInZone_2, 0),
    hr_zone_3_s: rnd(a.hrTimeInZone_3, 0),
    hr_zone_4_s: rnd(a.hrTimeInZone_4, 0),
    hr_zone_5_s: rnd(a.hrTimeInZone_5, 0),
    calories_kcal: rnd(a.calories, 0),
    aerobic_training_effect: rnd(a.aerobicTrainingEffect, 1),
    anaerobic_training_effect: rnd(a.anaerobicTrainingEffect, 1),
    training_effect_label: a.trainingEffectLabel ?? null,
    training_load: rnd(a.activityTrainingLoad, 1),
    vo2max: rnd(a.vO2MaxValue, 1),
    avg_cadence_spm: rnd(a.averageRunningCadenceInStepsPerMinute, 1),
    avg_stride_length_cm: rnd(a.avgStrideLength, 1),
    avg_power_w: rnd(a.avgPower, 0),
    steps: a.steps ?? null,
    moderate_intensity_min: a.moderateIntensityMinutes ?? null,
    vigorous_intensity_min: a.vigorousIntensityMinutes ?? null,
    body_battery_change: a.differenceBodyBattery ?? null,
    min_temp_c: rnd(a.minTemperature, 1),
    max_temp_c: rnd(a.maxTemperature, 1),
    laps: a.lapCount ?? null,
    fastest_1k_s: rnd(a.fastestSplit_1000, 1),
    fastest_5k_s: rnd(a.fastestSplit_5000, 1),
    fastest_10k_s: rnd(a.fastestSplit_10000, 1),
    location: a.locationName ?? null,
    manual: a.manualActivity ?? a.isManualActivity ?? null,
  };
}

// ---------- argument handling ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateRange(args, env, defaultDays, maxDays) {
  const end = args.end_date || todayIn(env);
  const start = args.start_date || isoDay(dayMs(end) - (defaultDays - 1) * DAY);
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || isNaN(dayMs(start)) || isNaN(dayMs(end))) throw userErr('Dates must be YYYY-MM-DD.');
  if (start > end) throw userErr('start_date must be on or before end_date.');
  const span = (dayMs(end) - dayMs(start)) / DAY + 1;
  if (span > maxDays) throw userErr(`That range is ${span} days; this tool takes at most ${maxDays} days per call.`);
  return {start, end};
}
function chunks(start, end, size) {
  const out = [];
  let s = dayMs(start);
  const e = dayMs(end);
  while (s <= e) {
    const ce = Math.min(e, s + (size - 1) * DAY);
    out.push([isoDay(s), isoDay(ce)]);
    s = ce + DAY;
  }
  return out;
}
const dayArg = (description = 'Day, YYYY-MM-DD. Defaults to today.') => ({type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description});
const idArg = () => ({type: 'integer', description: 'Garmin activity id (from garmin_activities).'});
function oneDay(args, env) {
  const d = args.date || todayIn(env);
  if (!DATE_RE.test(String(d)) || isNaN(dayMs(d))) throw userErr('date must be YYYY-MM-DD.');
  return d;
}
function activityId(args) {
  const id = Number(args.activity_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw userErr('activity_id must be a positive integer.');
  return id;
}
// Garmin's intraday arrays use UTC epoch-ms; the report's own start times give the local offset.
function localOffsetMs(o) {
  const p = (s) => Date.parse(String(s || '').replace(' ', 'T').replace(/\.\d+$/, '') + 'Z');
  const a = p(o && o.startTimestampLocal), b = p(o && (o.startTimestampGMT || o.startTimestampGmt));
  return isNaN(a) || isNaN(b) ? 0 : a - b;
}
const localTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
function pick(rows, fields) {
  if (!Array.isArray(fields) || !fields.length) return rows;
  const keep = fields.map(String);
  return rows.map((r) => Object.fromEntries(keep.map((k) => [k, r[k] === undefined ? null : r[k]])));
}
const rangeSchema = (extra = {}, required = []) => ({
  type: 'object',
  properties: {
    start_date: {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First day, YYYY-MM-DD (inclusive).'},
    end_date: {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Last day, YYYY-MM-DD (inclusive). Defaults to today.'},
    fields: {type: 'array', items: {type: 'string'}, maxItems: 100, description: 'Optional: only return these columns (names as in a full answer).'},
    ...extra,
  },
  required,
  additionalProperties: false,
});

const FILTER_MAP = {search: 'search', activity_subtype: 'activitySubType', exclude_subtypes: 'excludedActivitySubType', event_type: 'eventType', favorite: 'favorite',
  min_distance_m: 'minDistance', max_distance_m: 'maxDistance', min_duration_s: 'minDuration', max_duration_s: 'maxDuration', min_elapsed_s: 'minElapsedDuration', max_elapsed_s: 'maxElapsedDuration',
  min_elevation_gain_m: 'minElevation', max_elevation_gain_m: 'maxElevation', min_avg_power_w: 'minAvgPower', sort_by: 'sortBy', sort_order: 'sortOrder', exclude_children: 'excludeChildren',
  required_fields: 'requiredField', min_bottom_time_s: 'minBottomTime', max_bottom_time_s: 'maxBottomTime', lower_max_depth_cm: 'lowerMaxDepth', upper_max_depth_cm: 'upperMaxDepth', deco_dive: 'decoDive'};
function activityFilters(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) {
    const name = FILTER_MAP[k];
    if (!name) throw userErr(`Unknown filter ${k}.`);
    const ok = (x) => ['string', 'number', 'boolean'].includes(typeof x) && String(x).length <= 100;
    if (Array.isArray(v) ? !v.every(ok) : !ok(v)) throw userErr(`Bad value for filter ${k}.`);
    out[name] = name === 'favorite' && typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) ? v.map(String) : v;
  }
  return out;
}

// ---------- tools ----------

const TOOLS = [
  {
    name: 'garmin_activities',
    title: 'Activities',
    description: 'List recorded activities (runs, walks, rides, swims, ...) between two dates with distance, time, pace, heart rate, seconds in each heart-rate zone, training effect, training load and VO2 max. Default: last 28 days. Max 366 days, 500 activities.',
    inputSchema: rangeSchema({
      activity_type: {type: 'string', description: 'Optional Garmin parent type key, e.g. running, cycling, walking, swimming.'},
      limit: {type: 'integer', minimum: 1, maximum: 500, description: 'Max activities to return (default 200).'},
      filters: {type: 'object', additionalProperties: false, description: 'Optional search filters passed to Garmin.', properties: {
        search: {type: 'string', maxLength: 100, description: 'Text in the activity name or description.'},
        activity_subtype: {type: 'string', description: 'Activity subtype key, e.g. trail_running.'},
        exclude_subtypes: {type: 'array', items: {type: 'string'}, description: 'Subtype keys to leave out.'},
        event_type: {type: 'string', description: 'race, training, recreation, fitness, specialEvent or uncategorized.'},
        favorite: {type: 'boolean', description: 'Only favourites (true) or only non-favourites (false).'},
        min_distance_m: {type: 'number'}, max_distance_m: {type: 'number'},
        min_duration_s: {type: 'number'}, max_duration_s: {type: 'number'},
        min_elapsed_s: {type: 'number'}, max_elapsed_s: {type: 'number'},
        min_elevation_gain_m: {type: 'number'}, max_elevation_gain_m: {type: 'number'},
        min_avg_power_w: {type: 'number'},
        sort_by: {type: 'string', description: 'Field to sort by, e.g. distance, duration (default start time).'},
        sort_order: {type: 'string', enum: ['asc', 'desc']},
        exclude_children: {type: 'boolean', description: 'Leave out the legs of multisport activities.'},
        required_fields: {type: 'array', items: {type: 'string'}, description: 'Only activities that have these fields, e.g. averageHR.'},
        min_bottom_time_s: {type: 'number'}, max_bottom_time_s: {type: 'number'},
        lower_max_depth_cm: {type: 'number'}, upper_max_depth_cm: {type: 'number'}, deco_dive: {type: 'boolean'},
      }},
    }),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 28, 366);
      const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 500);
      const rows = [];
      while (rows.length < limit) {
        const want = Math.min(100, limit - rows.length);
        const page = await garmin(env, '/activitylist-service/activities/search/activities', {
          startDate: start, endDate: end, start: rows.length, limit: want,
          activityType: args.activity_type, sortOrder: 'desc', excludeChildren: false, ...activityFilters(args.filters),
        });
        const list = Array.isArray(page) ? page : [];
        rows.push(...list.map(slimActivity));
        if (list.length < want) break;
      }
      return {rows: pick(rows, args.fields), start_date: start, end_date: end, notes: 'GPS coordinates and social fields are removed.'};
    },
  },
  {
    name: 'garmin_activity',
    title: 'Activity details',
    description: 'Full summary of one activity by activity_id, including laps/splits where Garmin provides them.',
    inputSchema: {type: 'object', properties: {activity_id: idArg(), include_location: {type: 'boolean', description: 'Keep start and end GPS coordinates (default false).'}}, required: ['activity_id'], additionalProperties: false},
    async run(args, env) {
      const id = activityId(args);
      const a = await garmin(env, `/activity-service/activity/${id}`);
      if (!a) throw userErr('No activity with that id.');
      const re = args.include_location ? DROP_NO_LOCATION : DROP;
      const splits = Array.isArray(a.splitSummaries) ? a.splitSummaries.map((s) => flatten(s, '', {}, 0, re)) : [];
      return {rows: [flatten(a, '', {}, 0, re)], splits};
    },
  },
  {
    name: 'garmin_daily_summary',
    title: 'Daily summaries',
    description: 'One row per day: resting/min/max heart rate, steps and distance, calories, intensity minutes, stress, Body Battery, respiration and SpO2. Default: last 28 days. Max 366 days.',
    inputSchema: rangeSchema(),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 28, 366);
      const res = await garmin(env, '/usersummary-service/v2/dailysummaries', {startDate: start, endDate: end});
      const list = (res && Array.isArray(res.data)) ? res.data : Array.isArray(res) ? res : [];
      const rows = list.map((d) => {
        const {wellnessChronology, ...rest} = d;
        return {date: d.calendarDate, ...flatten(rest)};
      }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return {rows: pick(rows, args.fields), start_date: start, end_date: end};
    },
  },
  {
    name: 'garmin_sleep',
    title: 'Sleep',
    description: 'One row per night (dated by wake-up day): sleep score, total sleep and stage durations in seconds, awake time, sleeping heart rate, respiration, SpO2 and sleep stress. Default: last 28 nights. Max 366.',
    inputSchema: rangeSchema(),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 28, 366);
      const rows = [];
      for (const [s, e] of chunks(start, end, 31)) {
        const list = await garmin(env, '/sleep-service/sleep/dailySleepSummariesByDate', {startDate: s, endDate: e});
        for (const n of Array.isArray(list) ? list : []) {
          const {id, sleepScoreInsight, sleepScorePersonalizedInsight, ...rest} = n;
          rows.push({
            date: n.calendarDate,
            sleep_score: n.sleepScores && n.sleepScores.overall ? n.sleepScores.overall.value ?? null : null,
            total_sleep_s: n.sleepTimeSeconds ?? null,
            ...flatten(rest),
          });
        }
      }
      rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return {rows: pick(rows, args.fields), start_date: start, end_date: end};
    },
  },
  {
    name: 'garmin_hrv',
    title: 'Heart-rate variability',
    description: 'One row per night: last night\'s average and 5-minute high HRV (ms), the 7-day average, the personal baseline range and Garmin\'s HRV status. Default: last 28 nights. Max 366.',
    inputSchema: rangeSchema(),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 28, 366);
      const rows = [];
      for (const [s, e] of chunks(start, end, 28)) {
        const res = await garmin(env, `/hrv-service/hrv/daily/${s}/${e}`);
        for (const h of (res && Array.isArray(res.hrvSummaries)) ? res.hrvSummaries : []) {
          rows.push({
            date: h.calendarDate,
            last_night_avg_ms: h.lastNightAvg ?? null,
            last_night_5min_high_ms: h.lastNight5MinHigh ?? null,
            weekly_avg_ms: h.weeklyAvg ?? null,
            baseline_low_ms: h.baseline ? h.baseline.balancedLow ?? null : null,
            baseline_high_ms: h.baseline ? h.baseline.balancedUpper ?? null : null,
            status: h.status ?? null,
            feedback: h.feedbackPhrase ?? null,
          });
        }
      }
      rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return {rows: pick(rows, args.fields), start_date: start, end_date: end};
    },
  },
  {
    name: 'garmin_weight',
    title: 'Weigh-ins',
    description: 'Every weigh-in between two dates with weight (kg), BMI and body composition where measured. Default: last 90 days. Max 3660 days.',
    inputSchema: rangeSchema(),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 90, 3660);
      const rows = [];
      for (const [s, e] of chunks(start, end, 365)) {
        const list = await garmin(env, `/weight-service/weight/all/${s}/${e}`);
        for (const w of Array.isArray(list) ? list : []) {
          rows.push({
            date: w.calendarDate ?? w.date ?? null,
            time_gmt: w.timestampGMT ?? null,
            weight_kg: kg(w.weight),
            bmi: rnd(w.bmi, 1),
            body_fat_pct: rnd(w.bodyFat, 1),
            body_water_pct: rnd(w.bodyWater, 1),
            bone_mass_kg: kg(w.boneMass),
            muscle_mass_kg: kg(w.muscleMass),
            visceral_fat: w.visceralFat ?? null,
            metabolic_age: w.metabolicAge ?? null,
          });
        }
      }
      rows.sort((a, b) => String(a.time_gmt || a.date).localeCompare(String(b.time_gmt || b.date)));
      return {rows: pick(rows, args.fields), start_date: start, end_date: end};
    },
  },
  {
    name: 'garmin_fitness_age',
    title: 'Fitness age',
    description: 'Garmin fitness age as of a date, with achievable fitness age and the components it is based on.',
    inputSchema: {type: 'object', properties: {date: dayArg(), full_history_scan: {type: 'boolean', description: 'Search all history for the latest value, not just recent weeks (default false).'}}, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const res = await garmin(env, `/fitnessage-service/fitnessage/v2/${date}`, {fullHistoryScan: args.full_history_scan === true});
      const list = Array.isArray(res) ? res : res ? [res] : [];
      return {rows: list.map((x) => flatten(x)), date};
    },
  },
  {
    name: 'garmin_steps',
    title: 'Daily steps',
    description: 'One row per day: steps, distance walked (m) and step goal. Default: last 28 days. Max 366.',
    inputSchema: rangeSchema(),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 28, 366);
      const rows = [];
      for (const [s, e] of chunks(start, end, 28)) {
        const list = await garmin(env, `/usersummary-service/stats/steps/daily/${s}/${e}`);
        for (const x of Array.isArray(list) ? list : []) rows.push({date: x.calendarDate, steps: x.totalSteps ?? null, distance_m: x.totalDistance ?? null, goal: x.stepGoal ?? null});
      }
      return {rows: pick(rows, args.fields), start_date: start, end_date: end};
    },
  },
  {
    name: 'garmin_stress',
    title: 'Daily stress',
    description: 'One row per day: overall stress level (0-100) and seconds at rest, low, medium and high stress. Default: last 28 days. Max 366.',
    inputSchema: rangeSchema(),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 28, 366);
      const rows = [];
      for (const [s, e] of chunks(start, end, 28)) {
        const list = await garmin(env, `/usersummary-service/stats/stress/daily/${s}/${e}`);
        for (const x of Array.isArray(list) ? list : []) {
          const v = x.values || {};
          rows.push({date: x.calendarDate, stress_level: v.overallStressLevel ?? null, rest_s: v.restStressDuration ?? null, low_s: v.lowStressDuration ?? null, medium_s: v.mediumStressDuration ?? null, high_s: v.highStressDuration ?? null});
        }
      }
      return {rows: pick(rows, args.fields), start_date: start, end_date: end};
    },
  },
  {
    name: 'garmin_hydration',
    title: 'Hydration',
    description: 'One row per day: water logged and hydration goal (ml). Default: last 28 days. Max 366.',
    inputSchema: rangeSchema(),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 28, 366);
      const rows = [];
      for (const [s, e] of chunks(start, end, 31)) {
        const list = await garmin(env, `/usersummary-service/stats/hydration/daily/${s}/${e}`);
        for (const x of Array.isArray(list) ? list : []) rows.push({date: x.calendarDate ?? null, ...flatten(x)});
      }
      return {rows: pick(rows, args.fields), start_date: start, end_date: end};
    },
  },
  {
    name: 'garmin_body_battery',
    title: 'Body Battery',
    description: 'Body Battery per day (charged, drained, highest, lowest) plus every reading with its local time. Default: today. Max 31 days per call.',
    inputSchema: rangeSchema({include_readings: {type: 'boolean', description: 'Include the individual readings (default true).'}}),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 1, 31);
      const list = await garmin(env, '/wellness-service/wellness/bodyBattery/reports/daily', {startDate: start, endDate: end});
      const rows = [], readings = [];
      for (const d of Array.isArray(list) ? list : []) {
        const off = localOffsetMs(d);
        const vals = (d.bodyBatteryValuesArray || []).filter((p) => p && p[1] != null);
        const levels = vals.map((p) => p[1]);
        rows.push({date: d.date, charged: d.charged ?? null, drained: d.drained ?? null,
          highest: levels.length ? Math.max(...levels) : null, lowest: levels.length ? Math.min(...levels) : null,
          latest: levels.length ? levels[levels.length - 1] : null,
          feedback: d.bodyBatteryDynamicFeedbackEvent ? d.bodyBatteryDynamicFeedbackEvent.feedbackLongType ?? null : null});
        if (args.include_readings !== false) for (const p of vals) readings.push({date: d.date, time_local: localTime(p[0] + off), level: p[1]});
      }
      return {rows: pick(rows, args.fields), readings, start_date: start, end_date: end};
    },
  },
  {
    name: 'garmin_heart_rate_day',
    title: 'Heart rate (one day)',
    description: 'Heart rate through one day (a reading about every 2 minutes, local time), with resting, min and max heart rate.',
    inputSchema: {type: 'object', properties: {date: dayArg()}, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const d = (await garmin(env, '/wellness-service/wellness/dailyHeartRate', {date})) || {};
      const off = localOffsetMs(d);
      const rows = (d.heartRateValues || []).filter((p) => p && p[1] != null).map((p) => ({time_local: localTime(p[0] + off), bpm: p[1]}));
      return {rows, summary: {date, resting_bpm: d.restingHeartRate ?? null, min_bpm: d.minHeartRate ?? null, max_bpm: d.maxHeartRate ?? null, resting_7d_avg_bpm: d.lastSevenDaysAvgRestingHeartRate ?? null}};
    },
  },
  {
    name: 'garmin_hrv_readings',
    title: 'HRV readings (one night)',
    description: 'Every 5-minute HRV reading (ms, local time) from one night, with that night\'s HRV summary and baseline.',
    inputSchema: {type: 'object', properties: {date: dayArg('Wake-up day, YYYY-MM-DD. Defaults to today.')}, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const d = (await garmin(env, `/hrv-service/hrv/${date}`)) || {};
      const rows = (d.hrvReadings || []).map((r) => ({time_local: String(r.readingTimeLocal || '').replace('T', ' ').slice(0, 19), hrv_ms: r.hrvValue ?? null}));
      return {rows, summary: flatten(d.hrvSummary || {}), sleep_start_local: d.sleepStartTimestampLocal ?? null, sleep_end_local: d.sleepEndTimestampLocal ?? null};
    },
  },
  {
    name: 'garmin_spo2_day',
    title: 'Blood oxygen (one day)',
    description: 'Blood oxygen (SpO2) for one day: hourly averages with local time, plus the day\'s average, lowest, sleep average and 7-day average.',
    inputSchema: {type: 'object', properties: {date: dayArg()}, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const d = (await garmin(env, `/wellness-service/wellness/daily/spo2acclimation/${date}`)) || {};
      const off = localOffsetMs(d);
      const rows = (d.spO2HourlyAverages || []).filter((p) => p && p[1] != null).map((p) => ({time_local: localTime(p[0] + off), spo2_pct: p[1]}));
      return {rows, summary: {date, average_pct: d.averageSpO2 ?? null, lowest_pct: d.lowestSpO2 ?? null, latest_pct: d.latestSpO2 ?? null, sleep_average_pct: d.avgSleepSpO2 ?? null, seven_day_average_pct: d.lastSevenDaysAvgSpO2 == null ? null : rnd(d.lastSevenDaysAvgSpO2, 1)}};
    },
  },
  {
    name: 'garmin_sleep_night',
    title: 'Sleep (one night)',
    description: 'Everything Garmin has on one night of sleep (dated by wake-up day): score and its parts, stages, timing, heart rate, breathing, SpO2, stress, sleep need.',
    inputSchema: {type: 'object', properties: {date: dayArg('Wake-up day, YYYY-MM-DD. Defaults to today.')}, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const n = await garmin(env, '/sleep-service/sleep/dailySleep', {date});
      if (!n) return {rows: [], date};
      const {id, ...rest} = n;
      return {rows: [{date: n.calendarDate ?? date, sleep_score: n.sleepScores && n.sleepScores.overall ? n.sleepScores.overall.value ?? null : null, total_sleep_s: n.sleepTimeSeconds ?? null, ...flatten(rest)}], date};
    },
  },
  {
    name: 'garmin_day_details',
    title: 'Day details',
    description: 'Garmin\'s full wellness summary for one day: calories, steps, floors, active and sedentary time, heart rate, stress breakdown, Body Battery, SpO2 and breathing.',
    inputSchema: {type: 'object', properties: {date: dayArg()}, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const d = await garmin(env, '/usersummary-service/usersummary/daily', {calendarDate: date});
      return {rows: d ? [flatten(d)] : [], date};
    },
  },
  {
    name: 'garmin_weight_summary',
    title: 'Weight by day',
    description: 'One row per day with weigh-ins: number of weigh-ins, lowest, highest and latest weight (kg), plus the average for the whole range. Default: last 90 days. Max 366.',
    inputSchema: rangeSchema({include_all: {type: 'boolean', description: 'Also list every weigh-in of each day (default false).'}}),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 90, 366);
      const d = (await garmin(env, `/weight-service/weight/range/${start}/${end}`, {includeAll: args.include_all ? true : undefined})) || {};
      const rows = (d.dailyWeightSummaries || []).map((x) => ({date: x.summaryDate, weigh_ins: x.numOfWeightEntries ?? null, min_kg: kg(x.minWeight), max_kg: kg(x.maxWeight), latest_kg: x.latestWeight ? kg(x.latestWeight.weight) : null}))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const out = {rows: pick(rows, args.fields), average_kg: d.totalAverage ? kg(d.totalAverage.weight) : null, start_date: start, end_date: end};
      if (args.include_all) out.weigh_ins = (d.dailyWeightSummaries || []).flatMap((x) => (x.allWeightMetrics || []).map((w) => ({date: w.calendarDate, weight_kg: kg(w.weight), bmi: rnd(w.bmi, 1), body_fat_pct: rnd(w.bodyFat, 1)})));
      return out;
    },
  },
  {
    name: 'garmin_weight_goal',
    title: 'Weight goal',
    description: 'Your weight goal from Garmin Connect (kg) and since when it applies.',
    inputSchema: {type: 'object', properties: {date: dayArg('Day the goal should apply to, YYYY-MM-DD. Defaults to today.')}, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const d = (await garmin(env, `/goal-service/goal/user/effective/weightgoal/${date}/${date}`)) || {};
      const rows = (d.userGoals || []).filter((g) => g.goalValue != null).map((g) => ({goal_kg: kg(g.goalValue), since: g.startDate ?? null, until: g.endDate ?? null, category: g.userGoalCategory ?? null}));
      return {rows, date};
    },
  },
  {
    name: 'garmin_wellness_activities',
    title: 'Wellness activities',
    description: 'Wellness activity summaries Garmin records outside workouts, one row each. Default: last 28 days. Max 366.',
    inputSchema: rangeSchema(),
    async run(args, env) {
      const {start, end} = dateRange(args, env, 28, 366);
      const rows = [];
      for (const [s, e] of chunks(start, end, 31)) {
        const list = await garmin(env, `/wellnessactivity-service/activity/summary/range/${s}/${e}`);
        for (const x of Array.isArray(list) ? list : []) rows.push(flatten(x));
      }
      return {rows: pick(rows, args.fields), start_date: start, end_date: end};
    },
  },
  {
    name: 'garmin_activity_workouts',
    title: 'Activity workouts',
    description: 'The structured workout followed during an activity (e.g. a Garmin Coach run-walk), with every step and its target.',
    inputSchema: {type: 'object', properties: {activity_id: idArg()}, required: ['activity_id'], additionalProperties: false},
    async run(args, env) {
      const id = activityId(args);
      const list = await garmin(env, `/activity-service/activity/${id}/workouts`);
      const workouts = Array.isArray(list) ? list : [];
      return {
        rows: workouts.map((w) => { const {steps, ...rest} = w; return flatten(rest); }),
        steps: workouts.flatMap((w) => (w.steps || []).map((s) => ({workout: w.workoutName ?? null, step: s.stepIndex ?? null, intensity: s.intensity ?? null, exercise: s.exerciseName ?? null,
          duration_type: s.durationType ?? null, duration_value: s.durationValue ?? null, target_type: s.targetType ?? null, target_value: s.targetValue ?? null, target_low: s.targetValueLow ?? null, target_high: s.targetValueHigh ?? null}))),
      };
    },
  },
  {
    name: 'garmin_activity_file',
    title: 'Activity file (FIT)',
    description: 'The original file the watch recorded for one activity (FIT, zipped), returned as an attached file.',
    inputSchema: {type: 'object', properties: {activity_id: idArg()}, required: ['activity_id'], additionalProperties: false},
    async run(args, env) {
      const id = activityId(args);
      const f = await garminRaw(env, `/download-service/files/activity/${id}`);
      if (!f) throw userErr('No file for that activity.');
      if (f.buf.byteLength > 4_000_000) throw userErr(`The file is ${f.buf.byteLength} bytes, too large to pass through here.`);
      return {__file: {mimeType: f.contentType, blob: b64(f.buf), uri: `garmin://activity/${id}.zip`}, activity_id: id, content_type: f.contentType, bytes: f.buf.byteLength};
    },
  },
  {
    name: 'garmin_nutrition',
    title: 'Nutrition log',
    description: 'Food logged in Garmin Connect for one day, with nutrients and nutrition goals.',
    inputSchema: {type: 'object', properties: {
      date: dayArg(),
      include_goals: {type: 'boolean', description: 'Include nutrition goals (default true).'},
      include_nutrition: {type: 'boolean', description: 'Include nutrient details (default true).'},
      meal_id: {type: 'integer', description: 'Only this meal (Garmin meal id).'},
    }, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const d = (await garmin(env, `/nutrition-service/food/logs/${date}`, {includeGoals: args.include_goals === false ? false : undefined, includeNutrition: args.include_nutrition === false ? false : undefined, includeMedia: false, mealId: Number.isSafeInteger(args.meal_id) ? args.meal_id : undefined})) || {};
      const {loggedFoodsWithServingSizes, ...rest} = d;
      return {rows: (loggedFoodsWithServingSizes || []).map((x) => flatten(x)), day: scrub(rest, DROP), date};
    },
  },
  {
    name: 'garmin_profile_settings',
    title: 'Profile settings',
    description: 'Your Garmin Connect settings: units, time zone, first day of week, preferred training days, hydration containers.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    async run(args, env) {
      const d = await garmin(env, '/userprofile-service/userprofile/settings');
      return {rows: d ? [flatten(d)] : []};
    },
  },
  {
    name: 'garmin_menstrual_summary',
    title: 'Menstrual cycle summary',
    description: 'Menstrual cycle summary for a date (women\'s health; empty when not tracked).',
    inputSchema: {type: 'object', properties: {date: dayArg()}, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const d = await garmin(env, `/periodichealth-service/menstrualcycle/summary/${date}`);
      return {data: d ? scrub(d, DROP) : null, date};
    },
  },
  {
    name: 'garmin_menstrual_day',
    title: 'Menstrual cycle day',
    description: 'Detailed menstrual cycle view for one day (women\'s health; empty when not tracked).',
    inputSchema: {type: 'object', properties: {
      date: dayArg(),
      include_analysis: {type: 'boolean', description: 'Include cycle analysis (default false).'},
      reduced: {type: 'boolean', description: 'Return a lighter answer (default false).'},
      skip_baby_movement: {type: 'boolean', description: 'Leave out kick counts (default false).'},
    }, additionalProperties: false},
    async run(args, env) {
      const date = oneDay(args, env);
      const d = await garmin(env, `/periodichealth-service/menstrualcycle/dayview/${date}`, {todayDate: todayIn(env), includeAnalysis: args.include_analysis ? true : undefined, reducedResponse: args.reduced ? true : undefined, skipbm: args.skip_baby_movement ? true : undefined});
      return {data: d ? scrub(d, DROP) : null, date};
    },
  },
  {
    name: 'garmin_heart_rate_zones',
    title: 'Heart-rate zones',
    description: 'Your heart-rate zone settings per sport: method, max and resting heart rate used, and the floor of each zone in bpm.',
    inputSchema: {type: 'object', properties: {generate_defaults: {type: 'boolean', description: 'Return Garmin\'s default zones when none are set (default false).'}}, additionalProperties: false},
    async run(args, env) {
      const res = await garmin(env, '/biometric-service/heartRateZones/v2', {generateDefaults: args.generate_defaults === true});
      return {rows: (Array.isArray(res) ? res : []).map((x) => flatten(x))};
    },
  },
];
