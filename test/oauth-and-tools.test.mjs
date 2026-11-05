import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';

const worker = (await import('../src/index.js')).default;

class KV {
  m = new Map();
  async get(k, type) { const v = this.m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; }
  async put(k, v, opts) { if (opts && opts.expirationTtl < 60) throw new Error('KV TTL < 60'); this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
}
const env = {OAUTH_KV: new KV(), GARMIN_API_KEY: 'test-key-123', OWNER_PASSPHRASE: 'correct horse battery staple', TIMEZONE: 'Europe/Copenhagen'};

// Fake Garmin
const garminCalls = [];
let tokenIssues = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  garminCalls.push(u.pathname + u.search);
  const h = init.headers || {};
  if (u.pathname.endsWith('/personal-api-key/token')) {
    assert.equal(h.Authorization, 'ApiKey test-key-123'); assert.equal(h.Accept, '*/*');
    tokenIssues++;
    return new Response(JSON.stringify({access_token: 'garmin-tok-' + tokenIssues, expires_in: 86400}), {status: 200});
  }
  assert.match(h.Authorization, /^Bearer garmin-tok-/);
  if (u.pathname === '/activitylist-service/activities/search/activities') {
    const start = Number(u.searchParams.get('start')), limit = Number(u.searchParams.get('limit'));
    const total = 130;
    const n = Math.max(0, Math.min(limit, total - start));
    return Response.json(Array.from({length: n}, (_, i) => ({
      activityId: 1000 + start + i, activityName: 'Morning Run', activityType: {typeKey: 'running'},
      startTimeLocal: '2025-03-10 07:15:00', distance: 5000, duration: 1800, averageSpeed: 2.7778, averageHR: 150,
      hrTimeInZone_1: 300, hrTimeInZone_2: 600, vO2MaxValue: 45, startLatitude: 10.123, startLongitude: 20.456,
      ownerFullName: 'Someone', activityLikeDisplayNames: ['x'], activityTrainingLoad: 50,
    })));
  }
  if (u.pathname === '/sleep-service/sleep/dailySleepSummariesByDate') {
    return Response.json([{id: 1, calendarDate: u.searchParams.get('endDate'), sleepTimeSeconds: 27000, deepSleepSeconds: 5400, sleepScores: {overall: {value: 80, qualifierKey: 'GOOD'}}, userProfilePK: 42, dailyNapDTOS: [{a: 1}]}]);
  }
  if (u.pathname.startsWith('/hrv-service/hrv/daily/')) {
    return Response.json({hrvSummaries: [{calendarDate: u.pathname.split('/').pop(), weeklyAvg: 55, lastNightAvg: 58, lastNight5MinHigh: 75, baseline: {balancedLow: 50, balancedUpper: 62}, status: 'BALANCED'}], userProfilePk: 42});
  }
  if (u.pathname === '/usersummary-service/v2/dailysummaries') {
    return Response.json({data: [{calendarDate: '2025-03-10', uuid: 'u', userProfilePk: 42, heartRate: {restingValue: 55, minValue: 50, maxValue: 140}, stress: {avgLevel: 30}, bodyBattery: {maxValue: 90, minValue: 25}, wellnessChronology: {x: 1}}]});
  }
  if (u.pathname.startsWith('/weight-service/weight/all/')) {
    return Response.json([{calendarDate: '2025-03-10', timestampGMT: '2025-03-10T07:00:00', weight: 80200, bmi: 24.1}]);
  }
  if (u.pathname.startsWith('/activity-service/activity/')) {
    return Response.json({activityId: 5, activityName: 'X', summaryDTO: {distance: 5000, averageHR: 150, startLatitude: 1}, splitSummaries: [{splitType: 'RWD_RUN', distance: 1000}], userProfileId: 42});
  }
  if (u.pathname === '/biometric-service/heartRateZones/v2') return Response.json([{sport: 'DEFAULT', zone1Floor: 120, maxHeartRateUsed: 190}]);
  if (u.pathname.startsWith('/fitnessage-service/')) return Response.json([{chronologicalAge: 40, fitnessAge: 38.5, components: {rhr: {value: 52}}}]);
  if (u.pathname.startsWith('/download-service/files/activity/')) return new Response(new Uint8Array([80,75,3,4,1,2,3]), {headers: {'content-type': 'application/zip', 'content-disposition': 'attachment; filename=x.zip'}});
  return Response.json({echo: u.pathname + u.search, startLatitude: 10.123, ownerFullName: 'X', nested: [{endLongitude: 20.456, v: 1}]});
};

const BASE = 'https://garmin-mcp.example.workers.dev';
const call = (path, init) => worker.fetch(new Request(BASE + path, init), env);
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 1. Unauthenticated MCP gets 401 with resource metadata pointer
let r = await call('/mcp', {method: 'POST', body: '{}'});
assert.equal(r.status, 401);
assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/garmin-mcp\.example\.workers\.dev\/\.well-known\/oauth-protected-resource"/);

// 2. Discovery
r = await call('/.well-known/oauth-protected-resource');
assert.equal((await r.json()).authorization_servers[0], BASE);
r = await call('/.well-known/oauth-authorization-server');
const meta = await r.json();
assert.equal(meta.registration_endpoint, BASE + '/register');

// 3. Registration: evil redirect refused, Claude's accepted
r = await call('/register', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({redirect_uris: ['https://evil.example/cb']})});
assert.equal(r.status, 400);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
r = await call('/register', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({redirect_uris: [REDIRECT], client_name: 'Claude'})});
assert.equal(r.status, 201);
const {client_id} = await r.json();

// 4. Authorize page
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const q = new URLSearchParams({client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8'});
r = await call('/authorize?' + q);
assert.equal(r.status, 200);
assert.equal(r.headers.get('x-frame-options'), 'DENY');
const html = await r.text();
assert.match(html, /Owner passphrase/);
// redirect not registered -> refused
r = await call('/authorize?' + new URLSearchParams({...Object.fromEntries(q), redirect_uri: 'https://claude.ai/other'}));
assert.equal(r.status, 400);
// no PKCE -> refused
r = await call('/authorize?' + new URLSearchParams({...Object.fromEntries(q), code_challenge: ''}));
assert.equal(r.status, 400);

// 5. Wrong passphrase, then right one
const form = (pp) => new URLSearchParams({...Object.fromEntries(q), passphrase: pp});
r = await call('/authorize', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: form('wrong')});
assert.equal(r.status, 401);
r = await call('/authorize', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: form(env.OWNER_PASSPHRASE)});
assert.equal(r.status, 302);
const loc = new URL(r.headers.get('location'));
assert.equal(loc.origin + loc.pathname, REDIRECT);
assert.equal(loc.searchParams.get('state'), 'st8');
const code = loc.searchParams.get('code');

// 6. Token exchange: bad verifier fails, good succeeds, code is single-use
const tok = (body) => call('/token', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(body)});
r = await tok({grant_type: 'authorization_code', code, code_verifier: 'nope', client_id, redirect_uri: REDIRECT});
assert.equal(r.status, 400); // and code is now burned
r = await call('/authorize', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: form(env.OWNER_PASSPHRASE)});
const code2 = new URL(r.headers.get('location')).searchParams.get('code');
r = await tok({grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id, redirect_uri: REDIRECT});
assert.equal(r.status, 200);
let tokens = await r.json();
assert.ok(tokens.access_token && tokens.refresh_token);
r = await tok({grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id, redirect_uri: REDIRECT});
assert.equal(r.status, 400);
// tokens are stored hashed only
for (const k of env.OAUTH_KV.m.keys()) assert.ok(!k.includes(tokens.access_token) && !k.includes(tokens.refresh_token));
for (const v of env.OAUTH_KV.m.values()) assert.ok(!String(v).includes(tokens.access_token));

// 7. Refresh rotates
r = await tok({grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id});
assert.equal(r.status, 200);
const old = tokens; tokens = await r.json();
r = await tok({grant_type: 'refresh_token', refresh_token: old.refresh_token, client_id});
assert.equal(r.status, 400);

// 8. MCP
const rpc = async (body, token = tokens.access_token) => {
  const res = await call('/mcp', {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token}, body: JSON.stringify(body)});
  return {status: res.status, body: res.status === 202 ? null : await res.json()};
};
let x = await rpc({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}}});
assert.equal(x.body.result.protocolVersion, '2025-06-18');
x = await rpc({jsonrpc: '2.0', method: 'notifications/initialized'});
assert.equal(x.status, 202);
x = await rpc({jsonrpc: '2.0', id: 2, method: 'tools/list'});
const names = x.body.result.tools.map((t) => t.name);
console.log('tools:', names.join(', '));
assert.ok(x.body.result.tools.every((t) => t.annotations.readOnlyHint === true));

const callTool = async (name, args) => (await rpc({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name, arguments: args}})).body.result;

let res = await callTool('garmin_activities', {start_date: '2026-10-01', end_date: '2026-11-04'});
assert.equal(res.isError, undefined);
assert.equal(res.structuredContent.rows.length, 130); // paged 100 + 30
const a0 = res.structuredContent.rows[0];
assert.equal(a0.distance_km, 5);
assert.equal(a0.avg_pace_min_per_km, '6:00');
assert.ok(!JSON.stringify(res).match(/10\.123|20\.456|Someone|latitude/i), 'leaks location/social');
console.log('activity row:', JSON.stringify(a0).slice(0, 200));

res = await callTool('garmin_sleep', {start_date: '2026-09-01', end_date: '2026-11-04'});
assert.equal(res.structuredContent.rows.length, 3); // 31+31+3 day chunks
assert.equal(res.structuredContent.rows[0].sleep_score, 80);
assert.ok(!('userProfilePK' in res.structuredContent.rows[0]));

res = await callTool('garmin_hrv', {start_date: '2026-10-01', end_date: '2026-11-04'});
assert.equal(res.structuredContent.rows.length, 2);
res = await callTool('garmin_daily_summary', {start_date: '2026-11-04', end_date: '2026-11-04'});
assert.equal(res.structuredContent.rows[0].heartRate_restingValue, 55);
assert.ok(!('uuid' in res.structuredContent.rows[0]) && !('wellnessChronology_x' in res.structuredContent.rows[0]));
res = await callTool('garmin_weight', {});
assert.equal(res.structuredContent.rows[0].weight_kg, 80.2);
res = await callTool('garmin_activity', {activity_id: 5});
assert.equal(res.structuredContent.rows[0].summaryDTO_averageHR, 150);
assert.ok(!JSON.stringify(res).includes('startLatitude'));
res = await callTool('garmin_heart_rate_zones', {});
assert.equal(res.structuredContent.rows[0].zone1Floor, 120);
res = await callTool('garmin_fitness_age', {date: '2026-11-04'});
assert.equal(res.structuredContent.rows[0].components_rhr_value, 52);

// validation errors are friendly, not crashes
res = await callTool('garmin_sleep', {start_date: '2025-01-01', end_date: '2026-11-04'});
assert.equal(res.isError, true); console.log('range error:', res.content[0].text);
res = await callTool('garmin_sleep', {start_date: 'yesterday'});
assert.equal(res.isError, true);

// 8b. every named tool
const listed = (await rpc({jsonrpc: '2.0', id: 2, method: 'tools/list'})).body.result.tools;
assert.equal(listed.length, 26);
assert.ok(!listed.some((t) => t.name === 'garmin_api'));
assert.ok(listed.every((t) => t.title && t.annotations.readOnlyHint));
const D1 = {date: '2026-11-04'}, R = {start_date: '2026-10-01', end_date: '2026-11-04'}, A = {activity_id: 42};
const plan = {garmin_steps: R, garmin_stress: R, garmin_hydration: R, garmin_body_battery: {start_date: '2026-11-03', end_date: '2026-11-04'}, garmin_heart_rate_day: D1,
  garmin_hrv_readings: D1, garmin_spo2_day: D1, garmin_sleep_night: D1, garmin_day_details: D1, garmin_weight_summary: R, garmin_weight_goal: D1,
  garmin_wellness_activities: R, garmin_activity_workouts: A, garmin_activity_file: A, garmin_nutrition: D1, garmin_profile_settings: {},
  garmin_menstrual_summary: D1, garmin_menstrual_day: D1};
let ok = 0;
for (const [name, args] of Object.entries(plan)) {
  const r = await callTool(name, args);
  assert.ok(!r.isError, name + ': ' + (r.content && r.content[0].text));
  assert.ok(!/Latitude|Longitude|ownerFullName/.test(JSON.stringify(r.structuredContent)), name + ' leaks');
  if (name === 'garmin_activity_file') { assert.equal(r.content[1].resource.blob, 'UEsDBAECAw=='); assert.equal(r.structuredContent.bytes, 7); }
  ok++;
}
console.log('named endpoint tools ok:', ok);
let g = await callTool('garmin_activities', {start_date: '2026-11-01', filters: {search: 'Morning', required_fields: ['averageHR', 'distance'], favorite: true, min_distance_m: 5000}});
assert.ok(!g.isError);
assert.ok(garminCalls.some((c) => c.includes('requiredField=averageHR&requiredField=distance') && c.includes('search=Morning') && c.includes('favorite=1') && c.includes('minDistance=5000')), 'filters passed');
g = await callTool('garmin_activity', {activity_id: 5, include_location: true});
assert.equal(g.structuredContent.rows[0].summaryDTO_startLatitude, 1);
for (const [name, args] of [['garmin_activity_file', {activity_id: '1/../x'}], ['garmin_heart_rate_day', {date: '../admin'}], ['garmin_activities', {filters: {evil: 1}}], ['garmin_nutrition', {date: 'x'}]]) {
  const r = await callTool(name, args); assert.equal(r.isError, true, name);
}
console.log('bad inputs rejected');

// 9. Bad / revoked token
x = await rpc({jsonrpc: '2.0', id: 9, method: 'tools/list'}, 'garbage');
assert.equal(x.status, 401);
env.TOKEN_VERSION = '2';
x = await rpc({jsonrpc: '2.0', id: 9, method: 'tools/list'});
assert.equal(x.status, 401);
env.TOKEN_VERSION = undefined;

// 10. Lockout after 10 failures
for (let i = 0; i < 10; i++) await call('/authorize', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: form('bad' + i)});
r = await call('/authorize', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: form(env.OWNER_PASSPHRASE)});
assert.equal(r.status, 429);

// The Garmin key is only ever sent to Garmin's token endpoint
console.log('garmin token fetches:', tokenIssues, '| garmin calls:', garminCalls.length);
console.log('ALL TESTS PASSED');
