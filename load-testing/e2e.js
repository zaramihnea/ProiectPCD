import ws from 'k6/ws';
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const e2eLatency = new Trend('e2e_pipeline_ms', true);

export const options = {
  scenarios: {
    e2e: {
      executor: 'constant-vus',
      vus: 1,
      duration: '3m',
    },
  },
  thresholds: {
    e2e_pipeline_ms: ['p(95)<5000', 'p(50)<500'],
  },
};

const WS_URL  = 'wss://websocket.proiectpcd.online/ws';
const API_URL = 'https://listmonk.proiectpcd.online/api/subscribers';
const PARAMS  = {
  headers: {
    'Cookie': 'session=Z3ljImXGfdAk9fxW3nM928v7yQe11LQErF2VDgVUFcUWB3lHgM4jkzvTp5S5C69e',
    'Content-Type': 'application/json',
  },
};

export default function () {
  const pending = [];

  const res = ws.connect(WS_URL, {}, function (socket) {

    socket.on('open', () => {
      socket.setInterval(() => {
        const now = Date.now();
        while (pending.length > 0 && now - pending[0] > 30_000) {
          console.warn(`[E2E] dropped stale request (no WS response in 30s)`);
          pending.shift();
        }

        pending.push(Date.now());
        http.get(API_URL, PARAMS);
      }, 3000);
    });

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'initial_state') return;

        if (pending.length > 0) {
          const t1 = pending.shift();
          const latencyMs = Date.now() - t1;
          e2eLatency.add(latencyMs);
          console.log(`[E2E] ${latencyMs}ms  resourceType=${msg.resourceType}`);
        }
      } catch (_) {}
    });

    socket.on('error', (e) => console.error('[WS error]', e.error()));

    socket.setTimeout(() => socket.close(), 170_000);
  });

  check(res, { 'ws connected (101)': (r) => r && r.status === 101 });
}