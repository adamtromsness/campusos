'use client';

import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useWorkflowTemplates } from '@/hooks/use-approvals';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { APPROVER_TYPE_LABELS } from '@/lib/approvals-format';

export default function WorkflowTemplatesPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['ops-001:admin', 'sch-001:admin']);
  const templates = useWorkflowTemplates(isAdmin);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Workflow templates" />
        <EmptyState
          title="Admin only"
          description="This page is visible to school administrators only."
        />
      </div>
    );
  }

  const list = templates.data ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Workflow templates"
        description="Approval chains configured for this school. Each template applies to one request type."
      />

      <div className="mb-4 rounded-card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p>
          <strong>Read-only this cycle.</strong> Editing templates (add/remove/reorder steps, set
          approver type, set timeout) lands in a future cycle. The seed ships three templates that
          drive the active flows.
        </p>
      </div>

      {templates.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No workflow templates configured"
          description="Run seed:tasks to populate the LEAVE_REQUEST / ABSENCE_REQUEST / CHILD_LINK_REQUEST templates."
        />
      ) : (
        <ul className="space-y-4">
          {list.map((t) => (
            <li
              key={t.id}
              className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-100 bg-gray-50 px-5 py-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">{t.name}</h2>
                  <p className="font-mono text-xs text-gray-500">{t.requestType}</p>
                </div>
                <span
                  className={cn(
                    'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                    t.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600',
                  )}
                >
                  {t.isActive ? 'Active' : 'Inactive'}
                </span>
              </header>

              {t.description && (
                <p className="border-b border-gray-100 px-5 py-3 text-sm text-gray-700">
                  {t.description}
                </p>
              )}

              <ol className="divide-y divide-gray-100">
                {t.steps.map((s) => (
                  <li key={s.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                    <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-campus-100 text-xs font-semibold text-campus-700">
                      {s.stepOrder}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-gray-900">
                        {APPROVER_TYPE_LABELS[s.approverType]}
                        {s.approverRef && (
                          <span className="ml-2 font-mono text-xs text-gray-500">
                            {s.approverRef}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {s.timeoutHours ? 'Timeout ' + s.timeoutHours + 'h' : 'No timeout'}
                        {s.isParallel && ' · parallel'}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
