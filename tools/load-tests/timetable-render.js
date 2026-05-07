// Cycle 31 Step 4 — Hot path #9: Timetable render.
// Target p95: <150ms. GET /timetable/class/:classId hits the
// btree_gist EXCLUSION-protected sch_timetable_slots table.

import { getJson, env } from './lib.js';

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '60s', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<150'],
    http_req_failed: ['rate<0.01'],
  },
};

const CLASS_IDS = env('CLASS_IDS').split(',');

export default function () {
  const id = CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)];
  getJson(`/api/v1/timetable/class/${id}`);
}
