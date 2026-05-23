'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAccFrameworks,
  useAccSelfStudy,
  useAccStandards,
  useCreateAccAdoption,
  useCreateAccCustomFramework,
  useCreateAccSelfStudyRating,
} from '@/hooks/use-accreditation';
import { ACC_RATING_LABEL, ACC_RATING_PILL, currentCycleId } from '@/lib/accreditation-format';
import { ACC_SELF_STUDY_RATINGS } from '@/lib/types';
import type { AccSelfStudyRating, AccStandardDto } from '@/lib/types';

export default function StandardsExplorerPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.activePersona?.type === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const frameworksQ = useAccFrameworks(showStaffSurfaces);
  const cycleId = currentCycleId();
  const ratingsQ = useAccSelfStudy(cycleId);

  const [frameworkId, setFrameworkId] = useState<string | undefined>(undefined);
  const adoptedFrameworks = useMemo(
    () => (frameworksQ.data ?? []).filter((f) => f.isAdopted),
    [frameworksQ.data],
  );
  const activeFwId = frameworkId ?? adoptedFrameworks[0]?.id;
  const standardsQ = useAccStandards(activeFwId);

  const [adoptOpen, setAdoptOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [rateForStandard, setRateForStandard] = useState<AccStandardDto | null>(null);

  const ratingByStandard = useMemo(() => {
    const map = new Map<string, AccSelfStudyRating>();
    (ratingsQ.data ?? []).forEach((r) => map.set(r.standardId, r.rating));
    return map;
  }, [ratingsQ.data]);

  // Group standards by domain for tabular view
  const grouped = useMemo(() => {
    const m = new Map<string, AccStandardDto[]>();
    (standardsQ.data ?? []).forEach((s) => {
      const key = s.domain ?? 'Custom';
      const arr = m.get(key) ?? [];
      arr.push(s);
      m.set(key, arr);
    });
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [standardsQ.data]);

  if (!showStaffSurfaces) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <PageHeader title="Standards Explorer" />
        <EmptyState
          title="Not available"
          description="Accreditation data is restricted to staff and administrators."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Standards Explorer"
        description="Browse standards under your adopted frameworks. Rate each standard for the current cycle and link evidence."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/accreditation"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Dashboard
        </Link>
        <button
          type="button"
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
          onClick={() => setAdoptOpen(true)}
        >
          Adopt framework
        </button>
        <button
          type="button"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={() => setCustomOpen(true)}
        >
          Create custom framework
        </button>
      </div>

      {/* Framework picker */}
      {adoptedFrameworks.length === 0 ? (
        <EmptyState
          title="No frameworks adopted"
          description="Adopt a platform framework (AdvancED, IB MYP, CIS) to see its standards."
          action={
            <button
              type="button"
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white"
              onClick={() => setAdoptOpen(true)}
            >
              Adopt framework
            </button>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {adoptedFrameworks.map((f) => (
              <button
                key={f.id}
                type="button"
                className={
                  'rounded-full border px-3 py-1 text-xs ' +
                  (activeFwId === f.id
                    ? 'border-campus-600 bg-campus-50 text-campus-700'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
                }
                onClick={() => setFrameworkId(f.id)}
              >
                {f.abbreviation ?? f.name}
                <span className="ml-1 text-gray-500">({f.standardCount})</span>
              </button>
            ))}
          </div>

          {grouped.length === 0 ? (
            <EmptyState
              title="No standards yet"
              description="The selected framework does not yet expose any standards in this surface."
            />
          ) : (
            <div className="space-y-4">
              {grouped.map(([domain, items]) => (
                <section
                  key={domain}
                  className="rounded-card border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <h2 className="text-base font-semibold text-gray-900">{domain}</h2>
                  <ul className="mt-3 divide-y divide-gray-100">
                    {items.map((s) => {
                      const rating = ratingByStandard.get(s.id);
                      return (
                        <li
                          key={s.id}
                          className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start"
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                                {s.standardCode}
                              </span>
                              {rating && (
                                <span
                                  className={
                                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                                    ACC_RATING_PILL[rating]
                                  }
                                >
                                  {ACC_RATING_LABEL[rating]}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-sm text-gray-700">{s.standardText}</p>
                            {s.guidanceNotes && (
                              <p className="mt-1 text-xs text-gray-500">{s.guidanceNotes}</p>
                            )}
                          </div>
                          <div className="flex flex-col items-stretch gap-1 sm:items-end">
                            <button
                              type="button"
                              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
                              onClick={() => setRateForStandard(s)}
                            >
                              {rating ? 'Re-rate' : 'Rate'}
                            </button>
                            <Link
                              href={`/accreditation/evidence?standardId=${encodeURIComponent(s.id)}`}
                              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-center text-xs hover:bg-gray-50"
                            >
                              Evidence
                            </Link>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {/* Adopt framework modal */}
      <AdoptFrameworkModal open={adoptOpen} onClose={() => setAdoptOpen(false)} />

      {/* Custom framework modal */}
      <CreateCustomFrameworkModal open={customOpen} onClose={() => setCustomOpen(false)} />

      {/* Rate-standard modal */}
      {rateForStandard && (
        <RateStandardModal
          open={!!rateForStandard}
          onClose={() => setRateForStandard(null)}
          standard={rateForStandard}
          cycleId={cycleId}
        />
      )}
    </div>
  );
}

function AdoptFrameworkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const frameworksQ = useAccFrameworks(open);
  const adopt = useCreateAccAdoption();
  const [platformId, setPlatformId] = useState('');
  const available = (frameworksQ.data ?? []).filter((f) => f.source === 'PLATFORM' && !f.isAdopted);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!platformId) {
      toast('Pick a framework', 'error');
      return;
    }
    try {
      await adopt.mutateAsync({ platformFrameworkId: platformId });
      toast('Framework adopted', 'success');
      setPlatformId('');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Adopt accreditation framework"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="adopt-fw-form"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white"
            disabled={adopt.isPending}
          >
            Adopt
          </button>
        </div>
      }
    >
      <form id="adopt-fw-form" onSubmit={submit} className="space-y-3">
        {available.length === 0 ? (
          <p className="text-sm text-gray-500">
            All available platform frameworks are already adopted.
          </p>
        ) : (
          available.map((f) => (
            <label
              key={f.id}
              className={
                'flex cursor-pointer items-start gap-3 rounded-md border p-3 ' +
                (platformId === f.id
                  ? 'border-campus-600 bg-campus-50'
                  : 'border-gray-200 bg-white hover:bg-gray-50')
              }
            >
              <input
                type="radio"
                name="platformId"
                value={f.id}
                checked={platformId === f.id}
                onChange={() => setPlatformId(f.id)}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-gray-800">
                  {f.name} {f.abbreviation ? `(${f.abbreviation})` : ''}
                </div>
                <div className="text-xs text-gray-500">
                  {f.organisation ?? '—'} · {f.standardCount} standards
                </div>
                {f.description && <p className="mt-1 text-xs text-gray-600">{f.description}</p>}
              </div>
            </label>
          ))
        )}
      </form>
    </Modal>
  );
}

function CreateCustomFrameworkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateAccCustomFramework();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast('Name is required', 'error');
      return;
    }
    try {
      await create.mutateAsync({ name: name.trim(), description: description || undefined });
      toast('Custom framework created', 'success');
      setName('');
      setDescription('');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create custom framework"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="custom-fw-form"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white"
            disabled={create.isPending}
          >
            Create
          </button>
        </div>
      }
    >
      <form id="custom-fw-form" onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="Lincoln Teaching Excellence"
            maxLength={200}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            rows={3}
            maxLength={2000}
            placeholder="Optional context for this custom framework."
          />
        </label>
      </form>
    </Modal>
  );
}

function RateStandardModal({
  open,
  onClose,
  standard,
  cycleId,
}: {
  open: boolean;
  onClose: () => void;
  standard: AccStandardDto;
  cycleId: string;
}) {
  const { toast } = useToast();
  const rate = useCreateAccSelfStudyRating();
  const [rating, setRating] = useState<AccSelfStudyRating>('ACCOMPLISHED');
  const [rationale, setRationale] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!rationale.trim()) {
      toast('Rationale is required', 'error');
      return;
    }
    try {
      await rate.mutateAsync({
        standardId: standard.id,
        cycleId,
        rating,
        rationale: rationale.trim(),
      });
      toast('Rating saved', 'success');
      setRationale('');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Rate standard: ${standard.standardCode}`}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="rate-form"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white"
            disabled={rate.isPending}
          >
            Save rating
          </button>
        </div>
      }
    >
      <form id="rate-form" onSubmit={submit} className="space-y-3">
        <p className="rounded-md bg-gray-50 p-3 text-xs text-gray-600">{standard.standardText}</p>
        <div>
          <span className="text-sm font-medium text-gray-700">Cycle</span>
          <p className="text-xs text-gray-500">{cycleId}</p>
        </div>
        <div>
          <span className="text-sm font-medium text-gray-700">Rating</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {ACC_SELF_STUDY_RATINGS.map((r) => (
              <button
                key={r}
                type="button"
                className={
                  'rounded-full px-3 py-1 text-xs font-medium ' +
                  (rating === r
                    ? ACC_RATING_PILL[r] + ' ring-2 ring-offset-1'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
                }
                onClick={() => setRating(r)}
              >
                {ACC_RATING_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Rationale</span>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            rows={4}
            maxLength={4000}
            placeholder="Evidence-backed reasoning for this rating…"
            required
          />
        </label>
      </form>
    </Modal>
  );
}
