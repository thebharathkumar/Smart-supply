/**
 * Verifies WebSocket round-trip latency claims.
 *
 * Connects N WS clients, subscribes to all routes, samples the time delta
 * between the simulator's published ts and the moment the client receives
 * the score_update event.
 *
 * Run:
 *   k6 run -e BASE_URL=ws://localhost:4000 infra/k6/ws-fanout.js
 *
 * Target: p95 < 200ms, p99 < 500ms.
 */
import ws from 'k6/ws';
import { Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'ws://localhost:4000';
const TEST_DURATION_S = parseInt(__ENV.DURATION || '60');

const e2eLatency = new Trend('ws_e2e_latency_ms');
const messageCount = new Counter('ws_messages');

export const options = {
  vus: 50,
  duration: `${TEST_DURATION_S}s`,
  thresholds: {
    ws_e2e_latency_ms: ['p(95)<200', 'p(99)<500'],
  },
};

export default function () {
  const url = `${BASE_URL}/ws`;
  ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe' }));
    });
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'score_update' && msg.data && msg.data.ts) {
          const delta = Date.now() - new Date(msg.data.ts).getTime();
          e2eLatency.add(delta);
          messageCount.add(1);
        }
      } catch {
        // ignore
      }
    });
    socket.setTimeout(() => socket.close(), TEST_DURATION_S * 1000);
  });
}
