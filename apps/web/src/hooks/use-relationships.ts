'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─── Types (mirror the API DTOs) ──────────────────────────────

export type RelationshipType =
  | 'BIOLOGICAL_MOTHER'
  | 'BIOLOGICAL_FATHER'
  | 'BIOLOGICAL_CHILD'
  | 'ADOPTIVE_MOTHER'
  | 'ADOPTIVE_FATHER'
  | 'ADOPTIVE_CHILD'
  | 'STEP_MOTHER'
  | 'STEP_FATHER'
  | 'STEP_CHILD'
  | 'LEGAL_GUARDIAN'
  | 'LEGAL_WARD'
  | 'SPOUSE'
  | 'DOMESTIC_PARTNER'
  | 'GRANDPARENT'
  | 'GRANDCHILD';

export type CustodyArrangement =
  | 'FULL'
  | 'JOINT'
  | 'WEEKDAYS'
  | 'WEEKENDS'
  | 'SUMMERS'
  | 'SUPERVISED'
  | 'NONE';

export type SiblingType = 'FULL_SIBLING' | 'HALF_SIBLING' | 'STEP_SIBLING' | 'ADOPTIVE_SIBLING';

export interface PersonSummary {
  id: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  dateOfBirth: string | null;
  age: number | null;
}

export interface Relationship {
  id: string;
  type: RelationshipType;
  relatedPerson: PersonSummary | null;
  relatedPersonName: string | null;
  isLegalCustody: boolean;
  custodyArrangement: CustodyArrangement | null;
  custodyNotes: string | null;
  isPrimaryResidence: boolean;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface DerivedSibling {
  person: PersonSummary;
  siblingType: SiblingType;
}

export interface RelationshipsResponse {
  relationships: Relationship[];
  derivedSiblings: DerivedSibling[];
  // Server-computed rendering hint: true when the current user may
  // add/edit/remove this person's relationships (parent/guardian only).
  canEdit: boolean;
}

export interface FamilyTree {
  person: PersonSummary;
  parents: Relationship[];
  children: Relationship[];
  grandparents: Relationship[];
  grandchildren: Relationship[];
  spouses: Relationship[];
  other: Relationship[];
  siblings: DerivedSibling[];
  canEdit: boolean;
}

export interface CreateRelationshipPayload {
  relatedPersonId?: string;
  relatedPersonName?: string;
  relationshipType: RelationshipType;
  isLegalCustody?: boolean;
  custodyArrangement?: CustodyArrangement;
  custodyNotes?: string;
  isPrimaryResidence?: boolean;
  startDate?: string;
}

export interface UpdateRelationshipPayload {
  custodyArrangement?: CustodyArrangement;
  custodyNotes?: string | null;
  isPrimaryResidence?: boolean;
  isLegalCustody?: boolean;
  startDate?: string | null;
  endDate?: string | null;
}

// ─── Labels (shared by every relationship UI) ─────────────────

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  BIOLOGICAL_MOTHER: 'Biological mother',
  BIOLOGICAL_FATHER: 'Biological father',
  BIOLOGICAL_CHILD: 'Biological child',
  ADOPTIVE_MOTHER: 'Adoptive mother',
  ADOPTIVE_FATHER: 'Adoptive father',
  ADOPTIVE_CHILD: 'Adoptive child',
  STEP_MOTHER: 'Step-mother',
  STEP_FATHER: 'Step-father',
  STEP_CHILD: 'Step-child',
  LEGAL_GUARDIAN: 'Legal guardian',
  LEGAL_WARD: 'Legal ward',
  SPOUSE: 'Spouse',
  DOMESTIC_PARTNER: 'Domestic partner',
  GRANDPARENT: 'Grandparent',
  GRANDCHILD: 'Grandchild',
};

export const CUSTODY_LABELS: Record<CustodyArrangement, string> = {
  FULL: 'Full custody',
  JOINT: 'Joint custody',
  WEEKDAYS: 'Weekdays',
  WEEKENDS: 'Weekends',
  SUMMERS: 'Summers',
  SUPERVISED: 'Supervised',
  NONE: 'No custody',
};

export const SIBLING_LABELS: Record<SiblingType, string> = {
  FULL_SIBLING: 'Full sibling',
  HALF_SIBLING: 'Half-sibling',
  STEP_SIBLING: 'Step-sibling',
  ADOPTIVE_SIBLING: 'Adoptive sibling',
};

export function personDisplayName(p: PersonSummary): string {
  return p.preferredName?.trim() || `${p.firstName} ${p.lastName}`.trim();
}

// ─── Hooks ────────────────────────────────────────────────────

const base = (personId: string) => `/api/v1/people/${personId}`;

export function useRelationships(personId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['relationships', personId] as const,
    queryFn: () => apiFetch<RelationshipsResponse>(`${base(personId!)}/relationships`),
    enabled: enabled && !!personId,
    staleTime: 30_000,
  });
}

export function useFamilyTree(personId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['family-tree', personId] as const,
    queryFn: () => apiFetch<FamilyTree>(`${base(personId!)}/family-tree`),
    enabled: enabled && !!personId,
    staleTime: 30_000,
  });
}

// Creating / editing a relationship affects the subject AND the related
// person's view (their reciprocal) AND derived siblings across several
// people, so we invalidate the whole relationships + family-tree spaces.
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['relationships'] });
  void qc.invalidateQueries({ queryKey: ['family-tree'] });
}

export function useCreateRelationship(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateRelationshipPayload) =>
      apiFetch<Relationship>(`${base(personId)}/relationships`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateRelationship(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateRelationshipPayload }) =>
      apiFetch<Relationship>(`${base(personId)}/relationships/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteRelationship(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${base(personId)}/relationships/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useVerifyRelationship(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, verified }: { id: string; verified: boolean }) =>
      apiFetch<Relationship>(`${base(personId)}/relationships/${id}/verify`, {
        method: 'PATCH',
        body: JSON.stringify({ verified }),
      }),
    onSuccess: () => invalidateAll(qc),
  });
}
