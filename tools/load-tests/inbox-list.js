// Cycle 31 Step 4 — Hot path #3: Messaging inbox query.
// Target p95: <200ms. GET /threads with msg_thread_stats join + the
// LATERAL preview lookup.

import { getJson } from './lib.js';

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '60s', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  getJson('/api/v1/threads');
}
