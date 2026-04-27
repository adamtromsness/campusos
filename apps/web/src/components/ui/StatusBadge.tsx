import { cn } from './cn';

export type AttendanceStatus = 'PRESENT' | 'TARDY' | 'ABSENT' | 'EXCUSED';

interface StatusBadgeProps {
  status: AttendanceStatus | string;
  className?: string;
}

const STYLES: Record<string, string> = {
  PRESENT: 'bg-status-present-soft text-status-present-text',
  TARDY: 'bg-status-tardy-soft text-status-tardy-text',
  ABSENT: 'bg-status-absent-soft text-status-absent-text',
  EXCUSED: 'bg-status-excused-soft text-status-excused-text',
};

const LABELS: Record<string, string> = {
  PRESENT: 'Present',
  TARDY: 'Tardy',
  ABSENT: 'Absent',
  EXCUSED: 'Excused',
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const style = STYLES[status] ?? 'bg-gray-100 text-gray-700';
  const label = LABELS[status] ?? status;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        style,
        className,
      )}
    >
      {label}
    </span>
  );
}
