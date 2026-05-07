// Cycle 31 Step 4 — Hot path #10: At-risk evaluation.
// Target: <5s for 500 students. The nightly worker scans
// rpt_student_academic_summary; this script triggers a manual
// re-evaluation and times the response.

import { postJson, env } from './lib.js';

export const options = {
  // Lower VU count — this is a heavy read scan, not a per-request hot path.
  stages: [
    { duration: '15s', target: 5 },
    { duration: '30s', target: 5 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.01'],
  },
};

const CONFIG_ID = env('AT_RISK_CONFIG_ID');

export default function () {
  postJson('/api/v1/analytics/workers/run', {
    workers: ['at-risk-evaluation'],
    configId: CONFIG_ID,
  });
}
