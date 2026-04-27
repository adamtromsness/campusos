'use client';

import Link from 'next/link';
import { cn } from '@/components/ui/cn';

export type ClassTabKey = 'attendance' | 'assignments' | 'gradebook';

interface ClassTabsProps {
  classId: string;
  active: ClassTabKey;
  /** Hide tabs the caller hasn't been granted yet (e.g. gradebook UI lands in Step 8). */
  hideGradebook?: boolean;
}

const TAB_LABEL: Record<ClassTabKey, string> = {
  attendance: 'Attendance',
  assignments: 'Assignments',
  gradebook: 'Gradebook',
};

function tabHref(classId: string, key: ClassTabKey): string {
  return `/classes/${classId}/${key}`;
}

export function ClassTabs({ classId, active, hideGradebook }: ClassTabsProps) {
  const order: ClassTabKey[] = hideGradebook
    ? ['attendance', 'assignments']
    : ['attendance', 'assignments', 'gradebook'];
  return (
    <nav
      aria-label="Class sections"
      className="mb-5 flex gap-1 border-b border-gray-200"
    >
      {order.map((key) => {
        const isActive = key === active;
        return (
          <Link
            key={key}
            href={tabHref(classId, key)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors',
              isActive
                ? 'border-campus-600 text-campus-700'
                : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300',
            )}
          >
            {TAB_LABEL[key]}
          </Link>
        );
      })}
    </nav>
  );
}
