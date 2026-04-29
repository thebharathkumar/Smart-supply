/**
 * Forecast service load: p95 < 2s for 30-day horizon.
 *
 * Run:
 *   k6 run -e BASE_URL=http://localhost:4000 infra/k6/forecast-load.js
 *
 * Note: Prophet first-fit is CPU-heavy. Cache hits should keep p95 well
 * below 100ms after warmup.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const latency = new Trend('forecast_latency');
const cacheMiss = new Trend('forecast_cache_miss_latency');
const cacheHit = new Trend('forecast_cache_hit_latency');

export const options = {
  stages: [
    { duration: '10s', target: 2 },
    { duration: '60s', target: 8 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    forecast_latency: ['p(95)<2000'],
    http_req_failed: ['rate<0.05'],
  },
};

let suppliers = [];

export function setup() {
  const r = http.get(`${BASE_URL}/api/suppliers?active=true&limit=20`);
  if (r.status !== 200) throw new Error('failed to fetch suppliers');
  return { suppliers: r.json() };
}

export default function (data) {
  const s = data.suppliers[Math.floor(Math.random() * data.suppliers.length)];
  const res = http.post(
    `${BASE_URL}/api/forecast`,
    JSON.stringify({ supplierId: s.id, horizonDays: 30 }),
    { headers: { 'content-type': 'application/json' } },
  );
  latency.add(res.timings.duration);
  if (res.headers['X-Cache'] === 'HIT') cacheHit.add(res.timings.duration);
  else cacheMiss.add(res.timings.duration);
  check(res, { 'status 200 or 404': (r) => r.status === 200 || r.status === 404 });
  sleep(1);
}
