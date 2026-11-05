// Checks that each tool turns Garmin's answer shapes into the rows it promises.
// All values are invented test data.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const worker = (await import('../src/index.js')).default;

class KV { m = new Map(); async get(k, t) { const v = this.m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; } async put(k, v) { this.m.set(k, v); } async delete(k) { this.m.delete(k); } }
const env = {OAUTH_KV: new KV(), GARMIN_API_KEY: 'k', OWNER_PASSPHRASE: 'p', TIMEZONE: 'Europe/Copenhagen'};

// One invented day, 2025-03-10. Garmin sends UTC epoch-ms; local time is UTC+1 that day.
const utc = (h, m = 0) => Date.UTC(2025, 2, 9, 23) + (h * 60 + m) * 60_000; // h = local hour
const START = {startTimestampGMT: '2025-03-09T23:00:00.0', startTimestampLocal: '2025-03-10T00:00:00.0'};

const fake = {
  '/wellness-service/wellness/bodyBattery/reports/daily': [{date: '2025-03-10', charged: 60, drained: 70, ...START,
    bodyBatteryValuesArray: [[utc(0), 40], [utc(6, 30), 90], [utc(22), 30]], bodyBatteryDynamicFeedbackEvent: {feedbackLongType: 'TEST_FEEDBACK'}}],
  '/wellness-service/wellness/dailyHeartRate': {calendarDate: '2025-03-10', ...START, maxHeartRate: 140, minHeartRate: 50, restingHeartRate: 55, lastSevenDaysAvgRestingHeartRate: 54,
    heartRateValues: [[utc(0), 60], [utc(12), null], [utc(21), 70]]},
  '/hrv-service/hrv/2025-03-10': {hrvSummary: {calendarDate: '2025-03-10', weeklyAvg: 55, lastNightAvg: 58, baseline: {balancedLow: 50, balancedUpper: 62}, status: 'BALANCED'},
    hrvReadings: [{hrvValue: 60, readingTimeLocal: '2025-03-10T01:00:00.0'}], sleepStartTimestampLocal: '2025-03-10T00:30:00.0'},
  '/wellness-service/wellness/daily/spo2acclimation/2025-03-10': {...START, averageSpO2: 96, lowestSpO2: 90, latestSpO2: 97, avgSleepSpO2: 95, lastSevenDaysAvgSpO2: 96.24,
    spO2HourlyAverages: [[utc(0), 96, 10], [utc(1), 97, 10]]},
  '/goal-service/goal/user/effective/weightgoal/2025-03-10/2025-03-10': {userGoals: [{userGoalCategory: 'MANUAL', startDate: '2025-01-01', endDate: null, goalValue: 75000}]},
  '/activity-service/activity/1234567/workouts': [{workoutName: 'Easy Run', sport: 'RUNNING', steps: [{stepIndex: 1, intensity: 'INTERVAL', durationType: 'TIME', durationValue: 300, targetType: 'HEART_RATE', targetValue: 0, targetValueLow: 120, targetValueHigh: 140}]}],
  '/weight-service/weight/range/2025-03-10/2025-03-11': {dailyWeightSummaries: [
    {summaryDate: '2025-03-11', numOfWeightEntries: 1, minWeight: 80200, maxWeight: 80200, latestWeight: {weight: 80200}},
    {summaryDate: '2025-03-10', numOfWeightEntries: 1, minWeight: 80600, maxWeight: 80600, latestWeight: {weight: 80600}}], totalAverage: {weight: 80400}},
  '/usersummary-service/stats/stress/daily/2025-03-10/2025-03-11': [{calendarDate: '2025-03-10', values: {highStressDuration: 600, lowStressDuration: 20000, overallStressLevel: 20, restStressDuration: 40000, mediumStressDuration: 5000}}],
  '/usersummary-service/stats/steps/daily/2025-03-10/2025-03-11': [{calendarDate: '2025-03-10', totalSteps: 8000, totalDistance: 6400, stepGoal: 10000}],
};
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/token')) return Response.json({access_token: 't'});
  if (!(u.pathname in fake)) return new Response('missing ' + u.pathname, {status: 500});
  return Response.json(fake[u.pathname]);
};

const tok = 'tok';
await env.OAUTH_KV.put('at:' + createHash('sha256').update(tok).digest('base64url'), JSON.stringify({client_id: 'c', v: '1'}));
const call = async (name, args) => {
  const res = await worker.fetch(new Request('https://x.dev/mcp', {method: 'POST', headers: {authorization: 'Bearer ' + tok},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})}), env);
  const r = (await res.json()).result;
  assert.ok(!r.isError, name + ' ' + JSON.stringify(r.content));
  return r.structuredContent;
};
const D = {date: '2025-03-10'}, R = {start_date: '2025-03-10', end_date: '2025-03-11'};

let r = await call('garmin_body_battery', {start_date: '2025-03-10', end_date: '2025-03-10'});
assert.deepEqual(r.rows[0], {date: '2025-03-10', charged: 60, drained: 70, highest: 90, lowest: 30, latest: 30, feedback: 'TEST_FEEDBACK'});
assert.equal(r.readings[0].time_local, '2025-03-10 00:00:00');
assert.equal(r.readings.at(-1).time_local, '2025-03-10 22:00:00');

r = await call('garmin_heart_rate_day', D);
assert.equal(r.rows.length, 2); // null reading dropped
assert.deepEqual(r.rows.at(-1), {time_local: '2025-03-10 21:00:00', bpm: 70});
assert.deepEqual(r.summary, {date: '2025-03-10', resting_bpm: 55, min_bpm: 50, max_bpm: 140, resting_7d_avg_bpm: 54});

r = await call('garmin_hrv_readings', D);
assert.deepEqual(r.rows, [{time_local: '2025-03-10 01:00:00', hrv_ms: 60}]);
assert.equal(r.summary.baseline_balancedLow, 50);

r = await call('garmin_spo2_day', D);
assert.deepEqual(r.rows[0], {time_local: '2025-03-10 00:00:00', spo2_pct: 96});
assert.equal(r.summary.seven_day_average_pct, 96.2);

r = await call('garmin_weight_goal', D);
assert.deepEqual(r.rows, [{goal_kg: 75, since: '2025-01-01', until: null, category: 'MANUAL'}]);

r = await call('garmin_activity_workouts', {activity_id: 1234567});
assert.equal(r.rows[0].workoutName, 'Easy Run');
assert.equal(r.steps[0].target_low, 120);
assert.equal(r.steps[0].target_high, 140);

r = await call('garmin_weight_summary', R);
assert.deepEqual(r.rows.map((x) => [x.date, x.latest_kg]), [['2025-03-10', 80.6], ['2025-03-11', 80.2]]); // sorted, grams to kg
assert.equal(r.average_kg, 80.4);

r = await call('garmin_stress', R);
assert.deepEqual(r.rows[0], {date: '2025-03-10', stress_level: 20, rest_s: 40000, low_s: 20000, medium_s: 5000, high_s: 600});

r = await call('garmin_steps', R);
assert.deepEqual(r.rows[0], {date: '2025-03-10', steps: 8000, distance_m: 6400, goal: 10000});

console.log('SHAPE TESTS PASSED');
