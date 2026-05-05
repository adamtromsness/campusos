'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CLEARANCE_STATUS_LABELS,
  CLEARANCE_STATUS_PILL,
  INJURY_SEVERITY_LABELS,
  INJURY_SEVERITY_PILL,
  RETURN_TO_PLAY_LABELS,
  RETURN_TO_PLAY_PILL,
  formatDate,
} from '@/lib/athletics-format';
import {
  useAthleticsInjury,
  useCompleteProtocolStep,
  useReviewClearance,
  useStartProtocolStep,
  useUploadClearance,
} from '@/hooks/use-athletics';

const PROTOCOL_STEP_NAMES = [
  'Complete rest',
  'Light aerobic activity',
  'Sport-specific exercise',
  'Non-contact training drills',
  'Full contact practice',
  'Return to competition',
];

export default function InjuryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((s) => s.user);
  const isAd =
    hasAnyPermission(user, ['sch-001:admin']) ||
    (user?.personType === 'STAFF' && hasAnyPermission(user, ['ath-004:write']));
  const { toast } = useToast();

  const injuryQ = useAthleticsInjury(id ?? null);
  const startMut = useStartProtocolStep(id ?? '');
  const completeMut = useCompleteProtocolStep();
  const uploadMut = useUploadClearance(id ?? '');
  const reviewMut = useReviewClearance();

  const [showUpload, setShowUpload] = useState(false);
  const [docKey, setDocKey] = useState('clearances/');
  const [physician, setPhysician] = useState('');
  const [clearanceDate, setClearanceDate] = useState(new Date().toISOString().slice(0, 10));

  if (injuryQ.isLoading) return <LoadingSpinner />;
  if (!injuryQ.data) return <p className="text-gray-500">Injury not found.</p>;
  const i = injuryQ.data;
  const steps = i.protocolSteps ?? [];
  const clearances = i.clearances ?? [];

  const nextStepNumber =
    steps.length === 0
      ? 1
      : steps.every((s) => s.completedAt) && steps.length < 6
        ? steps.length + 1
        : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${i.studentName} — ${i.bodyPart}`}
        description={`Injured on ${formatDate(i.injuryDate)} · logged by ${i.loggedByName ?? '—'}`}
      />

      <div className="flex flex-wrap gap-2">
        <span className={`rounded px-2 py-1 text-xs ${INJURY_SEVERITY_PILL[i.severity]}`}>
          {INJURY_SEVERITY_LABELS[i.severity]}
        </span>
        <span className={`rounded px-2 py-1 text-xs ${RETURN_TO_PLAY_PILL[i.returnToPlayStatus]}`}>
          {RETURN_TO_PLAY_LABELS[i.returnToPlayStatus]}
        </span>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="text-sm text-gray-700">{i.injuryDescription}</div>
        {i.initialAssessment ? (
          <div className="mt-3">
            <div className="text-xs font-medium uppercase text-gray-500">Initial assessment</div>
            <div className="text-sm text-gray-700">{i.initialAssessment}</div>
          </div>
        ) : null}
        {i.actionTaken ? (
          <div className="mt-3">
            <div className="text-xs font-medium uppercase text-gray-500">Action taken</div>
            <div className="text-sm text-gray-700">{i.actionTaken}</div>
          </div>
        ) : null}
      </section>

      {/* Concussion protocol — SAFETY KEYSTONE */}
      {i.returnToPlayStatus === 'CONCUSSION_PROTOCOL' || steps.length > 0 ? (
        <section className="rounded-xl border border-rose-200 bg-rose-50 p-6">
          <h2 className="mb-4 text-lg font-semibold text-rose-900">
            6-step concussion return-to-play protocol
          </h2>
          <ol className="space-y-2">
            {[1, 2, 3, 4, 5, 6].map((n) => {
              const step = steps.find((s) => s.stepNumber === n);
              const isComplete = !!step?.completedAt;
              const isActive = step && !step.completedAt;
              const isLocked = !step && nextStepNumber !== n;
              return (
                <li
                  key={n}
                  className={`flex items-center justify-between rounded-lg border p-3 ${
                    isComplete
                      ? 'border-emerald-200 bg-emerald-50'
                      : isActive
                        ? 'border-amber-200 bg-amber-50'
                        : 'border-gray-200 bg-white'
                  }`}
                >
                  <div>
                    <div className="font-medium text-gray-900">
                      Step {n}: {step?.stepName ?? PROTOCOL_STEP_NAMES[n - 1]}
                    </div>
                    {step ? (
                      <div className="text-xs text-gray-600">
                        Started {formatDate(step.startedAt)} · {step.minimumDurationHours}h min
                        {step.completedAt ? ` · completed ${formatDate(step.completedAt)}` : ''}
                        {step.symptomFree ? ' · symptom-free' : ''}
                      </div>
                    ) : (
                      <div className="text-xs text-gray-500">
                        {isLocked ? 'Locked — finish previous step first' : 'Not started'}
                      </div>
                    )}
                  </div>
                  {isAd && isActive && step ? (
                    <button
                      onClick={async () => {
                        try {
                          await completeMut.mutateAsync({
                            stepId: step.id,
                            symptomFree: true,
                          });
                          toast(`Step ${n} completed`, 'success');
                        } catch (e) {
                          toast(e instanceof Error ? e.message : 'Failed', 'error');
                        }
                      }}
                      disabled={completeMut.isPending}
                      className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      Complete
                    </button>
                  ) : null}
                  {isAd && !step && nextStepNumber === n ? (
                    <button
                      onClick={async () => {
                        try {
                          await startMut.mutateAsync({
                            stepNumber: n,
                            stepName: PROTOCOL_STEP_NAMES[n - 1] ?? `Step ${n}`,
                          });
                          toast(`Step ${n} started`, 'success');
                        } catch (e) {
                          toast(e instanceof Error ? e.message : 'Failed', 'error');
                        }
                      }}
                      disabled={startMut.isPending}
                      className="rounded bg-rose-600 px-3 py-1 text-xs text-white hover:bg-rose-700 disabled:opacity-50"
                    >
                      Start
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {/* Medical clearances */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Medical clearances</h2>
          {isAd ? (
            <button
              onClick={() => setShowUpload(true)}
              className="rounded-lg bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            >
              Upload clearance
            </button>
          ) : null}
        </div>
        {clearances.length > 0 ? (
          <div className="space-y-2">
            {clearances.map((c) => (
              <div key={c.id} className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium text-gray-900">
                      {c.physicianName ?? 'Physician note'}
                    </div>
                    <div className="text-xs text-gray-500">
                      Cleared {formatDate(c.clearanceDate)} · uploaded by {c.uploadedByName ?? '—'}
                    </div>
                  </div>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${CLEARANCE_STATUS_PILL[c.reviewStatus]}`}
                  >
                    {CLEARANCE_STATUS_LABELS[c.reviewStatus]}
                  </span>
                </div>
                {isAd && c.reviewStatus === 'PENDING' ? (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={async () => {
                        try {
                          await reviewMut.mutateAsync({
                            clearanceId: c.id,
                            decision: 'ACCEPTED',
                          });
                          toast('Clearance accepted', 'success');
                        } catch (e) {
                          toast(e instanceof Error ? e.message : 'Failed', 'error');
                        }
                      }}
                      className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-700"
                    >
                      Accept
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await reviewMut.mutateAsync({
                            clearanceId: c.id,
                            decision: 'REJECTED',
                          });
                          toast('Clearance rejected', 'success');
                        } catch (e) {
                          toast(e instanceof Error ? e.message : 'Failed', 'error');
                        }
                      }}
                      className="rounded bg-rose-600 px-3 py-1 text-xs text-white hover:bg-rose-700"
                    >
                      Reject
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No clearance documents yet.</p>
        )}
      </section>

      <Modal
        open={showUpload}
        title="Upload medical clearance"
        onClose={() => setShowUpload(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowUpload(false)}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!docKey || !clearanceDate) {
                  toast('Document key and clearance date are required', 'error');
                  return;
                }
                try {
                  await uploadMut.mutateAsync({
                    documentS3Key: docKey,
                    physicianName: physician || undefined,
                    clearanceDate,
                  });
                  toast('Clearance uploaded — pending review', 'success');
                  setShowUpload(false);
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed', 'error');
                }
              }}
              disabled={uploadMut.isPending}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm text-white hover:bg-campus-700 disabled:opacity-50"
            >
              Upload
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700">Document S3 key</label>
            <input
              type="text"
              value={docKey}
              onChange={(e) => setDocKey(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Physician name</label>
            <input
              type="text"
              value={physician}
              onChange={(e) => setPhysician(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Clearance date</label>
            <input
              type="date"
              value={clearanceDate}
              onChange={(e) => setClearanceDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
