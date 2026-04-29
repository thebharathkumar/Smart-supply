/**
 * REST baseline: hits the read-heavy endpoints under steady load.
 * Run:
 *   k6 run -e BASE_URL=http://localhost:4000 infra/k6/rest-baseline.js
 *
 * Target SLOs:
 *   - GET /api/routes       p95 < 150ms
 *   - GET /api/suppliers    p95 < 200ms
 *   - GET /api/hubs         p95 < 100ms
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

const routesLatency = new Trend('routes_latency');
const suppliersLatency = new Trend('suppliers_latency');
const hubsLatency = new Trend('hubs_latency');

export const options = {
  stages: [
    { duration: '15s', target: 20 },
    { duration: '60s', target: 50 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    routes_latency: ['p(95)<150'],
    suppliers_latency: ['p(95)<200'],
    hubs_latency: ['p(95)<100'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const r1 = http.get(`${BASE_URL}/api/routes?active=true`);
  routesLatency.add(r1.timings.duration);
  check(r1, { 'routes 200': (r) => r.status === 200 });

  const r2 = http.get(`${BASE_URL}/api/suppliers?active=true&limit=50`);
  suppliersLatency.add(r2.timings.duration);
  check(r2, { 'suppliers 200': (r) => r.status === 200 });

  const r3 = http.get(`${BASE_URL}/api/hubs`);
  hubsLatency.add(r3.timings.duration);
  check(r3, { 'hubs 200': (r) => r.status === 200 });

  sleep(0.5);
}
