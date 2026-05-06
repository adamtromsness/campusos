'use client';

import { use, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useFieldTrips, useSignConsent } from '@/hooks/use-clubs';
import { useAuthStore } from '@/lib/auth-store';

/**
 * Parent consent portal — `/children/:id/field-trips`. Per the
 * Cycle 17 plan, the parent sees their child's trips with a Sign
 * Consent button. The PARENT CONSENT KEYSTONE on the backend stamps
 * signed_at + ip_address + guardian_person_id and emits
 * ext.consent.received.
 */
export default function ChildFieldTripsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: studentId } = use(params);
  const user = useAuthStore((s) => s.user);
  const tripsQ = useFieldTrips(!!user);
  const [openTrip, setOpenTrip] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [consent, setConsent] = useState(true);
  const [emergency, setEmergency] = useState('');
  const [medical, setMedical] = useState('');
  const [notes, setNotes] = useState('');
  const sign = useSignConsent(openTrip?.id ?? '');
  const { toast } = useToast();

  if (!user) return null;

  // Backend `useFieldTrips` already row-scopes guardians to trips
  // where at least one of their children is a participant.
  // REVIEW-CYCLE17 BLOCKING 3 — guardians get a filtered participant
  // list per trip from `useFieldTrip(:id)`, but the list endpoint
  // returns only aggregate counts. So we render the list without a
  // participants check and consult the per-trip detail when a parent
  // opens the consent modal.
  const trips = tripsQ.data ?? [];

  // Helper: was consent already signed for this child? Read from the
  // backend-projected participants on the per-trip GET — for a
  // guardian, only their own children appear, and consentSigned
  // reflects whether THIS guardian has signed for THIS child.
  function isAlreadySigned(trip: {
    participants?: { studentId: string; consentSigned?: boolean }[];
  }) {
    return (trip.participants ?? []).find((p) => p.studentId === studentId)?.consentSigned;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Field trips" description="Your child's upcoming trips and consent forms" />
      {tripsQ.isLoading ? (
        <div className="py-12 text-center">
          <LoadingSpinner />
        </div>
      ) : trips.length === 0 ? (
        <EmptyState title="No upcoming trips" description="No field trips for this child." />
      ) : (
        <ul className="space-y-3">
          {trips.map((t) => {
            const signed = isAlreadySigned(t);
            return (
              <li key={t.id} className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-gray-900">{t.title}</h3>
                  <span className="text-xs text-gray-500">{t.tripDate}</span>
                </div>
                <p className="text-sm text-gray-600">{t.destination}</p>
                <p className="mt-1 text-xs text-gray-500">Organiser: {t.organiserName ?? '—'}</p>
                <div className="mt-3">
                  {signed ? (
                    <span className="inline-block rounded bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700">
                      ✓ Consent signed
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenTrip({ id: t.id, title: t.title });
                        setConsent(true);
                        setEmergency('');
                        setMedical('');
                        setNotes('');
                      }}
                      className="rounded bg-campus-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-campus-600"
                    >
                      Sign consent
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={openTrip !== null}
        title={openTrip ? `Sign consent — ${openTrip.title}` : ''}
        onClose={() => setOpenTrip(null)}
        size="lg"
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
              onClick={() => setOpenTrip(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={sign.isPending || !openTrip}
              className="rounded bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-600 disabled:opacity-50"
              onClick={async () => {
                if (!openTrip) return;
                try {
                  await sign.mutateAsync({
                    studentId,
                    consentGiven: consent,
                    emergencyContactOverride: emergency.trim() || undefined,
                    medicalNotesOverride: medical.trim() || undefined,
                    notes: notes.trim() || undefined,
                  });
                  toast(consent ? 'Consent recorded' : 'Decline recorded', 'success');
                  setOpenTrip(null);
                } catch (err) {
                  toast(
                    (err as { message?: string })?.message ?? 'Failed to record consent',
                    'error',
                  );
                }
              }}
            >
              {sign.isPending ? 'Recording…' : consent ? 'Record consent' : 'Record decline'}
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
            By signing, you confirm you are the linked guardian and consent to the school&apos;s
            standard field trip terms. Your IP address and the timestamp will be recorded.
          </div>
          <fieldset>
            <legend className="mb-1 block font-medium text-gray-700">Consent</legend>
            <label className="mr-4 inline-flex items-center gap-1">
              <input
                type="radio"
                name="consent"
                checked={consent}
                onChange={() => setConsent(true)}
              />
              <span>I give consent</span>
            </label>
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                name="consent"
                checked={!consent}
                onChange={() => setConsent(false)}
              />
              <span>I decline</span>
            </label>
          </fieldset>
          <div>
            <label htmlFor="ec" className="mb-1 block font-medium text-gray-700">
              Emergency contact (optional override)
            </label>
            <input
              id="ec"
              value={emergency}
              onChange={(e) => setEmergency(e.target.value)}
              maxLength={500}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
              placeholder="Name + phone if different from school records"
            />
          </div>
          <div>
            <label htmlFor="med" className="mb-1 block font-medium text-gray-700">
              Medical notes (optional)
            </label>
            <textarea
              id="med"
              value={medical}
              onChange={(e) => setMedical(e.target.value)}
              maxLength={2000}
              rows={2}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
              placeholder="Allergies / medications / accommodations specific to this trip"
            />
          </div>
          <div>
            <label htmlFor="notes" className="mb-1 block font-medium text-gray-700">
              Additional notes (optional)
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={2}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
