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
    'Cookie': 'session=dsHO4vexpNUjTwEg3HfQWX3hRQT4XhwrR51bn8V8JQET7doQD3ktFhIVzN7Dl2Ga',
    'Content-Type': 'application/json',
  },
};

export default function () {
  const res = ws.connect(WS_URL, {}, function (socket) {

    socket.on('open', () => {
      // trigger a new analytics event every 2s
      socket.setInterval(() => {
        http.get(API_URL, PARAMS);
      }, 2000);
    });

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'initial_state') return;

        if (msg.stats && msg.stats.lastEventAt) {
          const latencyMs = Date.now() - new Date(msg.stats.lastEventAt).getTime();
          if (latencyMs > 0 && latencyMs < 120_000) {
            e2eLatency.add(latencyMs);
            console.log(`[E2E] ${latencyMs} ms  resourceType=${msg.resourceType}`);
          }
        }
      } catch (_) {}
    });

    socket.on('error', (e) => console.error('[WS error]', e.error()));

    socket.setTimeout(() => socket.close(), 180_000);
  });

  check(res, { 'ws connected (101)': (r) => r && r.status === 101 });
}
