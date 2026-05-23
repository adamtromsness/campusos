'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useEngagementScores,
  useEngagementSummary,
  useScoreConfig,
  useUpdateScoreConfig,
} from '@/hooks/use-engagement';
import type {
  EngagementLevel,
  EngagementLevelThresholds,
  EngagementScoreDto,
  EngagementScoreWeights,
} from '@/lib/types';
import { ENGAGEMENT_LEVELS } from '@/lib/types';
import {
  buildComponentRows,
  ENGAGEMENT_LEVEL_BAR,
  ENGAGEMENT_LEVEL_LABEL,
  ENGAGEMENT_LEVEL_PILL,
  engagementScoreToneBar,
  engagementScoreToneText,
  formatDateOnly,
} from '@/lib/engagement-format';

export default function EngagementDashboardPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin', 'eng-001:admin']);
  const isStaff = user?.activePersona?.type === 'STAFF' || isAdmin;
  const canRead =
    isAdmin ||
    (isStaff && hasAnyPermission(user, ['eng-001:read', 'eng-001:write', 'eng-001:admin']));

  const [levelFilter, setLevelFilter] = useState<EngagementLevel | 'ALL'>('ALL');
  const [showConfig, setShowConfig] = useState(false);
  const [expandedFamily, setExpandedFamily] = useState<string | null>(null);

  const summaryQ = useEngagementSummary(canRead);
  const scoresQ = useEngagementScores(levelFilter === 'ALL' ? {} : { level: levelFilter }, canRead);
  const configQ = useScoreConfig(canRead);

  const totalFamilies = summaryQ.data?.totalFamilies ?? 0;
  const averageScore = summaryQ.data?.averageScore ?? 0;
  const byLevel = summaryQ.data?.byLevel;

  const sortedScores = useMemo(() => {
    return [...(scoresQ.data ?? [])].sort((a, b) => a.compositeScore - b.compositeScore);
  }, [scoresQ.data]);

  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <PageHeader title="Engagement Dashboard" />
        <EmptyState
          title="Not available"
          description="Engagement scoring is restricted to school staff and administrators."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Family Engagement Dashboard"
        description="Composite score per family across attendance, communications, conferences, volunteering, and on-time payments. Score-weight configuration is admin-only."
      />

      {/* Module nav strip */}
      <nav className="flex flex-wrap gap-2 text-sm">
        <Link
          href="/engagement/conferences"
          className="rounded-full bg-campus-50 px-3 py-1 font-medium text-campus-700 hover:bg-campus-100"
        >
          Conferences →
        </Link>
        <Link
          href="/engagement/surveys"
          className="rounded-full bg-campus-50 px-3 py-1 font-medium text-campus-700 hover:bg-campus-100"
        >
          Surveys →
        </Link>
      </nav>

      {/* Headline stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Families scored" value={totalFamilies} />
        <StatCard
          label="Average score"
          value={averageScore.toFixed(1)}
          tone={averageScore >= 50 ? 'emerald' : 'rose'}
        />
        {(['HIGHLY_ENGAGED', 'ENGAGED', 'MINIMAL', 'AT_RISK'] as const).map((level) => (
          <StatCard
            key={level}
            label={ENGAGEMENT_LEVEL_LABEL[level]}
            value={byLevel?.[level] ?? 0}
            tone={
              level === 'HIGHLY_ENGAGED'
                ? 'emerald'
                : level === 'ENGAGED'
                  ? 'sky'
                  : level === 'MINIMAL'
                    ? 'amber'
                    : 'rose'
            }
          />
        ))}
      </div>

      {/* Distribution bar */}
      {byLevel && totalFamilies > 0 ? (
        <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">
            Engagement distribution{' '}
            {summaryQ.data?.scoreDate ? `(${formatDateOnly(summaryQ.data.scoreDate)})` : ''}
          </h2>
          <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-gray-100">
            <div className="flex h-full w-full">
              {ENGAGEMENT_LEVELS.map((lvl) => {
                const count = byLevel[lvl];
                const pct = totalFamilies === 0 ? 0 : (count / totalFamilies) * 100;
                if (pct === 0) return null;
                return (
                  <div
                    key={lvl}
                    className={'h-full ' + ENGAGEMENT_LEVEL_BAR[lvl]}
                    style={{ width: `${pct}%` }}
                    title={`${ENGAGEMENT_LEVEL_LABEL[lvl]}: ${count}`}
                  />
                );
              })}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-gray-500 sm:grid-cols-4">
            {ENGAGEMENT_LEVELS.map((lvl) => (
              <div key={lvl}>
                <span
                  className={'mr-1 inline-block h-2 w-2 rounded-full ' + ENGAGEMENT_LEVEL_BAR[lvl]}
                />
                {ENGAGEMENT_LEVEL_LABEL[lvl]} ·{' '}
                <span className="font-medium text-gray-700">{byLevel[lvl]}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Level filter + config */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setLevelFilter('ALL')}
            className={
              'rounded-full px-3 py-1 text-xs font-medium ring-1 ' +
              (levelFilter === 'ALL'
                ? 'bg-campus-600 text-white ring-campus-600'
                : 'bg-white text-gray-700 ring-gray-200 hover:bg-gray-50')
            }
          >
            All families
          </button>
          {ENGAGEMENT_LEVELS.map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => setLevelFilter(lvl)}
              className={
                'rounded-full px-3 py-1 text-xs font-medium ring-1 ' +
                (levelFilter === lvl
                  ? 'bg-campus-600 text-white ring-campus-600'
                  : 'bg-white text-gray-700 ring-gray-200 hover:bg-gray-50')
              }
            >
              {ENGAGEMENT_LEVEL_LABEL[lvl]}
            </button>
          ))}
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => setShowConfig(true)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Configure weights
          </button>
        ) : null}
      </div>

      {/* AT_RISK callout for outreach */}
      {levelFilter === 'ALL' && (byLevel?.AT_RISK ?? 0) > 0 ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <strong>{byLevel?.AT_RISK ?? 0}</strong> families are flagged{' '}
          <span className="font-semibold">AT_RISK</span>. Filter to “At Risk” below for outreach
          targeting.
        </div>
      ) : null}

      {/* Family list with score bar + component radar (numeric) */}
      {sortedScores.length === 0 ? (
        <EmptyState
          title="No engagement scores"
          description="The EngagementScoreWorker has not run yet, or no families have data for this filter."
        />
      ) : (
        <ul className="space-y-2">
          {sortedScores.map((s) => (
            <FamilyScoreCard
              key={s.id}
              score={s}
              weights={configQ.data?.weights}
              expanded={expandedFamily === s.familyAccountId}
              onToggle={() =>
                setExpandedFamily((cur) => (cur === s.familyAccountId ? null : s.familyAccountId))
              }
            />
          ))}
        </ul>
      )}

      {showConfig && configQ.data ? (
        <ConfigureWeightsModal
          weights={configQ.data.weights}
          thresholds={configQ.data.thresholds}
          onClose={() => setShowConfig(false)}
        />
      ) : null}
    </div>
  );
}

function FamilyScoreCard({
  score,
  weights,
  expanded,
  onToggle,
}: {
  score: EngagementScoreDto;
  weights: EngagementScoreWeights | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const rows = buildComponentRows(
    weights ?? { attendance: 20, communication: 25, conference: 25, volunteer: 15, payment: 15 },
    {
      attendance: score.attendanceComponent,
      communication: score.communicationComponent,
      conference: score.conferenceComponent,
      volunteer: score.volunteerComponent,
      payment: score.paymentComponent,
    },
  );

  return (
    <li className="rounded-card border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 p-4 text-left hover:bg-gray-50"
      >
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-gray-500">
              {score.familyAccountId.slice(0, 8)}…
            </span>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' +
                ENGAGEMENT_LEVEL_PILL[score.engagementLevel]
              }
            >
              {ENGAGEMENT_LEVEL_LABEL[score.engagementLevel]}
            </span>
            <span className="text-xs text-gray-500">{formatDateOnly(score.scoreDate)}</span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
              <div
                className={'h-full ' + engagementScoreToneBar(score.compositeScore)}
                style={{ width: `${score.compositeScore}%` }}
              />
            </div>
            <span
              className={'text-sm font-semibold ' + engagementScoreToneText(score.compositeScore)}
            >
              {score.compositeScore}/100
            </span>
          </div>
        </div>
      </button>
      {expanded ? (
        <div className="border-t border-gray-100 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Components
          </h4>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="py-1 text-left">Source</th>
                <th className="py-1 text-right">Weight</th>
                <th className="py-1 text-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-gray-100">
                  <td className="py-1.5 text-gray-700">{row.label}</td>
                  <td className="py-1.5 text-right text-gray-500">{row.weight}%</td>
                  <td className="py-1.5 text-right font-medium text-gray-900">
                    {row.value === null ? '—' : `${row.value}/100`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </li>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'emerald' | 'sky' | 'amber' | 'rose';
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'sky'
        ? 'text-sky-700'
        : tone === 'amber'
          ? 'text-amber-700'
          : tone === 'rose'
            ? 'text-rose-700'
            : 'text-gray-900';
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={'mt-1 text-2xl font-semibold ' + valueClass}>{value}</div>
    </div>
  );
}

function ConfigureWeightsModal({
  weights,
  thresholds,
  onClose,
}: {
  weights: EngagementScoreWeights;
  thresholds: EngagementLevelThresholds;
  onClose: () => void;
}) {
  const updateMut = useUpdateScoreConfig();
  const [w, setW] = useState<EngagementScoreWeights>(weights);
  const [t, setT] = useState<EngagementLevelThresholds>(thresholds);
  const [error, setError] = useState<string | null>(null);

  const sum = w.attendance + w.communication + w.conference + w.volunteer + w.payment;
  const sumValid = Math.abs(sum - 100) <= 0.5;
  const thresholdsValid =
    t.highlyEngaged > t.engaged &&
    t.engaged > t.minimal &&
    t.minimal >= 0 &&
    t.highlyEngaged <= 100;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await updateMut.mutateAsync({ weights: w, thresholds: t });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={submit} className="w-full max-w-lg rounded-card bg-white p-5 shadow-lg">
        <h2 className="text-lg font-semibold text-gray-900">Engagement score configuration</h2>
        <p className="mt-1 text-sm text-gray-500">
          Component weights must sum to 100. Schools can prioritise differently (e.g. weight
          volunteering at 30% if it’s a strategic focus).
        </p>

        <div className="mt-4 space-y-3">
          <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Weights</h3>
            {(['attendance', 'communication', 'conference', 'volunteer', 'payment'] as const).map(
              (k) => (
                <label key={k} className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-sm text-gray-700 capitalize">{k}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={w[k]}
                    onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })}
                    className="w-20 rounded-md border border-gray-300 px-2 py-1 text-right text-sm"
                  />
                </label>
              ),
            )}
            <div
              className={
                'mt-2 flex items-center justify-between text-xs ' +
                (sumValid ? 'text-emerald-700' : 'text-rose-700')
              }
            >
              <span>Sum</span>
              <span className="font-semibold">{sum}/100</span>
            </div>
          </div>

          <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Level thresholds
            </h3>
            {(['highlyEngaged', 'engaged', 'minimal'] as const).map((k) => (
              <label key={k} className="mt-2 flex items-center justify-between gap-3">
                <span className="text-sm text-gray-700">{k}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={t[k]}
                  onChange={(e) => setT({ ...t, [k]: Number(e.target.value) })}
                  className="w-20 rounded-md border border-gray-300 px-2 py-1 text-right text-sm"
                />
              </label>
            ))}
            <p className={'mt-2 text-xs ' + (thresholdsValid ? 'text-gray-500' : 'text-rose-700')}>
              Must satisfy: highlyEngaged &gt; engaged &gt; minimal &ge; 0; highlyEngaged &le; 100.
            </p>
          </div>
        </div>

        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={updateMut.isPending || !sumValid || !thresholdsValid}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            {updateMut.isPending ? 'Saving…' : 'Save configuration'}
          </button>
        </div>
      </form>
    </div>
  );
}
