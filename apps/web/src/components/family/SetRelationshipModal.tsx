'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { usePeopleSearch, type PeopleSearchResult } from '@/hooks/use-family-children';
import {
  CUSTODY_LABELS,
  RELATIONSHIP_LABELS,
  useCreateRelationship,
  type CustodyArrangement,
  type RelationshipType,
} from '@/hooks/use-relationships';

// The subset of relationship types a caller may create directly (the
// reciprocal-only *_CHILD / *_WARD / GRANDCHILD types are never set by
// hand — the API generates them). Kept in sync with the server's
// CREATABLE_RELATIONSHIP_TYPES.
export type CreatableRelationshipType =
  | 'BIOLOGICAL_MOTHER'
  | 'BIOLOGICAL_FATHER'
  | 'ADOPTIVE_MOTHER'
  | 'ADOPTIVE_FATHER'
  | 'STEP_MOTHER'
  | 'STEP_FATHER'
  | 'LEGAL_GUARDIAN'
  | 'SPOUSE'
  | 'DOMESTIC_PARTNER'
  | 'GRANDPARENT';

export type RelationshipModalMode = 'mother' | 'father' | 'spouse' | 'other';

const TYPE_OPTIONS: Record<RelationshipModalMode, CreatableRelationshipType[]> = {
  mother: ['BIOLOGICAL_MOTHER', 'ADOPTIVE_MOTHER', 'STEP_MOTHER'],
  father: ['BIOLOGICAL_FATHER', 'ADOPTIVE_FATHER', 'STEP_FATHER'],
  spouse: ['SPOUSE', 'DOMESTIC_PARTNER'],
  other: [
    'LEGAL_GUARDIAN',
    'GRANDPARENT',
    'SPOUSE',
    'DOMESTIC_PARTNER',
    'BIOLOGICAL_MOTHER',
    'BIOLOGICAL_FATHER',
    'ADOPTIVE_MOTHER',
    'ADOPTIVE_FATHER',
    'STEP_MOTHER',
    'STEP_FATHER',
  ],
};

const MODE_TITLES: Record<RelationshipModalMode, string> = {
  mother: 'Set Mother',
  father: 'Set Father',
  spouse: 'Add Spouse / Partner',
  other: 'Add Relationship',
};

const CUSTODY_VALUES: CustodyArrangement[] = [
  'FULL',
  'JOINT',
  'WEEKDAYS',
  'WEEKENDS',
  'SUMMERS',
  'SUPERVISED',
  'NONE',
];

// Custody only makes sense for parent / guardian relationships, not for
// a spouse/partner link between two adults.
const NON_CUSTODY_TYPES = new Set<string>(['SPOUSE', 'DOMESTIC_PARTNER']);

interface Props {
  open: boolean;
  onClose: () => void;
  // iam_person id of the subject whose relationship is being set.
  personId: string;
  mode: RelationshipModalMode;
}

export function SetRelationshipModal({ open, onClose, personId, mode }: Props) {
  const { toast } = useToast();
  const create = useCreateRelationship(personId);

  const typeOptions = TYPE_OPTIONS[mode];
  const [type, setType] = useState<CreatableRelationshipType>(typeOptions[0]!);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PeopleSearchResult | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [custodyArrangement, setCustodyArrangement] = useState<CustodyArrangement | ''>('');
  const [isPrimaryResidence, setIsPrimaryResidence] = useState(false);
  const [notes, setNotes] = useState('');
  const [startDate, setStartDate] = useState('');

  const search = usePeopleSearch(query, open && !selected);
  const showCustody = !NON_CUSTODY_TYPES.has(type);

  // Reset the form each time the modal (re)opens or the mode changes.
  useEffect(() => {
    if (!open) return;
    setType(typeOptions[0]!);
    setQuery('');
    setSelected(null);
    setFirstName('');
    setLastName('');
    setCustodyArrangement('');
    setIsPrimaryResidence(false);
    setNotes('');
    setStartDate('');
    // typeOptions is stable per mode; depending on `mode` is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  const canSave = useMemo(() => {
    const hasLinked = !!selected;
    const hasName = firstName.trim().length > 0 && lastName.trim().length > 0;
    return (hasLinked || hasName) && !create.isPending;
  }, [selected, firstName, lastName, create.isPending]);

  async function onSave() {
    try {
      await create.mutateAsync({
        relationshipType: type as RelationshipType,
        relatedPersonId: selected?.id,
        relatedPersonName: selected ? undefined : `${firstName.trim()} ${lastName.trim()}`.trim(),
        custodyArrangement: showCustody && custodyArrangement ? custodyArrangement : undefined,
        isPrimaryResidence: showCustody ? isPrimaryResidence : undefined,
        custodyNotes: showCustody && notes.trim() ? notes.trim() : undefined,
        startDate: startDate || undefined,
      });
      toast('Relationship saved', 'success');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save relationship.', 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={MODE_TITLES[mode]}
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {create.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 1. Search for a CampusOS user */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-700">
            Search for a CampusOS user
          </label>
          {selected ? (
            <div className="flex items-center justify-between rounded-md border border-campus-200 bg-campus-50 px-3 py-2">
              <span className="text-sm text-gray-900">
                {selected.firstName} {selected.lastName}
                {selected.email && <span className="text-gray-500"> · {selected.email}</span>}
              </span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-xs font-medium text-campus-700 hover:underline"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or email…"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
              {query.trim().length >= 2 && (
                <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-gray-200">
                  {search.isLoading && (
                    <p className="px-3 py-2 text-xs text-gray-500">Searching…</p>
                  )}
                  {!search.isLoading && (search.data?.length ?? 0) === 0 && (
                    <p className="px-3 py-2 text-xs text-gray-500">No CampusOS users found.</p>
                  )}
                  {search.data?.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between border-b border-gray-100 px-3 py-2 last:border-b-0"
                    >
                      <span className="text-sm text-gray-800">
                        {r.firstName} {r.lastName}
                        {r.email && <span className="text-gray-500"> · {r.email}</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelected(r)}
                        className="rounded border border-campus-300 px-2 py-0.5 text-xs font-medium text-campus-700 hover:bg-campus-50"
                      >
                        Select
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* 2. Or enter a name (non-CampusOS person) */}
        {!selected && (
          <div className="rounded-md border border-dashed border-gray-300 p-3">
            <p className="mb-2 text-xs text-gray-600">
              — or enter a name (if they&rsquo;re not on CampusOS) —
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="First name"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Last name"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </div>
          </div>
        )}

        {/* 3. Relationship type */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-700">Relationship type</label>
          <div className="flex flex-col gap-1">
            {typeOptions.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm text-gray-800">
                <input
                  type="radio"
                  name="relationship-type"
                  checked={type === t}
                  onChange={() => setType(t)}
                  className="text-campus-600 focus:ring-campus-500"
                />
                {RELATIONSHIP_LABELS[t]}
              </label>
            ))}
          </div>
        </div>

        {/* 4. Custody (parent/guardian types only) */}
        {showCustody && (
          <div className="rounded-md border border-gray-200 p-3">
            <p className="mb-2 text-xs font-semibold text-gray-700">Custody</p>
            <div className="flex flex-col gap-2">
              <label className="text-xs text-gray-600">
                Arrangement
                <select
                  value={custodyArrangement}
                  onChange={(e) => setCustodyArrangement(e.target.value as CustodyArrangement | '')}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
                >
                  <option value="">Not specified</option>
                  {CUSTODY_VALUES.map((c) => (
                    <option key={c} value={c}>
                      {CUSTODY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-800">
                <input
                  type="checkbox"
                  checked={isPrimaryResidence}
                  onChange={(e) => setIsPrimaryResidence(e.target.checked)}
                  className="rounded text-campus-600 focus:ring-campus-500"
                />
                Primary residence
              </label>
              <label className="text-xs text-gray-600">
                Notes
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Alternating weeks"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
                />
              </label>
            </div>
          </div>
        )}

        {/* 5. Start date */}
        <label className="text-xs text-gray-600">
          Start date (optional) — marriage date, adoption date, etc.
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className={cn(
              'mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm',
              'focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500',
            )}
          />
        </label>
      </div>
    </Modal>
  );
}
