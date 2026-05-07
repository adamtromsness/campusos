// Cycle 31 Step 4 — Hot path #2: Library catalogue GIN search.
// Target p95: <100ms. GIN INDEX on to_tsvector(title || ' ' ||
// COALESCE(author, '')) backs the public catalogue search.

import { getJson } from './lib.js';

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '60s', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<100'],
    http_req_failed: ['rate<0.01'],
  },
};

const QUERIES = ['Lowry', 'Sachar', 'Wonder', 'Bridge', 'Holes', 'Charlotte'];

export default function () {
  const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  getJson(`/api/v1/library/catalogue?q=${q}`);
}
