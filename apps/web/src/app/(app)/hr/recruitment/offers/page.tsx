'use client';

import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import { OFFER_STATUS_PILL, OfferDto, useOffers, useRespondToOffer } from '@/hooks/use-recruitment';

/**
 * Offer manager — admin tracker for extended offers + the candidate-
 * accept path. Admin sees every offer; candidates reach the same
 * /hr/offers/:id payload through the controller's row-scope check
 * (matched on application.person_id).
 */
export default function OffersPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, ['hr-002:read', 'hr-002:write', 'sch-001:admin']);
  const offers = useOffers();

  if (!canRead) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Offers</h1>
        <div className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
          Offer tracking is restricted to school administrators and HR staff.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Offers</h1>
        <Link className="text-sm text-sky-700 hover:underline" href="/hr/recruitment">
          ← Recruitment
        </Link>
      </div>

      {(offers.data ?? []).length === 0 ? (
        <div className="rounded border border-slate-200 bg-white p-5 text-sm text-slate-600">
          No offers yet. Offers appear here once an admin extends one from the recruitment pipeline.
        </div>
      ) : (
        <div className="space-y-3">
          {(offers.data ?? []).map((o) => (
            <OfferRow key={o.id} offer={o} />
          ))}
        </div>
      )}
    </div>
  );
}

function OfferRow({ offer }: { offer: OfferDto }) {
  const { toast } = useToast();
  const respond = useRespondToOffer(offer.id);
  const conditions = Array.isArray(offer.conditions) ? (offer.conditions as string[]) : [];
  return (
    <section className="rounded border border-slate-200 bg-white p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-base font-semibold">{offer.positionTitle}</h2>
          <div className="text-xs text-slate-500">
            ${offer.salary.toLocaleString()} · {offer.contractType.toLowerCase().replace(/_/g, ' ')}{' '}
            · start {offer.startDate}
          </div>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${OFFER_STATUS_PILL[offer.status]}`}>
          {offer.status}
        </span>
      </div>
      <div className="mt-2 text-xs text-slate-500">
        Acceptance deadline: {offer.acceptanceDeadline}
      </div>
      {conditions.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">
          {conditions.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      ) : null}
      {offer.createdEmployeeId ? (
        <div className="mt-2 rounded bg-emerald-50 p-2 text-xs text-emerald-800">
          Hire complete — hr_employees id {offer.createdEmployeeId.slice(0, 8)}
        </div>
      ) : null}
      {offer.status === 'PENDING' ? (
        <div className="mt-3 flex gap-2 text-xs">
          <button
            className="rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700"
            onClick={async () => {
              if (
                !window.confirm(
                  'Accept on behalf of the candidate? hr_employees + hr_employee_positions will be created and hr.offer.accepted will be enqueued in the platform outbox.',
                )
              )
                return;
              try {
                await respond.mutateAsync({ decision: 'ACCEPTED' });
                toast('Offer accepted — hire complete.');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Accept (admin)
          </button>
          <button
            className="rounded border border-rose-200 px-3 py-1.5 font-semibold text-rose-700 hover:bg-rose-50"
            onClick={async () => {
              if (!window.confirm('Decline this offer on behalf of the candidate?')) return;
              try {
                await respond.mutateAsync({ decision: 'DECLINED' });
                toast('Offer declined.');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Decline
          </button>
          <button
            className="rounded border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
            onClick={async () => {
              const reason = window.prompt('Withdraw the offer — reason?');
              if (reason === null) return;
              try {
                await respond.mutateAsync({ decision: 'WITHDRAWN', responseNotes: reason });
                toast('Offer withdrawn.');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Withdraw
          </button>
        </div>
      ) : null}
    </section>
  );
}
