// Cycle 31 Step 4 — Hot path #7: QR bus pass scan.
// Target p95: <50ms. POST /transport/ridership/scan resolves the QR
// token + validates is_active + writes the partitioned
// trn_ridership_records row.

import { postJson, env } from './lib.js';

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '60s', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<50'],
    http_req_failed: ['rate<0.01'],
  },
};

const ROUTE_ID = env('ROUTE_ID');
const STOP_ID = env('STOP_ID');
const QR_TOKENS = env('QR_TOKENS').split(',');

export default function () {
  const token = QR_TOKENS[Math.floor(Math.random() * QR_TOKENS.length)];
  postJson('/api/v1/transport/ridership/scan', {
    qrCodeToken: token,
    routeId: ROUTE_ID,
    stopId: STOP_ID,
    direction: 'BOARDING',
  });
}
