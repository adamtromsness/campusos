'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFdsCloseSession,
  useFdsOpenSession,
  useFdsReconciliation,
  useFdsSessions,
  useFdsUpdateReconciliation,
} from '@/hooks/use-food-service';
import {
  FDS_MEAL_TYPE_LABEL,
  FDS_RECON_STATUS_LABEL,
  formatCurrency,
} from '@/lib/food-service-format';
import type { FdsMealType } from '@/lib/types';

export default function SessionsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const sessionsQ = useFdsSessions({ fromDate: monthAgo, toDate: today });
  const open = useFdsOpenSession();
  const close = useFdsCloseSession();
  const { toast } = useToast();
  const [mealType, setMealType] = useState<FdsMealType>('LUNCH');

  return (
    <div>
      <PageHeader
        title="Meal service sessions"
        description="Open / close + cash reconciliation"
        actions={
          <Link
            href="/food-service"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Food Service
          </Link>
        }
      />

      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Open a session for today</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] as FdsMealType[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMealType(m)}
              className={`rounded-lg border px-3 py-1.5 text-xs ${
                mealType === m
                  ? 'border-campus-700 bg-campus-700 text-white'
                  : 'border-gray-300 bg-white text-gray-700'
              }`}
            >
              {FDS_MEAL_TYPE_LABEL[m]}
            </button>
          ))}
          <button
            type="button"
            onClick={async () => {
              try {
                const res = await open.mutateAsync({ serviceDate: today, mealType });
                toast(
                  `Session opened — ${FDS_MEAL_TYPE_LABEL[mealType]} ${res.serviceDate}`,
                  'success',
                );
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            }}
            disabled={open.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {open.isPending ? 'Opening…' : 'Open session'}
          </button>
        </div>
      </section>

      {sessionsQ.isLoading ? (
        <LoadingSpinner />
      ) : sessionsQ.data && sessionsQ.data.length > 0 ? (
        <ul className="space-y-3">
          {sessionsQ.data.map((s) => (
            <li key={s.id} className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <div className="font-semibold text-gray-900">
                    {s.serviceDate} · {FDS_MEAL_TYPE_LABEL[s.mealType]}
                  </div>
                  <div className="text-xs text-gray-500">
                    Opened by {s.openedByName ?? 'unknown'} ·{' '}
                    {new Date(s.openedAt).toLocaleString()}
                  </div>
                </div>
                {s.closedAt ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                    Closed {new Date(s.closedAt).toLocaleTimeString()}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await close.mutateAsync(s.id);
                        toast('Session closed', 'success');
                      } catch (err) {
                        toast((err as Error).message, 'error');
                      }
                    }}
                    disabled={close.isPending}
                    className="rounded-lg bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-800 disabled:bg-gray-300"
                  >
                    Close
                  </button>
                )}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm lg:grid-cols-3">
                <Stat label="Transactions" value={s.transactionCount} />
                <Stat label="Sales" value={formatCurrency(s.totalSales)} />
              </div>
              <SessionRecon sessionId={s.id} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No sessions in the last 30 days.</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg bg-gray-50 p-2">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function SessionRecon({ sessionId }: { sessionId: string }) {
  const reconQ = useFdsReconciliation(sessionId);
  if (reconQ.isLoading || !reconQ.data) return null;
  if (reconQ.data.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {reconQ.data.map((r) => (
        <ReconRow key={r.id} reconId={r.id} />
      ))}
    </div>
  );
}

function ReconRow({ reconId }: { reconId: string }) {
  const reconQ = useFdsReconciliation(null);
  void reconQ;
  // The list query above already returned the data; pull it via useFdsReconciliation
  // would require sessionId. Instead we rely on the parent to render the row.
  return <ReconActual reconId={reconId} />;
}

function ReconActual({ reconId }: { reconId: string }) {
  const update = useFdsUpdateReconciliation(reconId);
  const { toast } = useToast();
  const [actual, setActual] = useState<string>('');
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm">
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="0.01"
          value={actual}
          onChange={(e) => setActual(e.target.value)}
          placeholder="Actual closing balance"
          className="flex-1 rounded-lg border border-gray-300 px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={async () => {
            const v = Number(actual);
            if (Number.isNaN(v)) {
              toast('Enter a number', 'error');
              return;
            }
            try {
              const res = await update.mutateAsync({ actualClosingBalance: v });
              toast(
                `Variance ${formatCurrency(res.variance)} · ${FDS_RECON_STATUS_LABEL[res.status]}`,
                res.status === 'VARIANCE_FLAGGED' ? 'error' : 'success',
              );
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
          disabled={update.isPending || !actual}
          className="rounded-lg bg-campus-700 px-3 py-1 text-sm text-white hover:bg-campus-800 disabled:bg-gray-300"
        >
          Reconcile
        </button>
      </div>
    </div>
  );
}
