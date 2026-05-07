// Cycle 31 Step 4 — Hot path #6: GL batch posting.
// Target p95: <200ms. POST /finance/journal-batches/:id/post runs
// validate_batch_balance + writes through to fin_gl_entries.

import { postJson, env } from './lib.js';

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '60s', target: 50 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

const BATCH_IDS = env('BATCH_IDS').split(',');

export default function () {
  const batchId = BATCH_IDS[Math.floor(Math.random() * BATCH_IDS.length)];
  postJson(`/api/v1/finance/journal-batches/${batchId}/post`, {});
}
