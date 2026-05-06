'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useChangeRequests,
  useMyBusPass,
  useMyRidership,
  useMyTransportRoute,
  useSubmitChangeRequest,
  useTransportRouteStops,
  useTransportRoutes,
} from '@/hooks/use-transport';
import { useStudent } from '@/hooks/use-children';
import {
  CHANGE_REQUEST_STATUS_LABEL,
  CHANGE_REQUEST_STATUS_PILL,
  CHANGE_REQUEST_TYPE_LABEL,
  PASS_TYPE_LABEL,
  SCAN_DIRECTION_LABEL,
} from '@/lib/transport-format';
import type { TransportChangeRequestType } from '@/lib/types';

export default function ChildTransportPage() {
  const params = useParams<{ id: string }>();
  const studentId = params?.id ?? '';
  const studentQ = useStudent(studentId);
  const myRouteQ = useMyTransportRoute();
  const myPassQ = useMyBusPass();
  const myRidershipQ = useMyRidership();
  const changeRequestsQ = useChangeRequests();
  const [showRequest, setShowRequest] = useState(false);

  const myRoutes = (myRouteQ.data ?? []).filter((a) => a.studentId === studentId);
  const myPasses = (myPassQ.data ?? []).filter((p) => p.studentId === studentId);
  const myRidership = (myRidershipQ.data ?? []).filter((r) => r.studentId === studentId);
  const myRequests = (changeRequestsQ.data ?? []).filter((r) => r.studentId === studentId);

  return (
    <div>
      <PageHeader
        title={
          studentQ.data
            ? `${studentQ.data.firstName} ${studentQ.data.lastName} — Transport`
            : 'Transportation'
        }
        description="Route, bus pass, and ridership history"
        actions={
          <Link
            href="/children"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← My children
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Route</h2>
          {myRoutes.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No active route assignment.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {myRoutes.map((a) => (
                <li key={a.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm">
                  <div className="font-medium text-gray-900">
                    Stop #{a.stopSequence ?? '?'} · {a.stopName}
                  </div>
                  <div className="text-xs text-gray-500">
                    Direction: {a.direction} · effective {a.effectiveFrom}
                    {a.isOverride && ' · one-day override'}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => setShowRequest(true)}
            className="mt-3 rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Submit a change request
          </button>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Bus pass</h2>
          {myPasses.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No active bus pass.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {myPasses.map((p) => (
                <li key={p.id} className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <div className="font-mono text-base text-gray-900">{p.qrCodeToken}</div>
                  <div className="mt-1 text-xs text-gray-600">
                    {PASS_TYPE_LABEL[p.passType]} · valid {p.validFrom} → {p.validTo}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Recent ridership</h2>
        {myRidership.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No recent scans.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {myRidership.slice(0, 30).map((r) => (
              <li key={r.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm">
                <div className="flex justify-between">
                  <span className="font-medium text-gray-900">
                    {SCAN_DIRECTION_LABEL[r.scanDirection]} · {r.stopName ?? '—'}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(r.scannedAt).toLocaleString()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {myRequests.length > 0 && (
        <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Change requests</h2>
          <ul className="mt-3 space-y-2">
            {myRequests.map((r) => (
              <li key={r.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-900">
                      {CHANGE_REQUEST_TYPE_LABEL[r.changeType]} · {r.changeDate}
                    </div>
                    {r.reason && <div className="mt-1 text-xs text-gray-500">{r.reason}</div>}
                    {r.reviewNotes && (
                      <div className="mt-1 text-xs italic text-gray-500">
                        Review: {r.reviewNotes}
                      </div>
                    )}
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${CHANGE_REQUEST_STATUS_PILL[r.status]}`}
                  >
                    {CHANGE_REQUEST_STATUS_LABEL[r.status]}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showRequest && (
        <ChangeRequestModal studentId={studentId} onClose={() => setShowRequest(false)} />
      )}
    </div>
  );
}

function ChangeRequestModal({ studentId, onClose }: { studentId: string; onClose: () => void }) {
  const submit = useSubmitChangeRequest();
  const { toast } = useToast();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [type, setType] = useState<TransportChangeRequestType>('DIFFERENT_STOP');
  const [reason, setReason] = useState('');
  const [routeId, setRouteId] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string>('');
  const routesQ = useTransportRoutes({ status: 'ACTIVE' });
  const stopsQ = useTransportRouteStops(routeId);

  async function go() {
    try {
      await submit.mutateAsync({
        studentId,
        changeDate: date,
        changeType: type,
        requestedRouteId: type === 'DIFFERENT_ROUTE' ? (routeId ?? undefined) : undefined,
        requestedStopId: type === 'DIFFERENT_STOP' ? stopId || undefined : undefined,
        reason: reason || undefined,
      });
      toast('Request submitted', 'success');
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Submit a route change request"
      footer={
        <button
          type="button"
          onClick={go}
          disabled={submit.isPending}
          className="rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
        >
          {submit.isPending ? 'Submitting…' : 'Submit'}
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="block font-medium text-gray-700">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <fieldset>
          <legend className="block font-medium text-gray-700">Change type</legend>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {(['DIFFERENT_STOP', 'NO_BUS', 'DIFFERENT_ROUTE'] as TransportChangeRequestType[]).map(
              (t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    type === t
                      ? 'border-campus-700 bg-campus-700 text-white'
                      : 'border-gray-300 bg-white text-gray-700'
                  }`}
                >
                  {CHANGE_REQUEST_TYPE_LABEL[t]}
                </button>
              ),
            )}
          </div>
        </fieldset>
        {type === 'DIFFERENT_STOP' && (
          <>
            <label className="block">
              <span className="block font-medium text-gray-700">Route (to pick a stop from)</span>
              <select
                value={routeId ?? ''}
                onChange={(e) => {
                  setRouteId(e.target.value || null);
                  setStopId('');
                }}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Select a route</option>
                {(routesQ.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.direction})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block font-medium text-gray-700">Different stop</span>
              <select
                value={stopId}
                onChange={(e) => setStopId(e.target.value)}
                disabled={!routeId}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
              >
                <option value="">Select a stop</option>
                {(stopsQ.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    #{s.sequenceOrder} · {s.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {type === 'DIFFERENT_ROUTE' && (
          <label className="block">
            <span className="block font-medium text-gray-700">Different route</span>
            <select
              value={routeId ?? ''}
              onChange={(e) => setRouteId(e.target.value || null)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select a route</option>
              {(routesQ.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.direction})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="block font-medium text-gray-700">Reason</span>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}
