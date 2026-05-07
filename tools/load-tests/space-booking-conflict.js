// Cycle 31 Step 4 — Hot path #12: Space booking conflict check.
// Target p95: <20ms. The fac_space_bookings EXCLUDE USING gist
// constraint catches overlapping bookings at the schema level; this
// script measures the conflict-check round trip.

import { postJson, env } from './lib.js';

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '60s', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<20'],
    // Intentionally allow a higher failure rate — conflicting
    // bookings legitimately fail with 409. The check focuses on
    // p95 latency.
    http_req_failed: ['rate<0.5'],
  },
};

const SPACE_ID = env('SPACE_ID');

export default function () {
  // Random hour-long window across a 30-day horizon — most attempts
  // will land in an open slot; the rest 409 against the EXCLUDE
  // constraint. Both paths are valid latency samples.
  const offsetMinutes = Math.floor(Math.random() * 30 * 24 * 60);
  const start = new Date(Date.now() + offsetMinutes * 60_000);
  const end = new Date(start.getTime() + 60 * 60_000);
  postJson('/api/v1/facilities/bookings', {
    spaceId: SPACE_ID,
    title: 'k6 load test booking',
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  });
}
