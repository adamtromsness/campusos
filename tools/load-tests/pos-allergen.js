// Cycle 31 Step 4 — Hot path #1: POS allergen cross-check.
// Target p95: <50ms. POST /food-service/transactions resolves the
// student's allergen catalogue + intersects against the menu item's
// allergen_codes TEXT[] in JS. Critical safety path.

import { postJson } from './lib.js';
import { env } from './lib.js';

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

const STUDENT_ID = env('STUDENT_ID');
const MENU_ITEM_ID = env('MENU_ITEM_ID');
const POS_DEVICE_ID = env('POS_DEVICE_ID');
const SESSION_ID = env('SESSION_ID');

export default function () {
  postJson('/api/v1/food-service/transactions', {
    sessionId: SESSION_ID,
    posDeviceId: POS_DEVICE_ID,
    patronId: STUDENT_ID,
    patronType: 'STUDENT',
    paymentMethod: 'ACCOUNT_BALANCE',
    items: [{ menuItemId: MENU_ITEM_ID, quantity: 1, unitPrice: 3.5 }],
  });
}
