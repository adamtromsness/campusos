// Cycle 29 — Analytics & Reporting helpers.

export function formatPercent(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(digits)}%`;
}

export function formatGpa(gpa: number | null | undefined, digits = 2): string {
  if (gpa === null || gpa === undefined) return '—';
  return gpa.toFixed(digits);
}

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export function attendanceTone(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return 'bg-gray-100 text-gray-700';
  if (rate >= 0.95) return 'bg-emerald-100 text-emerald-800';
  if (rate >= 0.9) return 'bg-amber-100 text-amber-800';
  return 'bg-rose-100 text-rose-800';
}

export function gpaTone(gpa: number | null | undefined): string {
  if (gpa === null || gpa === undefined) return 'bg-gray-100 text-gray-700';
  if (gpa >= 3.0) return 'bg-emerald-100 text-emerald-800';
  if (gpa >= 2.0) return 'bg-amber-100 text-amber-800';
  return 'bg-rose-100 text-rose-800';
}

export const RUN_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  RUNNING: 'Running',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
};

export const RUN_STATUS_PILL: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  RUNNING: 'bg-sky-100 text-sky-800',
  COMPLETE: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-rose-100 text-rose-800',
};

export const OUTPUT_FORMATS: Array<{ value: 'CSV' | 'PDF' | 'XLSX'; label: string }> = [
  { value: 'CSV', label: 'CSV' },
  { value: 'PDF', label: 'PDF' },
  { value: 'XLSX', label: 'Excel (XLSX)' },
];

export const DELIVERY_CHANNELS: Array<{ value: 'EMAIL' | 'IN_APP' | 'BOTH'; label: string }> = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'IN_APP', label: 'In-app notification' },
  { value: 'BOTH', label: 'Email + in-app' },
];

export const WORKER_LABEL: Record<string, string> = {
  sis: 'SIS read models',
  classroom: 'Classroom read models',
  'at-risk': 'At-risk evaluation',
  'school-summary': 'School summary',
  district: 'District analytics',
  wellbeing: 'Wellbeing trends',
  'finance-ar': 'Finance — aged debtors',
};

export function formatRelativeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

export function describeCron(cron: string): string {
  // Best-effort: render the common 5-field shapes humans recognise.
  // 0 8 * * MON  -> "Monday at 08:00"
  // 0 8 * * *    -> "Daily at 08:00"
  // 0 0 * * *    -> "Daily at 00:00"
  // *  *  * * *  -> "Every minute"
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, mon, dow] = parts;
  if (m === '*' && h === '*') return 'Every minute';
  const time = `${(h ?? '?').padStart(2, '0')}:${(m ?? '?').padStart(2, '0')}`;
  const dowLabels: Record<string, string> = {
    SUN: 'Sunday',
    MON: 'Monday',
    TUE: 'Tuesday',
    WED: 'Wednesday',
    THU: 'Thursday',
    FRI: 'Friday',
    SAT: 'Saturday',
    '0': 'Sunday',
    '1': 'Monday',
    '2': 'Tuesday',
    '3': 'Wednesday',
    '4': 'Thursday',
    '5': 'Friday',
    '6': 'Saturday',
  };
  if (dow && dow !== '*') {
    const day = dowLabels[dow.toUpperCase()] ?? dow;
    return `${day} at ${time}`;
  }
  if (dom !== '*' || mon !== '*') return cron;
  return `Daily at ${time}`;
}
