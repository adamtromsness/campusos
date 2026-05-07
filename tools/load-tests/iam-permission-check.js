// Cycle 31 Step 4 — Hot path #4: IAM permission check.
// Target p95: <10ms. iam_effective_access_cache lookup runs on
// EVERY request via PermissionGuard. Sub-10ms is the gate that
// keeps overall p95 latency on the floor.

import { getJson } from './lib.js';

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '60s', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    // Synthetic minimum: GET /classes/my fires the permission check
    // + a single DB read. The middleware overhead (TraceId +
    // RequestLog) adds ~2ms; the permission check itself should be
    // <8ms. Total p95 budget 10ms.
    http_req_duration: ['p(95)<10'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  getJson('/api/v1/classes/my');
}
