'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useCreateSignIn,
  useScanPreRegistration,
  useVisitorLookup,
  useVisitorTypes,
} from '@/hooks/use-visitors';
import type { CreateSignInPayload, SignInDto } from '@/lib/types';
import { BADGE_COLOR_PILL } from '@/lib/visitors-format';

/**
 * /visitors/kiosk — full-screen kiosk sign-in surface (designed for
 * a tablet at reception). Two flows:
 *
 *   1. Scan a pre-registration QR token — paste/type the token and
 *      submit; the kiosk auto-creates the sign-in via the backend
 *      keystone. Re-scan returns 410 Gone.
 *
 *   2. New / returning walk-up — type the visitor's email; the
 *      lookup endpoint runs the HMAC blind-index match and pre-fills
 *      the form when a returning visitor is detected. Submit creates
 *      the sign-in (which runs the banned-persons HMAC check before
 *      INSERT).
 */
export default function KioskPage() {
  const { toast } = useToast();
  const typesQ = useVisitorTypes();
  const createSignIn = useCreateSignIn();
  const scanPreReg = useScanPreRegistration();

  const [qrToken, setQrToken] = useState('');
  const [email, setEmail] = useState('');
  const [debouncedEmail, setDebouncedEmail] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [visitorTypeId, setVisitorTypeId] = useState<string>('');
  const [purpose, setPurpose] = useState('');
  const [confirmation, setConfirmation] = useState<SignInDto | null>(null);

  const lookupQ = useVisitorLookup(debouncedEmail);
  const lookupHit = lookupQ.data;

  // Auto-fill on returning visitor
  const types = typesQ.data ?? [];
  const visibleTypes = types.filter((t) => t.isActive);

  function checkReturning() {
    if (email.trim().length > 5) setDebouncedEmail(email.trim());
  }

  function applyLookup() {
    if (!lookupHit) return;
    setFirstName(lookupHit.firstName);
    setLastName(lookupHit.lastName);
    setVisitorTypeId(lookupHit.visitorTypeId);
    if (lookupHit.company) setCompany(lookupHit.company);
  }

  async function handleScan() {
    const token = qrToken.trim();
    if (token.length !== 64) {
      toast('QR token must be 64 hex characters (32 bytes)', 'error');
      return;
    }
    try {
      const r = await scanPreReg.mutateAsync(token);
      setConfirmation(r);
      setQrToken('');
    } catch (err) {
      const message = (err as Error & { status?: number }).message ?? 'Scan failed';
      toast(message, 'error');
    }
  }

  async function handleSignIn() {
    if (!firstName || !lastName || !email || !visitorTypeId) {
      toast('First name, last name, email, and visitor type are required', 'error');
      return;
    }
    const payload: CreateSignInPayload = {
      visitorTypeId,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
    };
    if (company.trim()) payload.company = company.trim();
    if (phone.trim()) payload.phone = phone.trim();
    if (purpose.trim()) payload.purpose = purpose.trim();
    if (lookupHit) payload.visitorId = lookupHit.id;
    try {
      const r = await createSignIn.mutateAsync(payload);
      setConfirmation(r);
      // Reset form
      setEmail('');
      setDebouncedEmail(null);
      setFirstName('');
      setLastName('');
      setCompany('');
      setPhone('');
      setPurpose('');
    } catch (err) {
      // BLOCKED responses surface here as a generic 403 Forbidden
      // with the neutral "please see reception staff" message — the
      // kiosk never reveals the ban detail.
      const status = (err as Error & { status?: number }).status;
      if (status === 403) {
        toast('Please see reception staff', 'error');
      } else {
        toast((err as Error).message, 'error');
      }
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Kiosk sign-in"
        description="Scan a QR code from your pre-registration email, or type your details to sign in as a new or returning visitor."
      />

      {/* Confirmation */}
      {confirmation && (
        <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-6">
          <h2 className="text-lg font-semibold text-emerald-900">
            ✓ Welcome, {confirmation.visitorName}
          </h2>
          <p className="mt-1 text-sm text-emerald-800">
            You are signed in as a{' '}
            <span
              className={
                'inline-flex rounded px-2 py-0.5 text-xs font-medium ' +
                (BADGE_COLOR_PILL[confirmation.badgeColor] ?? '')
              }
            >
              {confirmation.visitorTypeName}
            </span>
            . Please collect your badge from reception.
          </p>
          <button
            onClick={() => setConfirmation(null)}
            className="mt-4 text-sm font-medium text-emerald-800 underline"
          >
            Sign in another visitor
          </button>
        </div>
      )}

      {!confirmation && (
        <>
          {/* QR scan */}
          <section className="rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="text-base font-semibold text-gray-900">Have a QR code?</h2>
            <p className="mt-1 text-sm text-gray-600">
              Paste the 64-character token from your pre-registration email below. (In production
              this is a camera scan.)
            </p>
            <div className="mt-3 flex gap-2 flex-wrap">
              <input
                type="text"
                value={qrToken}
                onChange={(e) => setQrToken(e.target.value)}
                placeholder="QR code token"
                className="flex-1 min-w-[200px] rounded border border-gray-300 px-3 py-2 text-sm font-mono"
              />
              <button
                onClick={handleScan}
                disabled={scanPreReg.isPending}
                className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
              >
                Scan
              </button>
            </div>
          </section>

          {/* Manual sign-in */}
          <section className="rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="text-base font-semibold text-gray-900">Or sign in by email</h2>
            <p className="mt-1 text-sm text-gray-600">
              We will look you up by email — returning visitors are auto-filled.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2 flex gap-2">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={checkReturning}
                  placeholder="Your email"
                  className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={checkReturning}
                  className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
                >
                  Check
                </button>
              </div>
              {lookupHit && (
                <div className="sm:col-span-2 rounded border border-sky-200 bg-sky-50 p-3 text-sm">
                  <div>
                    Welcome back,{' '}
                    <strong>
                      {lookupHit.firstName} {lookupHit.lastName}
                    </strong>
                    {lookupHit.company ? ' (' + lookupHit.company + ')' : ''}
                  </div>
                  <button
                    type="button"
                    onClick={applyLookup}
                    className="mt-1 text-sky-700 underline"
                  >
                    Use these details
                  </button>
                </div>
              )}
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="First name"
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Last name"
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Company (if applicable)"
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone (optional)"
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <select
                value={visitorTypeId}
                onChange={(e) => setVisitorTypeId(e.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Visitor type…</option>
                {visibleTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Purpose of visit"
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <button
              onClick={handleSignIn}
              disabled={createSignIn.isPending}
              className="mt-4 w-full rounded-md bg-campus-700 px-4 py-3 text-base font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
            >
              {createSignIn.isPending ? 'Signing in…' : 'Sign in'}
            </button>
          </section>
        </>
      )}
    </div>
  );
}
