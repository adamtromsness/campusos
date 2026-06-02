'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  CUSTODY_LABELS,
  personDisplayName,
  RELATIONSHIP_LABELS,
  SIBLING_LABELS,
  useDeleteRelationship,
  useRelationships,
  useUpdateRelationship,
  type CustodyArrangement,
  type Relationship,
} from '@/hooks/use-relationships';
import { SetRelationshipModal, type RelationshipModalMode } from './SetRelationshipModal';

const MOTHER_TYPES = ['BIOLOGICAL_MOTHER', 'ADOPTIVE_MOTHER', 'STEP_MOTHER'];
const FATHER_TYPES = ['BIOLOGICAL_FATHER', 'ADOPTIVE_FATHER', 'STEP_FATHER'];
const SPOUSE_TYPES = ['SPOUSE', 'DOMESTIC_PARTNER'];
const CHILD_TYPES = ['BIOLOGICAL_CHILD', 'ADOPTIVE_CHILD', 'STEP_CHILD', 'LEGAL_WARD'];

interface Props {
  // iam_person id of the subject.
  personId: string;
  // 'child' — full management from the child's profile.
  // 'self' — adult's own profile; parent/child rows are read-only, only
  // spouse/partner is editable.
  variant: 'child' | 'self';
}

export function FamilyStructureSection({ personId, variant }: Props) {
  const { data, isLoading } = useRelationships(personId);
  const [addMode, setAddMode] = useState<RelationshipModalMode | null>(null);
  const [editing, setEditing] = useState<Relationship | null>(null);

  if (isLoading) {
    return (
      <Section title="Family Structure">
        <p className="text-sm text-gray-500">Loading…</p>
      </Section>
    );
  }

  // Edit permission is the server's call (parent/guardian-only) — the API
  // returns canEdit on the relationships response. The UI only renders
  // affordances; the server re-checks every mutation.
  const canManage = data?.canEdit ?? false;
  const rels = data?.relationships ?? [];
  const siblings = data?.derivedSiblings ?? [];
  const mother = rels.find((r) => MOTHER_TYPES.includes(r.type));
  const father = rels.find((r) => FATHER_TYPES.includes(r.type));
  const parentIds = new Set([mother?.id, father?.id].filter(Boolean));

  // Rows shown in the "other relationships" block depend on variant.
  const editableType = (t: string) => (variant === 'child' ? true : SPOUSE_TYPES.includes(t));

  if (variant === 'self') {
    const spouses = rels.filter((r) => SPOUSE_TYPES.includes(r.type));
    const parents = rels.filter((r) =>
      [...MOTHER_TYPES, ...FATHER_TYPES, 'LEGAL_GUARDIAN'].includes(r.type),
    );
    const children = rels.filter((r) => CHILD_TYPES.includes(r.type));
    const others = rels.filter(
      (r) =>
        !SPOUSE_TYPES.includes(r.type) &&
        ![...MOTHER_TYPES, ...FATHER_TYPES, 'LEGAL_GUARDIAN'].includes(r.type) &&
        !CHILD_TYPES.includes(r.type),
    );
    return (
      <Section
        title="Family Structure"
        description="Your biological, legal, and step-family relationships. Children's relationships are managed from each child's profile."
        viewHref={`/family/${personId}/structure`}
      >
        <Group label="Spouse / Partner">
          {spouses.length === 0 ? (
            <Empty>Not specified</Empty>
          ) : (
            spouses.map((r) => (
              <RelationshipCard
                key={r.id}
                rel={r}
                canManage={canManage}
                onEdit={() => setEditing(r)}
                personId={personId}
              />
            ))
          )}
          {canManage && (
            <AddButton onClick={() => setAddMode('spouse')} label="+ Add spouse/partner" />
          )}
        </Group>

        {parents.length > 0 && (
          <Group label="Parents">
            {parents.map((r) => (
              <RelationshipCard key={r.id} rel={r} canManage={false} personId={personId} />
            ))}
          </Group>
        )}

        {children.length > 0 && (
          <Group label="Children">
            {children.map((r) => (
              <RelationshipCard key={r.id} rel={r} canManage={false} personId={personId} />
            ))}
          </Group>
        )}

        {others.length > 0 && (
          <Group label="Other">
            {others.map((r) => (
              <RelationshipCard key={r.id} rel={r} canManage={false} personId={personId} />
            ))}
          </Group>
        )}

        {siblings.length > 0 && <SiblingList siblings={siblings} />}

        {addMode && (
          <SetRelationshipModal
            open
            mode={addMode}
            personId={personId}
            onClose={() => setAddMode(null)}
          />
        )}
        {editing && (
          <EditCustodyModal personId={personId} rel={editing} onClose={() => setEditing(null)} />
        )}
      </Section>
    );
  }

  // variant === 'child'
  const others = rels.filter((r) => !parentIds.has(r.id));
  return (
    <Section
      title="Family Structure (optional)"
      description="Biological and legal relationships. Helps schools understand custody arrangements and family connections."
      viewHref={`/family/${personId}/structure`}
    >
      <ParentSlot
        label="Mother"
        rel={mother}
        canManage={canManage}
        onSet={() => setAddMode('mother')}
        onEdit={() => mother && setEditing(mother)}
        personId={personId}
      />
      <ParentSlot
        label="Father"
        rel={father}
        canManage={canManage}
        onSet={() => setAddMode('father')}
        onEdit={() => father && setEditing(father)}
        personId={personId}
      />

      {others.length > 0 && (
        <Group label="Other relationships">
          {others.map((r) => (
            <RelationshipCard
              key={r.id}
              rel={r}
              canManage={canManage && editableType(r.type)}
              onEdit={() => setEditing(r)}
              personId={personId}
            />
          ))}
        </Group>
      )}

      {siblings.length > 0 && <SiblingList siblings={siblings} />}

      {canManage && (
        <div className="pt-1">
          <AddButton onClick={() => setAddMode('other')} label="+ Add other relationship" />
        </div>
      )}

      {addMode && (
        <SetRelationshipModal
          open
          mode={addMode}
          personId={personId}
          onClose={() => setAddMode(null)}
        />
      )}
      {editing && (
        <EditCustodyModal personId={personId} rel={editing} onClose={() => setEditing(null)} />
      )}
    </Section>
  );
}

// ─── Sub-components ───────────────────────────────────────────

function Section({
  title,
  description,
  viewHref,
  children,
}: {
  title: string;
  description?: string;
  // When set, renders a "View family structure →" link to the read-only
  // page in the header.
  viewHref?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-gray-600">{description}</p>}
        </div>
        {viewHref && (
          <Link
            href={viewHref}
            className="shrink-0 whitespace-nowrap text-xs font-medium text-campus-700 hover:underline"
          >
            View family structure →
          </Link>
        )}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400">{children}</p>;
}

function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-fit items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-campus-700 hover:bg-gray-50"
    >
      {label}
    </button>
  );
}

function ParentSlot({
  label,
  rel,
  canManage,
  onSet,
  onEdit,
  personId,
}: {
  label: string;
  rel: Relationship | undefined;
  canManage: boolean;
  onSet: () => void;
  onEdit: () => void;
  personId: string;
}) {
  if (!rel) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-700">
          {label}: <span className="text-gray-400">Not specified</span>
        </span>
        {canManage && (
          <button
            type="button"
            onClick={onSet}
            className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-campus-700 hover:bg-gray-50"
          >
            + Set {label.toLowerCase()}
          </button>
        )}
      </div>
    );
  }
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <RelationshipCard rel={rel} canManage={canManage} onEdit={onEdit} personId={personId} />
    </div>
  );
}

function relatedName(rel: Relationship): string {
  return rel.relatedPerson
    ? personDisplayName(rel.relatedPerson)
    : (rel.relatedPersonName ?? 'Unknown');
}

function RelationshipCard({
  rel,
  canManage,
  onEdit,
  personId,
}: {
  rel: Relationship;
  canManage: boolean;
  onEdit?: () => void;
  personId: string;
}) {
  const { toast } = useToast();
  const del = useDeleteRelationship(personId);
  const [confirming, setConfirming] = useState(false);

  async function onRemove() {
    try {
      await del.mutateAsync(rel.id);
      toast('Relationship removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove relationship.', 'error');
    } finally {
      setConfirming(false);
    }
  }

  const custodyBits = [
    rel.custodyArrangement ? CUSTODY_LABELS[rel.custodyArrangement] : null,
    rel.isPrimaryResidence ? 'Primary residence' : null,
  ].filter(Boolean);

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50/60 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">
            {relatedName(rel)}
            {rel.relatedPerson?.age != null && (
              <span className="font-normal text-gray-500"> · age {rel.relatedPerson.age}</span>
            )}
          </p>
          <p className="text-xs text-gray-600">
            {RELATIONSHIP_LABELS[rel.type]}
            {rel.verified && <span className="ml-1 text-emerald-600">· ✓ Verified</span>}
            {!rel.relatedPerson && <span className="ml-1 text-gray-400">· not on CampusOS</span>}
          </p>
          {custodyBits.length > 0 && (
            <p className="text-xs text-gray-600">{custodyBits.join(' · ')}</p>
          )}
          {rel.custodyNotes && <p className="text-xs italic text-gray-500">“{rel.custodyNotes}”</p>}
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-1">
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded border border-red-200 bg-white px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"
            >
              Remove
            </button>
          </div>
        )}
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Remove relationship?"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={del.isPending}
              className="inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {del.isPending ? 'Removing…' : 'Remove'}
            </button>
          </>
        }
      >
        <p className="text-sm text-gray-700">
          Remove {relatedName(rel)} ({RELATIONSHIP_LABELS[rel.type]})? This also removes the
          reciprocal relationship on their profile.
        </p>
      </Modal>
    </div>
  );
}

function SiblingList({
  siblings,
}: {
  siblings: {
    person: {
      id: string;
      firstName: string;
      lastName: string;
      preferredName: string | null;
      age: number | null;
    };
    siblingType: keyof typeof SIBLING_LABELS;
  }[];
}) {
  return (
    <Group label="Siblings (derived)">
      <div className="rounded-md border border-gray-200">
        {siblings.map((s) => (
          <div
            key={s.person.id}
            className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5 text-sm last:border-b-0"
          >
            <span className="text-gray-800">
              {s.person.preferredName?.trim() || `${s.person.firstName} ${s.person.lastName}`}
              {s.person.age != null && <span className="text-gray-500"> · age {s.person.age}</span>}
            </span>
            <span className="text-xs text-gray-500">{SIBLING_LABELS[s.siblingType]}</span>
          </div>
        ))}
      </div>
    </Group>
  );
}

const CUSTODY_VALUES: CustodyArrangement[] = [
  'FULL',
  'JOINT',
  'WEEKDAYS',
  'WEEKENDS',
  'SUMMERS',
  'SUPERVISED',
  'NONE',
];

function EditCustodyModal({
  personId,
  rel,
  onClose,
}: {
  personId: string;
  rel: Relationship;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateRelationship(personId);
  const [arrangement, setArrangement] = useState<CustodyArrangement | ''>(
    rel.custodyArrangement ?? '',
  );
  const [primary, setPrimary] = useState(rel.isPrimaryResidence);
  const [legal, setLegal] = useState(rel.isLegalCustody);
  const [notes, setNotes] = useState(rel.custodyNotes ?? '');

  async function onSave() {
    try {
      await update.mutateAsync({
        id: rel.id,
        payload: {
          custodyArrangement: arrangement || undefined,
          isPrimaryResidence: primary,
          isLegalCustody: legal,
          custodyNotes: notes.trim() || null,
        },
      });
      toast('Relationship updated', 'success');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update relationship.', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit — ${relatedName(rel)}`}
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
            disabled={update.isPending}
            className="inline-flex items-center rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="text-xs text-gray-600">
          Custody arrangement
          <select
            value={arrangement}
            onChange={(e) => setArrangement(e.target.value as CustodyArrangement | '')}
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
            checked={primary}
            onChange={(e) => setPrimary(e.target.checked)}
            className="rounded text-campus-600 focus:ring-campus-500"
          />
          Primary residence
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={legal}
            onChange={(e) => setLegal(e.target.checked)}
            className="rounded text-campus-600 focus:ring-campus-500"
          />
          Has legal custody
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
    </Modal>
  );
}
