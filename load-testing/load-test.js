import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 10 },
    { duration: '5m', target: 10 },
    { duration: '1m', target: 50 },
    { duration: '5m', target: 50 },
    { duration: '1m', target: 100 },
    { duration: '5m', target: 100 },
    { duration: '1m', target: 200 },
    { duration: '5m', target: 200 },
    { duration: '1m', target: 0 },
  ],
};

export default function () {
  const url = `https://listmonk.proiectpcd.online/api/subscribers`;
  
  const params = {
    headers: {
      'Cookie': 'session=Z3ljImXGfdAk9fxW3nM928v7yQe11LQErF2VDgVUFcUWB3lHgM4jkzvTp5S5C69e',
      'Content-Type': 'application/json',
    },
  };
  
  const res = http.get(url, params);
  
  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(0.1);
}