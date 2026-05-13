import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// кастомні метрики
export const errorRate = new Rate('errors');
export const responseTime = new Trend('response_time');

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // розігрів
    { duration: '1m', target: 200 },   // навантаження
    { duration: '30s', target: 500 },  // stress
    { duration: '30s', target: 0 },    // cooldown
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'], // <5% помилок
    http_req_duration: ['p(95)<500'], // 95% < 500ms
  },
};

export default function () {
  const url = 'http://localhost:3000/api/test';

  const res = http.get(url);

  const success = check(res, {
    'status 200': (r) => r.status === 200,
  });

  errorRate.add(!success);
  responseTime.add(res.timings.duration);

  sleep(1);
}