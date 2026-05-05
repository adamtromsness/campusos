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
  useCreateIntervention,
  useInterventionProgress,
  useInterventions,
  useLogProgress,
  useMtssTier,
} from '@/hooks/use-counselling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  INTERVENTION_STATUS_LABELS,
  INTERVENTION_STATUS_PILL,
  INTERVENTION_TYPE_LABELS,
  INTERVENTION_TYPE_PILL,
  INTERVENTION_TYPES,
  MTSS_DOMAIN_LABELS,
  MTSS_DOMAIN_PILL,
  MTSS_TIER_LABELS,
  MTSS_TIER_PILL,
  MTSS_TIER_STATUS_LABELS,
  MTSS_TIER_STATUS_PILL,
  formatDateOnly,
  studentDisplay,
  todayIso,
} from '@/lib/counselling-format';
import type {
  CreateInterventionPayload,
  InterventionDto,
  InterventionType,
  LogProgressPayload,
} from '@/lib/types';

export default function MtssTierDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const { user } = useAuthStore();
  const isCounsellor = hasAnyPermission(user, ['cou-003:write']);

  const tierQ = useMtssTier(id);
  const interventionsQ = useInterventions(id);
  const [openIntervention, setOpenIntervention] = useState<InterventionDto | null>(null);
  const [addingIntervention, setAddingIntervention] = useState(false);

  if (tierQ.isLoading) return <LoadingSpinner />;
  if (tierQ.isError || !tierQ.data) {
    return (
      <EmptyState
        title="Tier not found"
        description="It may have been exited or you do not have access."
        action={
          <Link
            href="/counselling/mtss"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to MTSS dashboard
          </Link>
        }
      />
    );
  }

  const tier = tierQ.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={studentDisplay(tier.studentFirstName, tier.studentLastName)}
        description={'Tier assigned ' + formatDateOnly(tier.assignedAt)}
      />

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              MTSS_TIER_PILL[tier.tier],
            )}
          >
            {MTSS_TIER_LABELS[tier.tier]}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              MTSS_DOMAIN_PILL[tier.domain],
            )}
          >
            {MTSS_DOMAIN_LABELS[tier.domain]}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              MTSS_TIER_STATUS_PILL[tier.status],
            )}
          >
            {MTSS_TIER_STATUS_LABELS[tier.status]}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-xs text-gray-500">Assigned by</dt>
            <dd className="text-gray-900">{tier.assignedByName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Academic year</dt>
            <dd className="text-gray-900">{tier.academicYearName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Review date</dt>
            <dd className="text-gray-900">{formatDateOnly(tier.reviewDate)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Exit date</dt>
            <dd className="text-gray-900">{formatDateOnly(tier.exitDate)}</dd>
          </div>
        </dl>
        {tier.notes ? (
          <div className="mt-4 rounded border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
            <div className="text-xs font-semibold uppercase text-gray-500">Notes</div>
            <div className="mt-1 whitespace-pre-wrap">{tier.notes}</div>
          </div>
        ) : null}
      </div>

      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-gray-900">Interventions</h2>
          {isCounsellor ? (
            <button
              type="button"
              onClick={() => setAddingIntervention(true)}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
            >
              + Add intervention
            </button>
          ) : null}
        </div>
        {interventionsQ.isLoading ? (
          <LoadingSpinner />
        ) : (interventionsQ.data ?? []).length === 0 ? (
          <EmptyState
            title="No interventions yet"
            description={
              isCounsellor
                ? 'Add the first intervention for this tier with the button above.'
                : 'No interventions logged for this tier.'
            }
          />
        ) : (
          <ul className="space-y-2">
            {(interventionsQ.data ?? []).map((iv) => (
              <li key={iv.id}>
                <button
                  type="button"
                  onClick={() => setOpenIntervention(iv)}
                  className="block w-full rounded-lg border border-gray-200 bg-white p-3 text-left hover:border-campus-300 hover:shadow-sm"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="text-sm font-medium text-gray-900">{iv.interventionName}</div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          INTERVENTION_TYPE_PILL[iv.interventionType],
                        )}
                      >
                        {INTERVENTION_TYPE_LABELS[iv.interventionType]}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          INTERVENTION_STATUS_PILL[iv.status],
                        )}
                      >
                        {INTERVENTION_STATUS_LABELS[iv.status]}
                      </span>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    {iv.frequency ? <span>{iv.frequency}</span> : null}
                    <span>· Started {formatDateOnly(iv.startDate)}</span>
                    {iv.endDate ? <span>· Ends {formatDateOnly(iv.endDate)}</span> : null}
                    {iv.providerName ? <span>· {iv.providerName}</span> : null}
                  </div>
                  {iv.latestProgress ? (
                    <div className="mt-2 text-xs text-gray-700">
                      Latest progress {formatDateOnly(iv.latestProgress.recordedDate)}: score{' '}
                      <span className="font-mono font-semibold">
                        {iv.latestProgress.score?.toFixed(2) ?? '—'}
                      </span>
                      {iv.latestProgress.benchmark !== null
                        ? ' / benchmark ' + iv.latestProgress.benchmark.toFixed(2)
                        : ''}{' '}
                      ({iv.latestProgress.measureType})
                    </div>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {openIntervention ? (
        <InterventionProgressModal
          intervention={openIntervention}
          tierId={id}
          isCounsellor={isCounsellor}
          onClose={() => setOpenIntervention(null)}
        />
      ) : null}

      {addingIntervention ? (
        <AddInterventionModal tierId={id} onClose={() => setAddingIntervention(false)} />
      ) : null}
    </div>
  );
}

function InterventionProgressModal({
  intervention,
  tierId,
  isCounsellor,
  onClose,
}: {
  intervention: InterventionDto;
  tierId: string;
  isCounsellor: boolean;
  onClose: () => void;
}) {
  const progressQ = useInterventionProgress(intervention.id);
  const [adding, setAdding] = useState(false);
  return (
    <Modal open={true} onClose={onClose} title={intervention.interventionName} size="lg">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              INTERVENTION_TYPE_PILL[intervention.interventionType],
            )}
          >
            {INTERVENTION_TYPE_LABELS[intervention.interventionType]}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              INTERVENTION_STATUS_PILL[intervention.status],
            )}
          >
            {INTERVENTION_STATUS_LABELS[intervention.status]}
          </span>
        </div>
        {intervention.description ? (
          <div className="rounded border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
            {intervention.description}
          </div>
        ) : null}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Progress entries</h3>
            {isCounsellor ? (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="rounded-md border border-campus-300 px-2 py-1 text-xs font-medium text-campus-700 hover:bg-campus-50"
              >
                + Log progress
              </button>
            ) : null}
          </div>
          {progressQ.isLoading ? (
            <LoadingSpinner />
          ) : (progressQ.data ?? []).length === 0 ? (
            <div className="rounded border border-dashed border-gray-200 bg-white p-3 text-sm text-gray-500">
              No progress entries yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-2 py-1">Date</th>
                  <th className="px-2 py-1">Measure</th>
                  <th className="px-2 py-1">Score</th>
                  <th className="px-2 py-1">Benchmark</th>
                  <th className="px-2 py-1">Notes</th>
                </tr>
              </thead>
              <tbody>
                {(progressQ.data ?? []).map((p) => (
                  <tr key={p.id} className="border-t border-gray-100">
                    <td className="px-2 py-1.5 text-gray-700">{formatDateOnly(p.recordedDate)}</td>
                    <td className="px-2 py-1.5 text-gray-700">{p.measureType}</td>
                    <td className="px-2 py-1.5 font-mono text-gray-900">
                      {p.score === null ? '—' : p.score.toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-gray-700">
                      {p.benchmark === null ? '—' : p.benchmark.toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5 text-gray-600">{p.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {adding ? (
          <LogProgressForm
            interventionId={intervention.id}
            tierId={tierId}
            onDone={() => setAdding(false)}
          />
        ) : null}
      </div>
    </Modal>
  );
}

function LogProgressForm({
  interventionId,
  tierId,
  onDone,
}: {
  interventionId: string;
  tierId: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const log = useLogProgress(interventionId, tierId);
  const [date, setDate] = useState(todayIso());
  const [measureType, setMeasureType] = useState('');
  const [score, setScore] = useState('');
  const [benchmark, setBenchmark] = useState('');
  const [notes, setNotes] = useState('');
  return (
    <div className="rounded-lg border border-campus-200 bg-campus-50 p-3">
      <h4 className="text-sm font-semibold text-campus-900">Log progress entry</h4>
      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded border border-gray-300 p-1.5"
        />
        <input
          type="text"
          placeholder="Measure type"
          value={measureType}
          onChange={(e) => setMeasureType(e.target.value)}
          className="rounded border border-gray-300 p-1.5"
        />
        <input
          type="number"
          step="0.01"
          placeholder="Score"
          value={score}
          onChange={(e) => setScore(e.target.value)}
          className="rounded border border-gray-300 p-1.5"
        />
        <input
          type="number"
          step="0.01"
          placeholder="Benchmark (optional)"
          value={benchmark}
          onChange={(e) => setBenchmark(e.target.value)}
          className="rounded border border-gray-300 p-1.5"
        />
      </div>
      <textarea
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="mt-2 w-full rounded border border-gray-300 p-1.5 text-sm"
        rows={2}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-white"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!measureType.trim() || log.isPending}
          onClick={async () => {
            try {
              const payload: LogProgressPayload = {
                recordedDate: date,
                measureType: measureType.trim(),
              };
              if (score) payload.score = parseFloat(score);
              if (benchmark) payload.benchmark = parseFloat(benchmark);
              if (notes.trim()) payload.notes = notes.trim();
              await log.mutateAsync(payload);
              toast('Progress logged', 'success');
              onDone();
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Failed', 'error');
            }
          }}
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
        >
          {log.isPending ? 'Logging…' : 'Log entry'}
        </button>
      </div>
    </div>
  );
}

function AddInterventionModal({ tierId, onClose }: { tierId: string; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateIntervention(tierId);
  const [name, setName] = useState('');
  const [type, setType] = useState<InterventionType>('BEHAVIORAL_SUPPORT');
  const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState('');
  const [startDate, setStartDate] = useState(todayIso());
  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Add intervention"
      size="lg"
      footer={
        <div className="flex justify-end gap-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || create.isPending}
            onClick={async () => {
              try {
                const payload: CreateInterventionPayload = {
                  interventionName: name.trim(),
                  interventionType: type,
                  startDate,
                };
                if (description.trim()) payload.description = description.trim();
                if (frequency.trim()) payload.frequency = frequency.trim();
                await create.mutateAsync(payload);
                toast('Intervention added', 'success');
                onClose();
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Failed', 'error');
              }
            }}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            {create.isPending ? 'Adding…' : 'Add intervention'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-700">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Social Skills Group"
            className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
            maxLength={200}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as InterventionType)}
            className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
          >
            {INTERVENTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {INTERVENTION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">Frequency</label>
          <input
            type="text"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            placeholder="2x per week, 30 minutes"
            className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
            maxLength={200}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">Start date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
            rows={3}
            maxLength={2000}
          />
        </div>
      </div>
    </Modal>
  );
}
