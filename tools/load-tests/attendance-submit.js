// Cycle 31 Step 4 — Hot path #5: Attendance submission.
// Target p95: <100ms. POST /attendance with class roster validation +
// per-student INSERT into the partitioned sis_attendance_records.

import { postJson, env } from './lib.js';

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

const CLASS_ID = env('CLASS_ID');
const STUDENT_IDS = env('STUDENT_IDS').split(',');
const STATUSES = ['PRESENT', 'TARDY', 'ABSENT_UNEXCUSED', 'PRESENT', 'PRESENT'];

export default function () {
  const today = new Date().toISOString().slice(0, 10);
  const records = STUDENT_IDS.map((id, idx) => ({
    studentId: id,
    status: STATUSES[idx % STATUSES.length],
  }));
  postJson('/api/v1/attendance/batch', {
    classId: CLASS_ID,
    date: today,
    records,
  });
}
