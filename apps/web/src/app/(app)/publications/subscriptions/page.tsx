'use client';

import { PageHeader, useToast } from '@/components/ui';
import {
  useMySubscriptions,
  useSeries,
  useSubscribe,
  useUnsubscribe,
} from '@/hooks/use-publications';
import {
  FREQUENCY_LABELS,
  PUBLICATION_TYPE_LABELS,
  SUBSCRIPTION_STATUS_PILL,
  formatDate,
} from '@/lib/publications-format';

export default function SubscriptionsPage() {
  const { toast } = useToast();
  const my = useMySubscriptions();
  const allSeries = useSeries();

  const subscribedIds = new Set(
    (my.data ?? []).filter((s) => s.status === 'SUBSCRIBED').map((s) => s.seriesId),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageHeader
        title="My subscriptions"
        description="Series you receive in your inbox. Unsubscribe at any time."
      />

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Available series
        </h2>
        {(allSeries.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No series available.</p>
        ) : (
          <ul className="space-y-2">
            {allSeries.data!.map((s) => {
              const subscribed = subscribedIds.has(s.id);
              return (
                <li
                  key={s.id}
                  className="flex items-center justify-between rounded-md border border-gray-200 bg-white p-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">{s.title}</p>
                    <p className="text-xs text-gray-500">
                      {PUBLICATION_TYPE_LABELS[s.publicationType]} · {FREQUENCY_LABELS[s.frequency]}
                    </p>
                  </div>
                  <SubscribeToggle
                    seriesId={s.id}
                    seriesTitle={s.title}
                    subscribed={subscribed}
                    onSuccess={(action) => toast(`${action} ${s.title}`)}
                    onError={(err) => toast(`Failed: ${err}`, 'error')}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {(my.data?.length ?? 0) > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            History
          </h2>
          <ul className="space-y-2">
            {my.data!.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between rounded-md border border-gray-200 bg-white p-3 text-sm"
              >
                <div>
                  <p className="font-medium text-gray-900">{s.seriesTitle ?? s.seriesId}</p>
                  <p className="text-xs text-gray-500">
                    Subscribed {formatDate(s.subscribedAt)}
                    {s.unsubscribedAt && ` · Unsubscribed ${formatDate(s.unsubscribedAt)}`}
                  </p>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${SUBSCRIPTION_STATUS_PILL[s.status]}`}
                >
                  {s.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SubscribeToggle({
  seriesId,
  seriesTitle,
  subscribed,
  onSuccess,
  onError,
}: {
  seriesId: string;
  seriesTitle: string;
  subscribed: boolean;
  onSuccess: (action: 'Subscribed to' | 'Unsubscribed from') => void;
  onError: (err: string) => void;
}) {
  void seriesTitle;
  const sub = useSubscribe(seriesId);
  const unsub = useUnsubscribe(seriesId);
  const action = subscribed ? 'Unsubscribed from' : 'Subscribed to';
  const handle = async () => {
    try {
      if (subscribed) await unsub.mutateAsync();
      else await sub.mutateAsync();
      onSuccess(action);
    } catch (err) {
      onError((err as Error).message);
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      className={
        subscribed
          ? 'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50'
          : 'rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800'
      }
    >
      {subscribed ? 'Unsubscribe' : 'Subscribe'}
    </button>
  );
}
