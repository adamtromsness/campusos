// Shared utilities for Cycle 31 k6 load tests.

import http from 'k6/http';
import { check, fail } from 'k6';

export function env(key, fallback) {
  const value = __ENV[key];
  if (value === undefined && fallback === undefined) {
    fail(`missing required env: ${key}`);
  }
  return value ?? fallback;
}

export function authedHeaders() {
  const token = env('TOKEN');
  const subdomain = env('TENANT_SUBDOMAIN', 'demo');
  return {
    Authorization: `Bearer ${token}`,
    'X-Tenant-Subdomain': subdomain,
    'Content-Type': 'application/json',
  };
}

export function baseUrl() {
  return env('TARGET', 'http://localhost:4000');
}

export function getJson(path) {
  const res = http.get(`${baseUrl()}${path}`, { headers: authedHeaders() });
  check(res, {
    [`GET ${path} 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  return res;
}

export function postJson(path, body) {
  const res = http.post(`${baseUrl()}${path}`, JSON.stringify(body), {
    headers: authedHeaders(),
  });
  check(res, {
    [`POST ${path} 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  return res;
}

// Standard load profile: 100 VUs for 60s after a 30s ramp.
export const standardOptions = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '60s', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};
