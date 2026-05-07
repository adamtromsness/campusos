// Cycle 31 Step 4 — Hot path #8: Student profile load.
// Target p95: <300ms. GET /students/:id with accommodations + health
// + grades joined. The widest read shape in the platform.

import { getJson, env } from './lib.js';

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '60s', target: 50 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

const STUDENT_IDS = env('STUDENT_IDS').split(',');

export default function () {
  const id = STUDENT_IDS[Math.floor(Math.random() * STUDENT_IDS.length)];
  getJson(`/api/v1/students/${id}`);
}
