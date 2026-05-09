'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreatePreRegistration, useVisitorTypes } from '@/hooks/use-visitors';
import type { CreatePreRegistrationPayload } from '@/lib/types';

export default function PreRegisterPage() {
  const router = useRouter();
  const { toast } = useToast();
  const typesQ = useVisitorTypes();
  const createPreReg = useCreatePreRegistration();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [visitorTypeId, setVisitorTypeId] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [purpose, setPurpose] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [token, setToken] = useState<string | null>(null);

  const types = typesQ.data?.filter((t) => t.isActive) ?? [];

  async function handleSubmit() {
    if (!firstName || !lastName || !email || !visitorTypeId || !expectedAt) {
      toast('First name, last name, email, visitor type, and expected date are required', 'error');
      return;
    }
    const payload: CreatePreRegistrationPayload = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      visitorTypeId,
      expectedAt: new Date(expectedAt).toISOString(),
      expiresInDays,
    };
    if (company.trim()) payload.company = company.trim();
    if (phone.trim()) payload.phone = phone.trim();
    if (purpose.trim()) payload.purpose = purpose.trim();
    try {
      const r = await createPreReg.mutateAsync(payload);
      setToken(r.qrCodeToken);
      toast('Pre-registration created', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  if (token) {
    return (
      <div className="space-y-6">
        <PageHeader title="Pre-registration created" />
        <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-6">
          <h2 className="text-lg font-semibold text-emerald-900">
            Send the QR code to {firstName} {lastName}
          </h2>
          <p className="mt-1 text-sm text-emerald-800">
            They will scan this token at the kiosk for expedited sign-in.
          </p>
          <div className="mt-4 break-all rounded border border-emerald-200 bg-white p-4 font-mono text-xs text-emerald-900">
            {token}
          </div>
          <div className="mt-4 flex gap-3 flex-wrap">
            <button
              onClick={() => router.push('/visitors')}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white hover:bg-campus-800"
            >
              Back to dashboard
            </button>
            <button
              onClick={() => {
                setToken(null);
                setFirstName('');
                setLastName('');
                setCompany('');
                setEmail('');
                setPhone('');
                setPurpose('');
                setExpectedAt('');
              }}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800"
            >
              Pre-register another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pre-register a visitor"
        description="Generate a QR code for an expected visitor — they scan it at the kiosk on arrival for expedited sign-in."
      />

      <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <input
            type="text"
            placeholder="First name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Last name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <input
          type="text"
          placeholder="Company (optional)"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="grid grid-cols-2 gap-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            type="tel"
            placeholder="Phone (optional)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <select
          value={visitorTypeId}
          onChange={(e) => setVisitorTypeId(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">Visitor type…</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-3">
          <input
            type="datetime-local"
            value={expectedAt}
            onChange={(e) => setExpectedAt(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            type="number"
            min={1}
            max={60}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(parseInt(e.target.value) || 14)}
            placeholder="Expires in (days)"
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <textarea
          rows={3}
          placeholder="Purpose"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          onClick={handleSubmit}
          disabled={createPreReg.isPending}
          className="w-full rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white hover:bg-campus-800 disabled:opacity-50"
        >
          {createPreReg.isPending ? 'Creating…' : 'Create pre-registration'}
        </button>
      </div>
    </div>
  );
}
