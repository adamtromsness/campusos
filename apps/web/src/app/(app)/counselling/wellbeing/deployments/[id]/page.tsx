'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useActivateWellbeingDeployment,
  useCancelWellbeingDeployment,
  useCompleteWellbeingDeployment,
  useWellbeingCheckin,
  useWellbeingCheckins,
  useWellbeingDeployment,
  useWellbeingTemplate,
} from '@/hooks/use-wellbeing';
import {
  DEPLOYMENT_STATUS_LABELS,
  DEPLOYMENT_STATUS_PILL,
  DEPLOYMENT_TARGET_LABELS,
  DOMAIN_LABELS,
  formatDate,
  formatRelative,
} from '@/lib/wellbeing-format';

export default function DeploymentManagerPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const depQ = useWellbeingDeployment(id);
  const checkinsQ = useWellbeingCheckins({ deploymentId: id });
  const tplQ = useWellbeingTemplate(depQ.data?.templateId ?? null);
  const activate = useActivateWellbeingDeployment();
  const complete = useCompleteWellbeingDeployment();
  const cancel = useCancelWellbeingDeployment();
  const { toast } = useToast();

  const [responseDetail, setResponseDetail] = useState<string | null>(null);

  if (depQ.isLoading) return <LoadingSpinner />;
  if (depQ.isError || !depQ.data) {
    return (
      <EmptyState
        title="Deployment not found"
        description="It may have been deleted, or you may not have permission."
      />
    );
  }
  const d = depQ.data;
  const checkins = checkinsQ.data ?? [];
  const completedCount = checkins.filter((c) => c.completedAt !== null).length;
  const totalCount = checkins.length || (d.totalTargeted ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={d.templateName ?? 'Deployment'}
        description="Per-student check-in completion + status transitions."
      />

      <div className="text-sm">
        <Link href="/counselling/wellbeing" className="text-campus-700 hover:underline">
          ← Wellbeing dashboard
        </Link>
      </div>

      {/* Header card */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                DEPLOYMENT_STATUS_PILL[d.status],
              )}
            >
              {DEPLOYMENT_STATUS_LABELS[d.status]}
            </span>
            <span className="rounded-full bg-campus-100 px-2 py-0.5 text-[11px] font-medium text-campus-800 ring-1 ring-campus-200">
              {DEPLOYMENT_TARGET_LABELS[d.targetType]}
            </span>
          </div>
          <div className="text-xs text-gray-500">Deployed by {d.deployedByName ?? '—'}</div>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-gray-500">Deploy at</dt>
            <dd>{formatDate(d.deployAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Expires</dt>
            <dd>{d.expiresAt ? formatDate(d.expiresAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Targeted</dt>
            <dd>{d.totalTargeted ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Completed</dt>
            <dd>{d.totalCompleted ?? 0}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          {d.status === 'SCHEDULED' ? (
            <button
              type="button"
              onClick={async () => {
                try {
                  const r = await activate.mutateAsync(d.id);
                  toast(
                    'Deployment activated — ' + r.checkinsCreated + ' check-ins created',
                    'success',
                  );
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed to activate', 'error');
                }
              }}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Activate (resolve audience + create check-ins)
            </button>
          ) : null}
          {d.status === 'ACTIVE' ? (
            <button
              type="button"
              onClick={async () => {
                try {
                  await complete.mutateAsync(d.id);
                  toast('Deployment completed', 'success');
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed to complete', 'error');
                }
              }}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700"
            >
              Mark complete
            </button>
          ) : null}
          {d.status === 'SCHEDULED' || d.status === 'ACTIVE' ? (
            <button
              type="button"
              onClick={async () => {
                if (
                  !confirm(
                    'Cancel this deployment? Existing check-ins remain but the deployment is closed.',
                  )
                )
                  return;
                try {
                  await cancel.mutateAsync(d.id);
                  toast('Deployment cancelled', 'success');
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed to cancel', 'error');
                }
              }}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </section>

      {/* Check-ins list */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">
          Check-ins ({completedCount} / {totalCount})
        </h3>
        {checkinsQ.isLoading ? (
          <LoadingSpinner />
        ) : checkins.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">
            {d.status === 'SCHEDULED'
              ? 'No check-ins yet — activate the deployment to generate them.'
              : 'No check-ins.'}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {checkins.map((c) => {
              const completed = c.completedAt !== null;
              return (
                <li
                  key={c.id}
                  className="flex items-baseline justify-between rounded-md border border-gray-200 p-3"
                >
                  <div className="text-sm font-medium text-gray-900">{c.studentName ?? '—'}</div>
                  <div className="flex items-center gap-3">
                    {completed ? (
                      c.flaggedForFollowUp ? (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-800 ring-1 ring-rose-200">
                          Flagged
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-emerald-200">
                          Completed
                        </span>
                      )
                    ) : (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">
                        Pending
                      </span>
                    )}
                    <span className="text-xs text-gray-500">
                      {formatRelative(c.completedAt ?? c.createdAt)}
                    </span>
                    {completed ? (
                      <button
                        type="button"
                        onClick={() => setResponseDetail(c.id)}
                        className="text-xs font-medium text-campus-700 hover:underline"
                      >
                        View
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Per-student response detail modal */}
      <ResponseDetailModal
        checkinId={responseDetail}
        templateQuestions={tplQ.data?.questions ?? []}
        onClose={() => setResponseDetail(null)}
      />
    </div>
  );
}

interface ResponseDetailModalProps {
  checkinId: string | null;
  templateQuestions: { id: string; questionText: string; domain: string }[];
  onClose: () => void;
}

function ResponseDetailModal({ checkinId, templateQuestions, onClose }: ResponseDetailModalProps) {
  const ckinQ = useWellbeingCheckin(checkinId);
  if (!checkinId) return null;
  const ckin = ckinQ.data;
  const responses = ckin?.responses ?? [];
  const byQ = new Map(responses.map((r) => [r.questionId, r]));

  return (
    <Modal
      open={!!checkinId}
      onClose={onClose}
      title={ckin ? (ckin.studentName ?? '—') + ' · responses' : 'Loading…'}
      size="lg"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
        >
          Close
        </button>
      }
    >
      {ckinQ.isLoading || !ckin ? (
        <LoadingSpinner />
      ) : (
        <ol className="space-y-3">
          {templateQuestions.map((q) => {
            const r = byQ.get(q.id);
            const numeric = r?.numericResponse ?? null;
            const text = r?.textResponse ?? null;
            return (
              <li key={q.id} className="rounded-md border border-gray-200 p-3">
                <div className="text-sm font-medium text-gray-900">{q.questionText}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {DOMAIN_LABELS[q.domain as keyof typeof DOMAIN_LABELS]}
                </div>
                <div className="mt-2 text-sm text-gray-800">
                  {numeric !== null ? <span className="font-mono">{numeric}</span> : null}
                  {text ? <span>{text}</span> : null}
                  {numeric === null && !text ? <span className="text-gray-400">—</span> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Modal>
  );
}
