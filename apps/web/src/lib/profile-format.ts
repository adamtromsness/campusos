import type { HouseholdRole, PhoneType, ProfileDto } from './types';

export const PHONE_TYPES: ReadonlyArray<PhoneType> = ['MOBILE', 'HOME', 'WORK'];

export const PHONE_TYPE_LABELS: Record<PhoneType, string> = {
  MOBILE: 'Mobile',
  HOME: 'Home',
  WORK: 'Work',
};

export const HOUSEHOLD_ROLES: ReadonlyArray<HouseholdRole> = [
  'HEAD_OF_HOUSEHOLD',
  'SPOUSE',
  'CHILD',
  'GRANDPARENT',
  'OTHER_GUARDIAN',
  'SIBLING',
  'OTHER',
];

export const HOUSEHOLD_ROLE_LABELS: Record<HouseholdRole, string> = {
  HEAD_OF_HOUSEHOLD: 'Head of household',
  SPOUSE: 'Spouse',
  CHILD: 'Child',
  GRANDPARENT: 'Grandparent',
  OTHER_GUARDIAN: 'Other guardian',
  SIBLING: 'Sibling',
  OTHER: 'Other',
};

export type ProfileTabKey =
  | 'personal'
  | 'household'
  | 'emergency'
  | 'demographics'
  | 'employment'
  | 'account';

export interface ProfileTabSpec {
  key: ProfileTabKey;
  label: string;
  visible: boolean;
}

/**
 * Persona-conditional tab visibility. Demographics shows only for
 * STUDENT, Employment only for GUARDIAN. Personal / Household /
 * Emergency / Account are always visible (the Emergency tab will
 * show "Not recorded" for personas that have no emergency contact
 * table mapping today — guardians, alumni, external).
 */
export function profileTabs(personType: string | null): ProfileTabSpec[] {
  return [
    { key: 'personal', label: 'Personal Info', visible: true },
    { key: 'household', label: 'My Household', visible: true },
    { key: 'emergency', label: 'Emergency Contact', visible: true },
    { key: 'demographics', label: 'Demographics', visible: personType === 'STUDENT' },
    { key: 'employment', label: 'Employment', visible: personType === 'GUARDIAN' },
    { key: 'account', label: 'Account', visible: true },
  ];
}

/**
 * Profile completeness = (filled required + filled recommended) /
 * (all required + all recommended). Returned as 0-100 integer.
 *
 * Required (always count as 1.0): first_name, last_name, primary_phone,
 *   household role (when the person is a member of a household).
 * Recommended (count as 0.5): preferred_name, address (any line1),
 *   emergency contact name+phone (count as 1 unit), employment for
 *   GUARDIAN, demographics primary_language for STUDENT.
 */
export function profileCompleteness(profile: ProfileDto): number {
  const personType = profile.personType;
  let required = 0;
  let requiredFilled = 0;

  // Required: first/last (always populated since they're NOT NULL)
  required += 2;
  requiredFilled += profile.firstName ? 1 : 0;
  requiredFilled += profile.lastName ? 1 : 0;

  // Required: primary_phone
  required += 1;
  requiredFilled += profile.primaryPhone ? 1 : 0;

  // Required: household role when in a household
  if (profile.household) {
    required += 1;
    requiredFilled += profile.household.role ? 1 : 0;
  }

  let recommended = 0;
  let recommendedFilled = 0;

  recommended += 1;
  recommendedFilled += profile.preferredName ? 1 : 0;

  if (profile.household) {
    recommended += 1;
    recommendedFilled += profile.household.role && profile.household.id ? 1 : 0; // home address proxy is its own check below
  }

  // Address: count one unit if any line1 is set on the household.
  // We don't have access to the full household here — use the household
  // id presence as a proxy, then the address tab itself nudges the user.
  // (A future iteration could pass HouseholdDto in directly.)

  // Emergency contact populated
  recommended += 1;
  recommendedFilled += profile.emergencyContact ? 1 : 0;

  // Persona-specific
  if (personType === 'GUARDIAN') {
    recommended += 1;
    recommendedFilled += profile.employment?.employer ? 1 : 0;
  }
  if (personType === 'STUDENT') {
    recommended += 1;
    recommendedFilled += profile.demographics?.primaryLanguage ? 1 : 0;
  }

  const totalScore = requiredFilled * 1.0 + recommendedFilled * 0.5;
  const totalMax = required * 1.0 + recommended * 0.5;
  if (totalMax === 0) return 0;
  return Math.round((totalScore / totalMax) * 100);
}

export function formatPhone(phone: string | null | undefined, type: PhoneType | null | undefined): string {
  if (!phone) return '';
  if (!type) return phone;
  return `${phone} (${PHONE_TYPE_LABELS[type]})`;
}

export function formatPersonName(p: ProfileDto): string {
  const parts = [p.firstName, p.middleName, p.lastName, p.suffix].filter(Boolean);
  return parts.join(' ');
}
