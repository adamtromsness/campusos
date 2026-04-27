import { cn } from './cn';

interface AvatarProps {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Avatar({ name, size = 'md', className }: AvatarProps) {
  const initials = getInitials(name);
  const sizeClasses = {
    sm: 'h-8 w-8 text-xs',
    md: 'h-10 w-10 text-sm',
    lg: 'h-14 w-14 text-base',
  }[size];

  return (
    <div
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-campus-100 font-medium text-campus-700',
        sizeClasses,
        className,
      )}
      aria-label={name}
    >
      {initials}
    </div>
  );
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}
