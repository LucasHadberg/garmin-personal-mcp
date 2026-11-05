import assert from 'node:assert/strict';
const worker = (await import('../src/index.js')).default;
class KV { m = new Map(); async get(k, t) { const v = this.m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; } async put(k, v) { this.m.set(k, v); } async delete(k) { this.m.delete(k); } }
const env = {OAUTH_KV: new KV(), GARMIN_API_KEY: 'k', OWNER_PASSPHRASE: 'p', TIMEZONE: 'Europe/Copenhagen'};
let calls = 0, first429 = true;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/token')) return Response.json({access_token: 't', expires_in: 86400});
  calls++;
  if (first429) { first429 = false; return new Response('', {status: 429}); }
  return Response.json({hrvSummaries: [{calendarDate: '2026-10-01', lastNightAvg: 58}]});
};
await env.OAUTH_KV.put('at:' + 'x', '{}');
// mint a token the normal way is long; call the tool function through MCP needs auth, so reach in via a fake token record
import {createHash} from 'node:crypto';
const tok = 'tok123';
const h = createHash('sha256').update(tok).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
await env.OAUTH_KV.put('at:' + h, JSON.stringify({client_id: 'c', v: '1'}));
const call = async (args) => (await (await worker.fetch(new Request('https://x.dev/mcp', {method: 'POST', headers: {authorization: 'Bearer ' + tok, 'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'garmin_hrv', arguments: args}})}), env)).json()).result;
let t0 = Date.now();
let r = await call({start_date: '2026-10-01', end_date: '2026-10-05'});
assert.equal(r.isError, undefined); assert.equal(calls, 2); console.log('429 then ok after', Date.now() - t0, 'ms');
r = await call({start_date: '2026-10-01', end_date: '2026-10-05'});
assert.equal(calls, 2); console.log('memo hit, no Garmin call');
assert.ok([...env.OAUTH_KV.m.keys()].some((k) => k.startsWith('gc:'))); console.log('past-day answer stored in KV');
r = await call({start_date: '2026-10-01', end_date: '2026-10-05', fields: ['date']});
assert.deepEqual(Object.keys(r.structuredContent.rows[0]), ['date']); console.log('fields ok');
console.log('CACHE TESTS PASSED');
