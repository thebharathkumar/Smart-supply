/**
 * Hammers the NSGA-II optimization endpoint with diverse origin/destination
 * pairs to verify p95 < 800ms under load.
 *
 * Run:
 *   k6 run -e BASE_URL=http://localhost:4000 infra/k6/optimize-load.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const optimizeLatency = new Trend('optimize_latency');

export const options = {
  stages: [
    { duration: '15s', target: 5 },
    { duration: '60s', target: 15 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    optimize_latency: ['p(95)<800', 'p(99)<1500'],
    http_req_failed: ['rate<0.05'],
  },
};

let hubs = null;

export function setup() {
  const r = http.get(`${BASE_URL}/api/hubs`);
  if (r.status !== 200) throw new Error(`hubs setup failed: ${r.status}`);
  return { hubs: r.json() };
}

export default function (data) {
  if (!data || !data.hubs || data.hubs.length < 2) return;
  const a = data.hubs[Math.floor(Math.random() * data.hubs.length)];
  let b = data.hubs[Math.floor(Math.random() * data.hubs.length)];
  if (b.id === a.id) b = data.hubs[(data.hubs.indexOf(a) + 1) % data.hubs.length];

  const body = JSON.stringify({
    originHubId: a.id,
    destinationHubId: b.id,
    weightCo2: 0.5,
    weightCost: 0.3,
    weightTime: 0.2,
    topK: 3,
  });

  const res = http.post(`${BASE_URL}/api/optimize/route`, body, {
    headers: { 'content-type': 'application/json' },
    tags: { endpoint: 'optimize' },
  });
  optimizeLatency.add(res.timings.duration);
  check(res, {
    'status ok or 404 (no path)': (r) => r.status === 200 || r.status === 404,
  });
  sleep(0.3);
}
