import type {
  BellScheduleType,
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

export const PERIOD_TYPES: PeriodType[] = [
  'LESSON',
  'BREAK',
  'LUNCH',
  'REGISTRATION',
  'ASSEMBLY',
];

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
