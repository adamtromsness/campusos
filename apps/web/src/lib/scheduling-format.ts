import type {
  BellScheduleType,
  CalendarEventType,
  CoverageStatus,
  PeriodType,
  RoomBookingStatus,
  RoomChangeRequestStatus,
  RoomType,
} from './types';

export function scheduleTypeLabel(type: BellScheduleType): string {
  return {
    STANDARD: 'Standard',
    EARLY_DISMISSAL: 'Early dismissal',
    ASSEMBLY: 'Assembly',
    EXAM: 'Exam',
    CUSTOM: 'Custom',
  }[type];
}

export function periodTypeLabel(type: PeriodType): string {
  return {
    LESSON: 'Lesson',
    BREAK: 'Break',
    LUNCH: 'Lunch',
    REGISTRATION: 'Registration',
    ASSEMBLY: 'Assembly',
  }[type];
}

export function roomTypeLabel(type: RoomType): string {
  return {
    CLASSROOM: 'Classroom',
    LAB: 'Lab',
    GYM: 'Gym',
    HALL: 'Hall',
    LIBRARY: 'Library',
    OFFICE: 'Office',
    OUTDOOR: 'Outdoor',
  }[type];
}

export const ROOM_TYPES: RoomType[] = [
  'CLASSROOM',
  'LAB',
  'GYM',
  'HALL',
  'LIBRARY',
  'OFFICE',
  'OUTDOOR',
];

export const PERIOD_TYPES: PeriodType[] = ['LESSON', 'BREAK', 'LUNCH', 'REGISTRATION', 'ASSEMBLY'];

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dayOfWeekLabel(day: number | null): string {
  if (day === null) return 'Every weekday';
  return WEEKDAY_LABELS[day] ?? '?';
}

/** Trim 'HH:MM:SS' to 'HH:MM' for friendlier display. */
export function formatTime(time: string | null | undefined): string {
  if (!time) return '';
  return time.length >= 5 ? time.slice(0, 5) : time;
}

export function bookingStatusLabel(status: RoomBookingStatus): string {
  return status === 'CONFIRMED' ? 'Confirmed' : 'Cancelled';
}

export function changeRequestStatusLabel(status: RoomChangeRequestStatus): string {
  return {
    PENDING: 'Pending',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    AUTO_APPROVED: 'Auto-approved',
  }[status];
}

export const CALENDAR_EVENT_TYPES: CalendarEventType[] = [
  'HOLIDAY',
  'PROFESSIONAL_DEVELOPMENT',
  'EARLY_DISMISSAL',
  'ASSEMBLY',
  'EXAM_PERIOD',
  'PARENT_EVENT',
  'FIELD_TRIP',
  'CUSTOM',
];

export function calendarEventTypeLabel(type: CalendarEventType): string {
  return {
    HOLIDAY: 'Holiday',
    PROFESSIONAL_DEVELOPMENT: 'PD day',
    EARLY_DISMISSAL: 'Early dismissal',
    ASSEMBLY: 'Assembly',
    EXAM_PERIOD: 'Exam period',
    PARENT_EVENT: 'Parent event',
    FIELD_TRIP: 'Field trip',
    CUSTOM: 'Event',
  }[type];
}

/**
 * Tailwind chip classes for each event type. Used by the school calendar
 * to colour-code events at a glance.
 */
export function calendarEventChipClasses(type: CalendarEventType): string {
  return {
    HOLIDAY: 'bg-rose-100 text-rose-800 border-rose-200',
    PROFESSIONAL_DEVELOPMENT: 'bg-violet-100 text-violet-800 border-violet-200',
    EARLY_DISMISSAL: 'bg-amber-100 text-amber-800 border-amber-200',
    ASSEMBLY: 'bg-sky-100 text-sky-800 border-sky-200',
    EXAM_PERIOD: 'bg-orange-100 text-orange-800 border-orange-200',
    PARENT_EVENT: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    FIELD_TRIP: 'bg-teal-100 text-teal-800 border-teal-200',
    CUSTOM: 'bg-gray-100 text-gray-700 border-gray-200',
  }[type];
}

export function coverageStatusLabel(status: CoverageStatus): string {
  return {
    OPEN: 'Open',
    ASSIGNED: 'Assigned',
    COVERED: 'Covered',
    CANCELLED: 'Cancelled',
  }[status];
}

export function coverageStatusPillClasses(status: CoverageStatus): string {
  return {
    OPEN: 'bg-red-100 text-red-800',
    ASSIGNED: 'bg-amber-100 text-amber-800',
    COVERED: 'bg-emerald-100 text-emerald-800',
    CANCELLED: 'bg-gray-200 text-gray-600',
  }[status];
}

export function todayIso(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export function addDaysIso(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
