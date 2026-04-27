import { type ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      {icon && <div className="mb-4 text-campus-300">{icon}</div>}
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      {description && (
        <p className="mt-1 max-w-md text-sm text-gray-500">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
