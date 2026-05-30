import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomInt } from 'crypto';
import { generateId } from '@campusos/database';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import {
  AddPersonEmailDto,
  AddPersonPhoneDto,
  PersonEmailDto,
  PersonEmailType,
  PersonPhoneDto,
  PersonPhoneType,
  UpdatePersonEmailDto,
  UpdatePersonPhoneDto,
} from '@modules/m00-platform/profile/dto/profile.dto';
import { RedisService } from '@shared/cache';
import {
  AcceptFamilyLinkDto,
  AddChildEmergencyContactDto,
  AddFamilyEmergencyContactDto,
  AddFamilyMemberDto,
  ChildAllergyEntry,
  ChildConditionEntry,
  ChildDietaryInfoDto,
  ChildEmergencyContactDto,
  ChildFoodAllergyEntry,
  ChildMedicalInfoDto,
  ChildMedicationEntry,
  CreateChildAccountDto,
  CreateFamilyChildDto,
  CreateMemberAccountDto,
  FamilyAccessLevel,
  FamilyChildDto,
  FAMILY_CONTACT_CATEGORIES,
  FamilyContactCategory,
  FamilyContactPreferenceDto,
  FamilyEmergencyContactDto,
  FamilyHeaderDto,
  FamilyLinkResultDto,
  FamilyMemberDto,
  FamilySettingsDto,
  FamilyViewDto,
  FamilyViewerRole,
  GenerateFamilyCodeDto,
  GenerateLinkCodeDto,
  InviteGuardianDto,
  SendChildLinkDto,
  SendMemberInviteDto,
  UpdateChildDietaryInfoDto,
  UpdateChildEmergencyContactDto,
  UpdateChildMedicalInfoDto,
  UpdateFamilyChildDto,
  UpdateFamilyContactPreferencesDto,
  UpdateFamilyEmergencyContactDto,
  UpdateFamilyMemberDto,
  UpdateFamilySettingsDto,
} from './dto/family-child.dto';

interface EmergencyContactRow {
  id: string;
  family_id: string;
  linked_person_id: string | null;
  name: string;
  relationship: string;
  phone_primary: string;
  phone_alternate: string | null;
  email: string | null;
  authorized_pickup: boolean;
  priority_order: number;
}

interface FamilyChildRow {
  id: string;
  family_id: string;
  person_id: string | null;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  primary_phone: string | null;
  notes: string | null;
  status: string;
  emergency_contact_source: string;
  address_source: string;
  custom_address_line1: string | null;
  custom_address_line2: string | null;
  custom_city: string | null;
  custom_state: string | null;
  custom_postal_code: string | null;
  custom_country: string | null;
  mailing_address_different: boolean;
  mailing_line1: string | null;
  mailing_line2: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_postal_code: string | null;
  mailing_country: string | null;
  // Login email — joins through platform_users for LINKED children
  // only. PLACEHOLDER / PENDING_LINK rows have no platform_users row
  // yet and this will be null.
  email: string | null;
  invite_code: string | null;
  invite_email: string | null;
  invite_sent_at: string | null;
  linked_at: string | null;
  created_at: string;
  managed_by_person_id: string | null;
}

function computeAccessLevel(
  status: string,
  managedByPersonId: string | null,
  familyGuardianPersonIds: ReadonlySet<string>,
): FamilyAccessLevel {
  // PLACEHOLDER + every other pre-link state: the row has no linked
  // iam_person yet, so there's no "account holder" to manage. Edit
  // permission comes from family membership, not account custody.
  if (status !== 'LINKED' && status !== 'ACTIVE') return 'PLACEHOLDER';
  // LINKED / ACTIVE: the row is MANAGED iff its account custodian
  // (platform_users.managed_by_person_id) is ANY guardian in the
  // viewer's family. Co-guardians share management rights — Adam
  // marks a child managed-by-Adam; Ashley joins as a co-parent and
  // immediately gets the same MANAGED access as Adam. Without this,
  // co-parents saw "INDEPENDENT" + a read-only profile for kids the
  // family clearly owns.
  if (managedByPersonId && familyGuardianPersonIds.has(managedByPersonId)) return 'MANAGED';
  return 'INDEPENDENT';
}

const LINK_CODE_TTL_HOURS = 72;
const LINK_ATTEMPTS_LIMIT = 5;
const LINK_ATTEMPTS_WINDOW_SECONDS = 15 * 60;

/**
 * FamilyChildrenService — persona-registration Step 5 + 6.
 *
 * Owns the platform_family_children table: CRUD of placeholder/pending
 * children, plus the three account-linking flows (create minor account,
 * send link code, accept code).
 *
 * Authorisation: a person can only see / mutate children inside the
 * family they're a member of. We resolve `family_id` from
 * platform_family_members.person_id; if the person isn't a member of
 * any family yet (registration didn't seed one), POST creates one on
 * demand so the parent can capture their children before any school
 * relationship exists.
 *
 * Persona refresh: every LINKED transition refreshes the inviting
 * parent's persona cache so the PARENT persona activates immediately.
 * Failures are swallowed — refresh is a cache rebuild, not a
 * correctness requirement.
 */
@Injectable()
export class FamilyChildrenService {
  private readonly logger = new Logger(FamilyChildrenService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly personaResolution: PersonaResolutionService,
    private readonly redis: RedisService,
  ) {}

  // ─── /family — composite view ──────────────────────────────

  /**
   * GET /family — composite view of the caller's family.
   *
   * Viewer-family resolution:
   *   1. If the caller is a family_members row in a family that has
   *      any platform_family_children rows → that family, PARENT view.
   *   2. Else if the caller is a LINKED family_child anywhere → that
   *      family, CHILD view. (A user can be LINKED in multiple
   *      families; we pick the most-recently-linked one.)
   *   3. Else if the caller is a family_members row anywhere (empty
   *      singleton from registration) → that family, PARENT view.
   *   4. Otherwise null — the caller has no family at all. The
   *      controller returns null and the frontend falls back to its
   *      empty state.
   *
   * Step (1) ordering is important — once an adult has children of
   * their own they should land on their OWN family even if they're
   * also still LINKED in their parent's family.
   */
  async getFamilyView(personId: string): Promise<FamilyViewDto | null> {
    const resolved = await this.resolveViewerFamily(personId);
    if (!resolved) return null;

    const family = await this.prisma.platformFamily.findUnique({
      where: { id: resolved.familyId },
      select: { id: true, name: true },
    });
    if (!family) return null;

    // The guardian set is reused by both the member projection (a
    // member's accessLevel maps "managed by" through the family) and
    // the child projection (children's accessLevel uses the same
    // set so all co-guardians see managed kids as MANAGED).
    const familyGuardians = await this.loadFamilyGuardianPersonIds(personId);

    // LEFT JOIN iam_person so PLACEHOLDER / PENDING_INVITE rows
    // (person_id NULL) come through with family_members.first_name /
    // last_name / email instead of NULL columns. COALESCE picks
    // iam_person for ACTIVE rows, family_members for placeholders.
    const memberRows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        person_id: string | null;
        first_name: string;
        last_name: string;
        preferred_name: string | null;
        email: string | null;
        primary_phone: string | null;
        primary_phone_type: string | null;
        primary_email_type: string | null;
        member_role: string;
        is_primary_contact: boolean;
        emergency_authorized_pickup: boolean;
        emergency_priority_order: number;
        status: string;
        invite_code: string | null;
        invite_sent_at: string | null;
        managed_by_person_id: string | null;
      }>
    >(
      `SELECT pfm.id::text AS id,
              pfm.person_id::text AS person_id,
              COALESCE(p.first_name, pfm.first_name) AS first_name,
              COALESCE(p.last_name, pfm.last_name) AS last_name,
              p.preferred_name AS preferred_name,
              -- Primary contact email lives in platform_person_emails
              -- when the member has a linked iam_person. Falls back
              -- to pfm.email for PLACEHOLDER / PENDING_INVITE rows
              -- (no person_id) and historic rows that haven't had
              -- their first /profile/me/emails lazy-seed yet. The
              -- completion checker treats "has email" as the source
              -- of truth for guardian-profile completeness.
              COALESCE(
                (SELECT pe.email
                   FROM platform.platform_person_emails pe
                  WHERE pe.person_id = pfm.person_id
                  ORDER BY pe.is_primary DESC, pe.created_at ASC
                  LIMIT 1),
                pfm.email
              ) AS email,
              p.primary_phone AS primary_phone,
              -- Primary phone + email TYPE for the read-only Guardian
              -- Contacts panel on the child Contact tab. Null when
              -- the row hasn't been seeded yet (e.g. PLACEHOLDER).
              (SELECT pp.type
                 FROM platform.platform_person_phones pp
                WHERE pp.person_id = pfm.person_id AND pp.is_primary = true
                LIMIT 1) AS primary_phone_type,
              (SELECT pe.type
                 FROM platform.platform_person_emails pe
                WHERE pe.person_id = pfm.person_id AND pe.is_primary = true
                LIMIT 1) AS primary_email_type,
              pfm.member_role::text AS member_role,
              pfm.is_primary_contact,
              pfm.emergency_authorized_pickup,
              pfm.emergency_priority_order,
              pfm.status,
              pfm.invite_code,
              pfm.invite_sent_at::text AS invite_sent_at,
              pu.managed_by_person_id::text AS managed_by_person_id
       FROM platform.platform_family_members pfm
       LEFT JOIN platform.iam_person p ON p.id = pfm.person_id
       LEFT JOIN platform.platform_users pu ON pu.person_id = pfm.person_id
       WHERE pfm.family_id = $1::uuid
       ORDER BY pfm.is_primary_contact DESC, pfm.joined_at ASC`,
      resolved.familyId,
    );
    // Defensive in-memory dedup. The partial UNIQUE INDEX added in
    // the 20260526010000 migration prevents NEW duplicate person_id
    // rows, but historic data may still carry them and the read
    // path shouldn't surface duplicates. Rows with person_id NULL
    // (PLACEHOLDER / PENDING_INVITE) pass through unchanged —
    // multiple unfilled placeholders with the same display name
    // are intentional.
    const seenPersonIds = new Set<string>();
    const dedupedMemberRows = memberRows.filter((r) => {
      if (r.person_id === null) return true;
      if (seenPersonIds.has(r.person_id)) return false;
      seenPersonIds.add(r.person_id);
      return true;
    });
    const members: FamilyMemberDto[] = dedupedMemberRows.map((r) => ({
      id: r.id,
      personId: r.person_id,
      firstName: r.first_name,
      lastName: r.last_name,
      preferredName: r.preferred_name,
      email: r.email,
      primaryPhone: r.primary_phone,
      primaryPhoneType: r.primary_phone_type,
      primaryEmailType: r.primary_email_type,
      memberRole: r.member_role,
      isPrimaryContact: r.is_primary_contact,
      isCurrentUser: r.person_id !== null && r.person_id === personId,
      status: r.status as FamilyMemberDto['status'],
      // ACTIVE rows mapping to a status the helper recognises as
      // linked (LINKED is its child-side analogue) → MANAGED if
      // managed_by matches the viewer, otherwise INDEPENDENT.
      // PLACEHOLDER + PENDING_INVITE fall through to 'PLACEHOLDER'.
      accessLevel: computeAccessLevel(
        r.status === 'ACTIVE' ? 'LINKED' : r.status,
        r.managed_by_person_id,
        familyGuardians,
      ),
      emergencyAuthorizedPickup: r.emergency_authorized_pickup,
      emergencyPriorityOrder: r.emergency_priority_order,
      inviteCode: r.invite_code,
      inviteSentAt: r.invite_sent_at,
    }));

    const childRows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE pfc.family_id = $1::uuid ORDER BY pfc.created_at ASC',
      resolved.familyId,
    );

    return {
      family: { id: family.id, name: family.name },
      viewerRole: resolved.role,
      viewerPersonId: personId,
      members,
      children: childRows.map((r) => this.toDto(r, familyGuardians)),
    };
  }

  /**
   * Pick the family that should drive the /family page for this user.
   * Returns null if the user has no family of any kind (registration
   * normally seeds one, but the unauth-by-API-token case can land
   * here). Documented at length on getFamilyView above.
   */
  private async resolveViewerFamily(
    personId: string,
  ): Promise<{ familyId: string; role: FamilyViewerRole } | null> {
    const myMemberFamilyId = await this.findFamilyForPerson(personId);

    if (myMemberFamilyId) {
      const childCountRows = await this.prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        `SELECT COUNT(*)::bigint AS cnt
         FROM platform.platform_family_children
         WHERE family_id = $1::uuid`,
        myMemberFamilyId,
      );
      if (Number(childCountRows[0]?.cnt ?? 0n) > 0) {
        return { familyId: myMemberFamilyId, role: 'PARENT' };
      }
    }

    const linkedRows = await this.prisma.$queryRawUnsafe<Array<{ family_id: string }>>(
      `SELECT family_id::text AS family_id
       FROM platform.platform_family_children
       WHERE person_id = $1::uuid AND status = 'LINKED'
       ORDER BY linked_at DESC NULLS LAST
       LIMIT 1`,
      personId,
    );
    if (linkedRows[0]) {
      return { familyId: linkedRows[0].family_id, role: 'CHILD' };
    }

    if (myMemberFamilyId) {
      return { familyId: myMemberFamilyId, role: 'PARENT' };
    }
    return null;
  }

  /**
   * Refuse a parent-write when the caller's primary family view is
   * CHILD (they're LINKED into someone else's family with no kids of
   * their own). PATCH/DELETE/send-link/create-account already gate
   * via requireOwnedRow's family_members membership check; this
   * helper covers POST /family/children and generate-code where the
   * caller has no existing target row to check against.
   *
   * `resolveViewerFamily` ordering prefers PARENT-with-kids first
   * and falls through to LINKED-child-elsewhere, so a fresh parent
   * with an empty singleton family still passes — only "I am a
   * LINKED child somewhere AND have no kids of my own" trips the
   * 403.
   */
  private async assertNotChildViewer(personId: string): Promise<void> {
    const resolved = await this.resolveViewerFamily(personId);
    if (resolved?.role === 'CHILD') {
      throw new HttpException(
        'Only parents/guardians can perform this action',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  // ─── Family settings — shared attributes ────────────────────

  /**
   * GET /family/settings — household-wide attributes (display name,
   * address, doctor, insurance) plus the current primary-contact
   * identity. Children inherit these by default; per-child overrides
   * live on PlatformChildMedicalInfo / per-child contact tables.
   *
   * Resolves the caller's family via resolveViewerFamily so both
   * PARENT and CHILD viewers can see the settings; canEdit is true
   * only for parents/guardians (the assertNotChildViewer rule on
   * the PATCH path enforces this server-side).
   *
   * Returns null when the caller has no family row yet (the registration
   * normally seeds one, but an unauth-flow caller would land here).
   */
  async getFamilySettings(personId: string): Promise<FamilySettingsDto | null> {
    const resolved = await this.resolveViewerFamily(personId);
    if (!resolved) return null;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        name: string | null;
        address_line1: string | null;
        address_line2: string | null;
        city: string | null;
        state: string | null;
        postal_code: string | null;
        country: string | null;
        home_phone: string | null;
        mailing_address_same: boolean;
        mailing_line1: string | null;
        mailing_line2: string | null;
        mailing_city: string | null;
        mailing_state: string | null;
        mailing_postal_code: string | null;
        mailing_country: string | null;
        doctor_name: string | null;
        doctor_phone: string | null;
        doctor_clinic: string | null;
        insurance_provider: string | null;
        insurance_policy: string | null;
        insurance_group: string | null;
        has_family_doctor: boolean | null;
        has_insurance: boolean | null;
        medical_notes: string | null;
        primary_contact_person_id: string | null;
        primary_first_name: string | null;
        primary_last_name: string | null;
        primary_preferred_name: string | null;
      }>
    >(
      `SELECT
         pf.id::text AS id,
         pf.name,
         pf.address_line1, pf.address_line2, pf.city, pf.state,
         pf.postal_code, pf.country, pf.home_phone,
         pf.mailing_address_same,
         pf.mailing_line1, pf.mailing_line2, pf.mailing_city, pf.mailing_state,
         pf.mailing_postal_code, pf.mailing_country,
         pf.doctor_name, pf.doctor_phone, pf.doctor_clinic,
         pf.insurance_provider, pf.insurance_policy, pf.insurance_group,
         pf.has_family_doctor, pf.has_insurance,
         pf.medical_notes,
         pc.person_id::text AS primary_contact_person_id,
         p.first_name AS primary_first_name,
         p.last_name AS primary_last_name,
         p.preferred_name AS primary_preferred_name
       FROM platform.platform_families pf
       LEFT JOIN platform.platform_family_members pc
         ON pc.family_id = pf.id AND pc.is_primary_contact = true
       LEFT JOIN platform.iam_person p ON p.id = pc.person_id
       WHERE pf.id = $1::uuid
       LIMIT 1`,
      resolved.familyId,
    );
    const row = rows[0];
    if (!row) return null;
    const primaryName = row.primary_contact_person_id
      ? row.primary_preferred_name?.trim() ||
        [row.primary_first_name, row.primary_last_name].filter(Boolean).join(' ') ||
        null
      : null;
    return {
      familyId: row.id,
      displayName: row.name,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      state: row.state,
      postalCode: row.postal_code,
      country: row.country,
      homePhone: row.home_phone,
      // The DB column is the inverse (`mailing_address_same`): default
      // true = "same as home". The wire format uses the positive
      // sense — `mailingAddressDifferent` — because the UI toggle
      // reads more naturally that way ("☐ Mailing address is
      // different from home address").
      mailingAddressDifferent: !row.mailing_address_same,
      mailingLine1: row.mailing_line1,
      mailingLine2: row.mailing_line2,
      mailingCity: row.mailing_city,
      mailingState: row.mailing_state,
      mailingPostalCode: row.mailing_postal_code,
      mailingCountry: row.mailing_country,
      doctorName: row.doctor_name,
      doctorPhone: row.doctor_phone,
      doctorClinic: row.doctor_clinic,
      insuranceProvider: row.insurance_provider,
      insurancePolicy: row.insurance_policy,
      insuranceGroup: row.insurance_group,
      hasFamilyDoctor: row.has_family_doctor,
      hasInsurance: row.has_insurance,
      medicalNotes: row.medical_notes,
      primaryContactPersonId: row.primary_contact_person_id,
      primaryContactName: primaryName,
      canEdit: resolved.role === 'PARENT',
    };
  }

  /**
   * PATCH /family/settings — partial update. Children rejected by
   * assertNotChildViewer (their viewerRole resolves to CHILD when
   * they have no kids of their own). Empty strings on the wire are
   * coerced to NULL — clients use '' to clear a field.
   */
  async updateFamilySettings(
    personId: string,
    dto: UpdateFamilySettingsDto,
  ): Promise<FamilySettingsDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);

    // Columns that map 1:1 from dto key → DB column. Excludes
    // mailingAddressDifferent (inverted in mapping) and
    // primaryContactPersonId (writes a different table).
    const cols: Partial<Record<keyof UpdateFamilySettingsDto, string>> = {
      displayName: 'name',
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      city: 'city',
      state: 'state',
      postalCode: 'postal_code',
      country: 'country',
      homePhone: 'home_phone',
      mailingLine1: 'mailing_line1',
      mailingLine2: 'mailing_line2',
      mailingCity: 'mailing_city',
      mailingState: 'mailing_state',
      mailingPostalCode: 'mailing_postal_code',
      mailingCountry: 'mailing_country',
      doctorName: 'doctor_name',
      doctorPhone: 'doctor_phone',
      doctorClinic: 'doctor_clinic',
      insuranceProvider: 'insurance_provider',
      insurancePolicy: 'insurance_policy',
      insuranceGroup: 'insurance_group',
      hasFamilyDoctor: 'has_family_doctor',
      hasInsurance: 'has_insurance',
      medicalNotes: 'medical_notes',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const k of Object.keys(cols) as Array<keyof UpdateFamilySettingsDto>) {
      if (dto[k] === undefined) continue;
      const col = cols[k];
      if (!col) continue;
      setClauses.push(col + ' = $' + i++);
      // '' → NULL so the UI can clear a field by submitting an empty
      // string. null → NULL stays null.
      const v = dto[k];
      values.push(typeof v === 'string' && v.trim() === '' ? null : v);
    }
    if (dto.mailingAddressDifferent !== undefined) {
      // Wire format is the positive sense; DB column is the inverse.
      // See the read path for the reasoning.
      setClauses.push('mailing_address_same = $' + i++);
      values.push(!dto.mailingAddressDifferent);
    }

    // Primary-contact promote runs inside the same tx as the
    // platform_families UPDATE so a settings + primary-contact swap
    // is atomic. The partial UNIQUE INDEX on (family_id) WHERE
    // is_primary_contact = true forces us to demote the current
    // primary BEFORE promoting the new one.
    const newPrimaryPersonId = dto.primaryContactPersonId;

    if (setClauses.length === 0 && newPrimaryPersonId === undefined) {
      // Nothing to do.
      const noop = await this.getFamilySettings(personId);
      if (!noop) {
        throw new HttpException(
          'Could not reload family settings',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return noop;
    }

    await this.prisma.$transaction(async (tx) => {
      if (setClauses.length > 0) {
        const sqlClauses = [...setClauses, 'updated_at = now()'];
        const sqlValues = [...values, familyId];
        await tx.$executeRawUnsafe(
          'UPDATE platform.platform_families SET ' +
            sqlClauses.join(', ') +
            ' WHERE id = $' +
            sqlValues.length +
            '::uuid',
          ...sqlValues,
        );
      }
      if (newPrimaryPersonId !== undefined) {
        // Validate membership — refuse cross-family promotions.
        const member = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id::text AS id FROM platform.platform_family_members
           WHERE family_id = $1::uuid AND person_id = $2::uuid LIMIT 1`,
          familyId,
          newPrimaryPersonId,
        );
        if (member.length === 0) {
          throw new BadRequestException(
            'Cannot promote a non-member to primary contact. Add them to the family first.',
          );
        }
        // Demote any existing primary first.
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_members
           SET is_primary_contact = false, updated_at = now()
           WHERE family_id = $1::uuid AND is_primary_contact = true`,
          familyId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_members
           SET is_primary_contact = true, updated_at = now()
           WHERE id = $1::uuid`,
          member[0]!.id,
        );
      }
    });

    const refreshed = await this.getFamilySettings(personId);
    if (!refreshed) {
      throw new HttpException(
        'Could not reload family settings after update',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return refreshed;
  }

  // ─── Family contact preferences (per-category routing) ────

  /**
   * Read or lazily-seed the per-category contact preferences. If
   * the family already has a primary contact (an is_primary_contact
   * member) and no preference rows exist, we seed all 8 categories
   * to that primary in a single tx. Otherwise the response is empty
   * and the UI falls back to "Not set" placeholders.
   *
   * CHILD viewers can read the preferences too (they're not secret —
   * the child can see who's routed for what). Only PARENT can
   * mutate, gated by assertNotChildViewer on the PATCH path.
   */
  async getFamilyContactPreferences(personId: string): Promise<FamilyContactPreferenceDto[]> {
    const familyId = await this.familyIdForViewer(personId);
    if (!familyId) return [];

    const rows = await this.readContactPreferenceRows(familyId);
    if (rows.length > 0) return rows;

    // Seed defaults from the current primary contact if there is
    // one; otherwise return empty (8 categories rendered as
    // "Not set" in the UI).
    const primary = await this.prisma.$queryRawUnsafe<Array<{ person_id: string }>>(
      `SELECT person_id::text AS person_id
       FROM platform.platform_family_members
       WHERE family_id = $1::uuid AND is_primary_contact = true
         AND person_id IS NOT NULL
       LIMIT 1`,
      familyId,
    );
    if (primary.length === 0) return [];

    const primaryPersonId = primary[0]!.person_id;
    try {
      await this.prisma.$transaction(
        FAMILY_CONTACT_CATEGORIES.map((category) =>
          this.prisma.platformFamilyContactPreference.create({
            data: {
              id: generateId(),
              familyId,
              category,
              primaryPersonId,
            },
          }),
        ),
      );
    } catch (err: unknown) {
      // Race condition with another caller seeding the same family.
      // Fall through to re-read — the UNIQUE (family_id, category)
      // guarantees at most one seed succeeds.
      const code = (err as { code?: string }).code;
      if (code !== 'P2002') throw err;
    }

    return this.readContactPreferenceRows(familyId);
  }

  async updateFamilyContactPreferences(
    personId: string,
    dto: UpdateFamilyContactPreferencesDto,
  ): Promise<FamilyContactPreferenceDto[]> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);

    if (!Array.isArray(dto.preferences) || dto.preferences.length === 0) {
      return this.getFamilyContactPreferences(personId);
    }

    // Validate every person is a member of this family — refuse
    // cross-family routing.
    const personIds = Array.from(new Set(dto.preferences.map((p) => p.primaryPersonId)));
    const validMembers = await this.prisma.$queryRawUnsafe<Array<{ person_id: string }>>(
      `SELECT person_id::text AS person_id
       FROM platform.platform_family_members
       WHERE family_id = $1::uuid AND person_id = ANY($2::uuid[])`,
      familyId,
      personIds,
    );
    const validSet = new Set(validMembers.map((m) => m.person_id));
    for (const p of dto.preferences) {
      if (!validSet.has(p.primaryPersonId)) {
        throw new BadRequestException(
          'Cannot route a category to a non-member. Add them to the family first.',
        );
      }
    }

    // Find whether GENERAL changed — if so, mirror onto
    // platform_family_members.is_primary_contact so the /family
    // page badge stays in sync.
    const generalPref = dto.preferences.find((p) => p.category === 'GENERAL');

    await this.prisma.$transaction(async (tx) => {
      for (const p of dto.preferences) {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_family_contact_preferences
             (id, family_id, category, primary_person_id)
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
           ON CONFLICT (family_id, category) DO UPDATE
             SET primary_person_id = EXCLUDED.primary_person_id,
                 updated_at = now()`,
          generateId(),
          familyId,
          p.category,
          p.primaryPersonId,
        );
      }
      if (generalPref) {
        // Demote any other primary, then promote the new GENERAL contact.
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_members
             SET is_primary_contact = false, updated_at = now()
           WHERE family_id = $1::uuid AND is_primary_contact = true
             AND person_id <> $2::uuid`,
          familyId,
          generalPref.primaryPersonId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_members
             SET is_primary_contact = true, updated_at = now()
           WHERE family_id = $1::uuid AND person_id = $2::uuid`,
          familyId,
          generalPref.primaryPersonId,
        );
      }
    });

    return this.readContactPreferenceRows(familyId);
  }

  /**
   * Raw read of the preference rows + JOIN iam_person for the
   * friendly name. Returns rows for any subset of categories the
   * family has set; the UI fills in "Not set" for absent ones.
   */
  private async readContactPreferenceRows(familyId: string): Promise<FamilyContactPreferenceDto[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        category: string;
        primary_person_id: string;
        first_name: string | null;
        last_name: string | null;
        preferred_name: string | null;
      }>
    >(
      `SELECT fcp.category,
              fcp.primary_person_id::text AS primary_person_id,
              p.first_name, p.last_name, p.preferred_name
       FROM platform.platform_family_contact_preferences fcp
       LEFT JOIN platform.iam_person p ON p.id = fcp.primary_person_id
       WHERE fcp.family_id = $1::uuid
       ORDER BY fcp.created_at ASC`,
      familyId,
    );
    return rows.map((r) => ({
      category: r.category as FamilyContactCategory,
      primaryPersonId: r.primary_person_id,
      primaryContactName:
        (r.preferred_name?.trim() ? r.preferred_name : null) ||
        [r.first_name, r.last_name].filter(Boolean).join(' ') ||
        '—',
    }));
  }

  // ─── Family emergency contacts ─────────────────────────────

  /**
   * Resolve the caller's family for emergency-contact CRUD. PARENT
   * and CHILD viewers both get GET (children need to see who's on the
   * family contact list); only PARENT can mutate (the per-method
   * write helpers run assertNotChildViewer).
   */
  private async familyIdForViewer(personId: string): Promise<string | null> {
    const resolved = await this.resolveViewerFamily(personId);
    return resolved?.familyId ?? null;
  }

  /**
   * LEFT JOIN platform.iam_person + platform.platform_users so the
   * linked-contact case can surface the current name/phone/email
   * without a second roundtrip. The raw SQL is preferred over Prisma
   * include because the model doesn't carry a `linkedPerson` relation
   * (would require a back-relation on iam_person we don't want to add
   * just for this).
   */
  async listFamilyEmergencyContacts(personId: string): Promise<FamilyEmergencyContactDto[]> {
    const familyId = await this.familyIdForViewer(personId);
    if (!familyId) return [];
    const rows = await this.prisma.$queryRawUnsafe<Array<EmergencyContactRow>>(
      this.familyEcSelectSql() +
        ' WHERE fec.family_id = $1::uuid ORDER BY fec.priority_order ASC, fec.created_at ASC',
      familyId,
    );
    return rows.map((r) => this.toFamilyEmergencyContactDto(r));
  }

  async addFamilyEmergencyContact(
    personId: string,
    dto: AddFamilyEmergencyContactDto,
  ): Promise<FamilyEmergencyContactDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);

    // Resolve the contact's name / phone / email. If linkedPersonId
    // is set, pull from iam_person + platform_users; otherwise use
    // the manual payload. Either path MUST end with a usable name +
    // primary phone (the schema requires NOT NULL on both).
    let linkedPersonId: string | null = null;
    let resolvedName = dto.name?.trim() ?? '';
    let resolvedPhonePrimary = dto.phonePrimary?.trim() ?? '';
    let resolvedPhoneAlternate = dto.phoneAlternate?.trim() ?? null;
    let resolvedEmail = dto.email?.trim() ?? null;

    if (dto.linkedPersonId) {
      const personRows = await this.prisma.$queryRawUnsafe<
        Array<{
          first_name: string;
          last_name: string;
          preferred_name: string | null;
          email: string | null;
          primary_phone: string | null;
        }>
      >(
        `SELECT ip.first_name, ip.last_name, ip.preferred_name,
                pu.email, ip.primary_phone
         FROM platform.iam_person ip
         JOIN platform.platform_users pu ON pu.person_id = ip.id
         WHERE ip.id = $1::uuid
         LIMIT 1`,
        dto.linkedPersonId,
      );
      if (personRows.length === 0) {
        throw new BadRequestException('Linked person not found or has no CampusOS account.');
      }
      const p = personRows[0]!;
      linkedPersonId = dto.linkedPersonId;
      resolvedName =
        (p.preferred_name?.trim() ? p.preferred_name : null) ||
        [p.first_name, p.last_name].filter(Boolean).join(' ');
      resolvedPhonePrimary = p.primary_phone ?? resolvedPhonePrimary;
      resolvedEmail = p.email ?? resolvedEmail;
      // Caller can still supply an explicit phonePrimary fallback if
      // the linked person hasn't set one yet — we use the dto value
      // only as a backstop, the iam_person value wins when present.
    }

    if (!resolvedName) {
      throw new BadRequestException('Name is required for manual emergency contacts.');
    }
    if (!resolvedPhonePrimary) {
      throw new BadRequestException('Primary phone is required.');
    }

    const id = generateId();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_family_emergency_contacts
           (id, family_id, linked_person_id, name, relationship,
            phone_primary, phone_alternate, email, authorized_pickup,
            priority_order)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5,
                 $6, $7, $8, $9, $10)`,
        id,
        familyId,
        linkedPersonId,
        resolvedName,
        dto.relationship,
        resolvedPhonePrimary,
        resolvedPhoneAlternate,
        resolvedEmail,
        dto.authorizedPickup ?? false,
        dto.priorityOrder ?? 0,
      );
    } catch (err: unknown) {
      const code = (err as { code?: string; meta?: { code?: string } }).code;
      const sqlState = (err as { meta?: { code?: string } }).meta?.code;
      if (code === 'P2002' || sqlState === '23505') {
        throw new ConflictException(
          'A family emergency contact with that primary phone already exists.',
        );
      }
      throw err;
    }
    // Re-fetch via list to get the same JOIN-shape the read path uses.
    const created = await this.prisma.$queryRawUnsafe<Array<EmergencyContactRow>>(
      this.familyEcSelectSql() + ' WHERE fec.id = $1::uuid LIMIT 1',
      id,
    );
    if (created.length === 0) {
      throw new HttpException(
        'Insert succeeded but row not found',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return this.toFamilyEmergencyContactDto(created[0]!);
  }

  async updateFamilyEmergencyContact(
    personId: string,
    contactId: string,
    dto: UpdateFamilyEmergencyContactDto,
  ): Promise<FamilyEmergencyContactDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const existing = await this.prisma.platformFamilyEmergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.familyId !== familyId) {
      throw new NotFoundException('Family emergency contact not found');
    }
    const isLinked = existing.linkedPersonId !== null;

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (dto.relationship !== undefined) {
      setClauses.push('relationship = $' + i++);
      values.push(dto.relationship);
    }
    if (dto.authorizedPickup !== undefined) {
      setClauses.push('authorized_pickup = $' + i++);
      values.push(dto.authorizedPickup);
    }
    if (dto.priorityOrder !== undefined) {
      setClauses.push('priority_order = $' + i++);
      values.push(dto.priorityOrder);
    }
    // name/phone/email writes are no-ops on linked rows — the read
    // path always pulls fresh from iam_person. Silently skip rather
    // than 400 so a "save all fields" client doesn't have to gate
    // its payload on isLinked.
    if (!isLinked) {
      if (dto.name !== undefined) {
        setClauses.push('name = $' + i++);
        values.push(dto.name);
      }
      if (dto.phonePrimary !== undefined) {
        setClauses.push('phone_primary = $' + i++);
        values.push(dto.phonePrimary);
      }
      if (dto.phoneAlternate !== undefined) {
        setClauses.push('phone_alternate = $' + i++);
        values.push(dto.phoneAlternate);
      }
      if (dto.email !== undefined) {
        setClauses.push('email = $' + i++);
        values.push(dto.email);
      }
    }

    if (setClauses.length > 0) {
      setClauses.push('updated_at = now()');
      values.push(contactId);
      try {
        await this.prisma.$executeRawUnsafe(
          'UPDATE platform.platform_family_emergency_contacts SET ' +
            setClauses.join(', ') +
            ' WHERE id = $' +
            i +
            '::uuid',
          ...values,
        );
      } catch (err: unknown) {
        const code = (err as { code?: string; meta?: { code?: string } }).code;
        const sqlState = (err as { meta?: { code?: string } }).meta?.code;
        if (code === 'P2002' || sqlState === '23505') {
          throw new ConflictException(
            'A family emergency contact with that primary phone already exists.',
          );
        }
        throw err;
      }
    }

    const refreshed = await this.prisma.$queryRawUnsafe<Array<EmergencyContactRow>>(
      this.familyEcSelectSql() + ' WHERE fec.id = $1::uuid LIMIT 1',
      contactId,
    );
    if (refreshed.length === 0) {
      throw new NotFoundException('Family emergency contact not found');
    }
    return this.toFamilyEmergencyContactDto(refreshed[0]!);
  }

  async removeFamilyEmergencyContact(personId: string, contactId: string): Promise<void> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const existing = await this.prisma.platformFamilyEmergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.familyId !== familyId) {
      throw new NotFoundException('Family emergency contact not found');
    }
    await this.prisma.platformFamilyEmergencyContact.delete({ where: { id: contactId } });
  }

  /**
   * Bulk reorder across the unified guardians + manual-contacts
   * namespace.
   *
   * Input ids can be either:
   *   - platform_family_members.id (a guardian row)
   *   - platform_family_emergency_contacts.id (a manual contact row)
   *
   * The server identifies which table each id belongs to via lookup
   * sets built from the caller's family, then assigns position =
   * array index to whichever table's priority column. Cross-family
   * ids are filtered out (no leak); ids not in the input are
   * appended at the end in their existing relative order so a
   * "send a partial reorder" client doesn't lose rows.
   *
   * Returns the refreshed manual-contacts list (matching the
   * existing endpoint shape). The client's React Query invalidation
   * will refetch /family separately for the guardian-side changes.
   */
  async reorderFamilyEmergencyContacts(
    personId: string,
    orderedIds: string[],
  ): Promise<FamilyEmergencyContactDto[]> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);

    const manualRows = await this.prisma.platformFamilyEmergencyContact.findMany({
      where: { familyId },
      orderBy: [{ priorityOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    const memberRows = await this.prisma.familyMember.findMany({
      where: { familyId },
      orderBy: [{ joinedAt: 'asc' }],
      select: { id: true },
    });

    const manualIdSet = new Set(manualRows.map((r) => r.id));
    const memberIdSet = new Set(memberRows.map((r) => r.id));
    const validIds = new Set<string>([...manualIdSet, ...memberIdSet]);

    const filtered = orderedIds.filter((id) => validIds.has(id));
    // Append any ids not in the input — guardians first (by joined_at),
    // manuals next (by existing priority). Keeps untouched rows in a
    // sensible relative order on partial-reorder calls.
    const remainingMembers = memberRows.map((r) => r.id).filter((id) => !filtered.includes(id));
    const remainingManuals = manualRows.map((r) => r.id).filter((id) => !filtered.includes(id));
    const finalOrder = [...filtered, ...remainingMembers, ...remainingManuals];

    await this.prisma.$transaction(
      finalOrder.map((id, idx) =>
        memberIdSet.has(id)
          ? this.prisma.familyMember.update({
              where: { id },
              data: { emergencyPriorityOrder: idx, updatedAt: new Date() },
            })
          : this.prisma.platformFamilyEmergencyContact.update({
              where: { id },
              data: { priorityOrder: idx, updatedAt: new Date() },
            }),
      ),
    );

    return this.listFamilyEmergencyContacts(personId);
  }

  /**
   * Shared SELECT for the EC list — joins iam_person + platform_users
   * so linked contacts surface the current name / phone / email
   * without a per-row second query. For manual contacts the joins
   * are NULL and the row's own columns win in the COALESCE.
   */
  private familyEcSelectSql(): string {
    return `SELECT
         fec.id::text AS id,
         fec.family_id::text AS family_id,
         fec.linked_person_id::text AS linked_person_id,
         COALESCE(
           CASE WHEN fec.linked_person_id IS NOT NULL
             THEN COALESCE(NULLIF(TRIM(ip.preferred_name), ''),
                           TRIM(CONCAT_WS(' ', ip.first_name, ip.last_name)))
             ELSE NULL
           END,
           fec.name
         ) AS name,
         fec.relationship,
         COALESCE(
           CASE WHEN fec.linked_person_id IS NOT NULL THEN ip.primary_phone ELSE NULL END,
           fec.phone_primary
         ) AS phone_primary,
         fec.phone_alternate,
         COALESCE(
           CASE WHEN fec.linked_person_id IS NOT NULL THEN pu.email ELSE NULL END,
           fec.email
         ) AS email,
         fec.authorized_pickup,
         fec.priority_order
       FROM platform.platform_family_emergency_contacts fec
       LEFT JOIN platform.iam_person ip ON ip.id = fec.linked_person_id
       LEFT JOIN platform.platform_users pu ON pu.person_id = fec.linked_person_id`;
  }

  private toFamilyEmergencyContactDto(r: EmergencyContactRow): FamilyEmergencyContactDto {
    return {
      id: r.id,
      familyId: r.family_id,
      linkedPersonId: r.linked_person_id,
      name: r.name,
      relationship: r.relationship,
      phonePrimary: r.phone_primary,
      phoneAlternate: r.phone_alternate,
      email: r.email,
      authorizedPickup: r.authorized_pickup,
      priorityOrder: r.priority_order,
    };
  }

  // ─── CRUD (Step 5) ─────────────────────────────────────────

  async listForUser(personId: string): Promise<FamilyChildDto[]> {
    const familyId = await this.findFamilyForPerson(personId);
    if (!familyId) return [];
    const familyGuardians = await this.loadFamilyGuardianPersonIds(personId);
    const rows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE pfc.family_id = $1::uuid ORDER BY pfc.created_at ASC',
      familyId,
    );
    return rows.map((r) => this.toDto(r, familyGuardians));
  }

  async create(personId: string, dto: CreateFamilyChildDto): Promise<FamilyChildDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const id = generateId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_children
         (id, family_id, person_id, first_name, middle_name, last_name, preferred_name,
          date_of_birth, gender, status, created_at)
       VALUES ($1::uuid, $2::uuid, NULL, $3, $4, $5, $6, $7::date, $8, 'PLACEHOLDER', now())`,
      id,
      familyId,
      dto.firstName,
      dto.middleName ?? null,
      dto.lastName,
      dto.preferredName ?? null,
      dto.dateOfBirth ?? null,
      dto.gender ?? null,
    );
    return this.requireById(id, personId);
  }

  async update(
    personId: string,
    childId: string,
    dto: UpdateFamilyChildDto,
  ): Promise<FamilyChildDto> {
    const row = await this.requireOwnedRow(personId, childId);
    const familyGuardians = await this.loadFamilyGuardianPersonIds(personId);

    // INDEPENDENT children own their own identity — only the account
    // holder (or an admin via a future surface) can edit. The caller
    // can still see the row via GET because they're a parent in the
    // family, but PATCH refuses. Co-guardians share MANAGED rights
    // when the managing person is anywhere in the family.
    const accessLevel = computeAccessLevel(row.status, row.managed_by_person_id, familyGuardians);
    if (accessLevel === 'INDEPENDENT') {
      throw new HttpException(
        'This account is managed by the account holder. You can view but not edit their information.',
        HttpStatus.FORBIDDEN,
      );
    }

    // For LINKED children, the iam_person row is the canonical source
    // of name + DOB + gender. Mirror those fields onto
    // platform_family_children so the existing /family/children GET
    // (which reads from the mirror) stays consistent without a join.
    // gender is ALSO written to iam_person below (see personPatch) so
    // the child's own /profile page — which reads iam_person.gender —
    // matches the parent's family view. Without that mirror the parent
    // would see the value they set while the child saw "Not Specified".
    // middle_name + preferred_name + primary_phone + notes only exist
    // on iam_person, so they're skipped silently for PLACEHOLDER
    // children (no person_id yet) but still persist on family_children.
    const childSet: string[] = [];
    const childArgs: unknown[] = [];
    let ci = 1;
    if (dto.firstName !== undefined) {
      childSet.push('first_name = $' + ci++);
      childArgs.push(dto.firstName);
    }
    if (dto.middleName !== undefined) {
      childSet.push('middle_name = $' + ci++);
      childArgs.push(dto.middleName);
    }
    if (dto.lastName !== undefined) {
      childSet.push('last_name = $' + ci++);
      childArgs.push(dto.lastName);
    }
    if (dto.preferredName !== undefined) {
      childSet.push('preferred_name = $' + ci++);
      childArgs.push(dto.preferredName);
    }
    if (dto.dateOfBirth !== undefined) {
      childSet.push('date_of_birth = $' + ci++ + '::date');
      childArgs.push(dto.dateOfBirth);
    }
    if (dto.gender !== undefined) {
      childSet.push('gender = $' + ci++);
      childArgs.push(dto.gender);
    }
    if (dto.emergencyContactSource !== undefined) {
      childSet.push('emergency_contact_source = $' + ci++);
      childArgs.push(dto.emergencyContactSource);
    }
    // Per-child address. String fields use the same '' → null
    // coercion as UpdateFamilySettingsDto so clients can submit an
    // empty input to clear a previously-saved value.
    const addressCols: Array<[keyof typeof dto, string]> = [
      ['addressSource', 'address_source'],
      ['customAddressLine1', 'custom_address_line1'],
      ['customAddressLine2', 'custom_address_line2'],
      ['customCity', 'custom_city'],
      ['customState', 'custom_state'],
      ['customPostalCode', 'custom_postal_code'],
      ['customCountry', 'custom_country'],
      ['mailingLine1', 'mailing_line1'],
      ['mailingLine2', 'mailing_line2'],
      ['mailingCity', 'mailing_city'],
      ['mailingState', 'mailing_state'],
      ['mailingPostalCode', 'mailing_postal_code'],
      ['mailingCountry', 'mailing_country'],
    ];
    for (const [dtoKey, col] of addressCols) {
      const v = dto[dtoKey];
      if (v === undefined) continue;
      childSet.push(col + ' = $' + ci++);
      childArgs.push(typeof v === 'string' && v.trim() === '' ? null : v);
    }
    if (dto.mailingAddressDifferent !== undefined) {
      childSet.push('mailing_address_different = $' + ci++);
      childArgs.push(dto.mailingAddressDifferent);
    }

    const personPatch: Record<string, unknown> = {};
    if (row.status === 'LINKED' && row.person_id) {
      if (dto.firstName !== undefined) personPatch.firstName = dto.firstName;
      if (dto.middleName !== undefined) personPatch.middleName = dto.middleName;
      if (dto.lastName !== undefined) personPatch.lastName = dto.lastName;
      if (dto.preferredName !== undefined) personPatch.preferredName = dto.preferredName;
      if (dto.gender !== undefined) personPatch.gender = dto.gender;
      if (dto.primaryPhone !== undefined) personPatch.primaryPhone = dto.primaryPhone;
      if (dto.notes !== undefined) personPatch.notes = dto.notes;
      if (dto.dateOfBirth !== undefined) {
        personPatch.dateOfBirth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null;
      }
    }

    if (childSet.length === 0 && Object.keys(personPatch).length === 0) {
      return this.toDto(row, familyGuardians);
    }

    const linkedPersonId = row.person_id;
    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(personPatch).length > 0 && linkedPersonId) {
        await tx.iamPerson.update({ where: { id: linkedPersonId }, data: personPatch });
      }
      if (childSet.length > 0) {
        childSet.push('updated_at = now()');
        childArgs.push(childId);
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_children
           SET ${childSet.join(', ')}
           WHERE id = $${ci}::uuid`,
          ...childArgs,
        );
      }
    });
    return this.requireById(childId, personId);
  }

  /**
   * DELETE /family/children/:id — only PLACEHOLDER rows may be
   * removed. Codex review FIX 3: the prior implementation would
   * silently revoke a PENDING_LINK invitation as a side-effect of
   * delete, which conflated "I no longer want to invite this person"
   * with "remove this child entirely." Callers must now cancel the
   * link explicitly via /cancel-link, which resets the row back to
   * PLACEHOLDER; the row can then be deleted normally.
   */
  async remove(personId: string, childId: string): Promise<void> {
    const row = await this.requireOwnedRow(personId, childId);
    if (row.status === 'LINKED') {
      throw new BadRequestException(
        'Cannot remove a linked child. Use /unlink to detach the canonical account.',
      );
    }
    if (row.status === 'PENDING_LINK') {
      throw new BadRequestException(
        'Cancel the link invitation first (POST /family/children/:id/cancel-link), then remove the child.',
      );
    }
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_children WHERE id = $1::uuid`,
      childId,
    );
  }

  /**
   * POST /family/children/:id/cancel-link — revokes the outstanding
   * CHILD_LINK invitation and resets the family_child row back to
   * PLACEHOLDER. After cancelling the row can either be deleted or
   * have a fresh link sent.
   */
  async cancelLink(personId: string, childId: string): Promise<FamilyChildDto> {
    const row = await this.requireOwnedRow(personId, childId);
    if (row.status !== 'PENDING_LINK') {
      throw new BadRequestException(
        `Cannot cancel a link in status ${row.status}; expected PENDING_LINK`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (row.invite_code) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_invitations
             SET status = 'REVOKED'
           WHERE token = $1 AND status = 'PENDING'`,
          row.invite_code,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_children
           SET status = 'PLACEHOLDER',
               invite_code = NULL,
               invite_email = NULL,
               invite_sent_at = NULL,
               updated_at = now()
         WHERE id = $1::uuid`,
        childId,
      );
    });
    return this.requireById(childId, personId);
  }

  // ─── Account creation + linking (Step 6) ───────────────────

  /**
   * POST /family/children/:id/create-account — Option C: parent-managed
   * minor account. Creates iam_person + platform_users for the child,
   * stamps platform_family_children to LINKED, and refreshes the
   * parent's persona cache so PARENT activates.
   *
   * COPPA gate: under-13 (computed from date_of_birth if present)
   * accounts MUST NOT carry a target email; the parent manages
   * everything. 13+ children may have their own email. We don't have a
   * real Keycloak provisioning hook yet — the email is recorded on
   * platform_users and a future migration / sync worker will mirror to
   * the IdP.
   */
  async createAccountForChild(
    personId: string,
    childId: string,
    dto: CreateChildAccountDto,
  ): Promise<FamilyChildDto> {
    const row = await this.requireOwnedRow(personId, childId);
    if (row.status !== 'PLACEHOLDER') {
      throw new BadRequestException(
        `Cannot create account for child in status ${row.status}; expected PLACEHOLDER`,
      );
    }
    const ageYears = row.date_of_birth ? ageInYears(row.date_of_birth) : null;
    if (dto.email && ageYears !== null && ageYears < 13) {
      throw new BadRequestException(
        'Under-13 accounts are parent-managed and cannot have their own email (COPPA)',
      );
    }
    const newPersonId = generateId();
    const newAccountId = generateId();
    const emailForAccount = dto.email ?? this.syntheticChildEmail(newPersonId);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.iam_person
           (id, first_name, last_name, date_of_birth, person_type, is_active, created_at)
         VALUES ($1::uuid, $2, $3, $4::date, 'STUDENT', true, now())`,
        newPersonId,
        row.first_name,
        row.last_name,
        row.date_of_birth,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.platform_users
           (id, person_id, email, display_name, account_status, account_type,
            mfa_enabled, is_minor_account, managed_by_person_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'PENDING_VERIFICATION', 'HUMAN',
                 false, true, $5::uuid, now())`,
        newAccountId,
        newPersonId,
        emailForAccount,
        row.first_name + ' ' + row.last_name,
        personId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_children
           SET person_id = $1::uuid,
               status = 'LINKED',
               linked_at = now(),
               updated_at = now()
         WHERE id = $2::uuid`,
        newPersonId,
        childId,
      );
    });

    await this.refreshPersonaCacheSafe(personId);
    return this.requireById(childId, personId);
  }

  /**
   * POST /family/children/:id/send-link — generate an 8-char alphanumeric
   * invite code, stamp PENDING_LINK on the family child, and store the
   * outstanding invitation row. The email send is a TODO — for now we
   * log the code so devs can copy it locally.
   */
  async sendLinkInvitation(
    personId: string,
    childId: string,
    dto: SendChildLinkDto,
  ): Promise<FamilyChildDto> {
    const row = await this.requireOwnedRow(personId, childId);
    // Codex review FIX 4 — accept both PLACEHOLDER (first send) and
    // PENDING_LINK (resend). LINKED rows reject; the canonical
    // account is already attached and there's nothing to invite.
    if (row.status !== 'PLACEHOLDER' && row.status !== 'PENDING_LINK') {
      throw new BadRequestException(
        `Cannot send link invitation for child in status ${row.status}; expected PLACEHOLDER or PENDING_LINK`,
      );
    }
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);

    await this.prisma.$transaction(async (tx) => {
      // Revoke the previous outstanding invitation (if any) so we
      // don't leak a still-valid old code after a resend.
      if (row.status === 'PENDING_LINK' && row.invite_code) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_invitations
             SET status = 'REVOKED'
           WHERE token = $1 AND status = 'PENDING'`,
          row.invite_code,
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.platform_invitations
           (id, type, token, inviter_person_id, target_email, metadata, status, expires_at, created_at)
         VALUES ($1::uuid, 'CHILD_LINK', $2, $3::uuid, $4,
                 jsonb_build_object('familyChildId', $5::text),
                 'PENDING', $6::timestamptz, now())`,
        invitationId,
        code,
        personId,
        dto.email,
        childId,
        expiresAt.toISOString(),
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_children
           SET status = 'PENDING_LINK',
               invite_code = $1,
               invite_email = $2,
               invite_sent_at = now(),
               updated_at = now()
         WHERE id = $3::uuid`,
        code,
        dto.email,
        childId,
      );
    });

    this.logger.log(
      `[child-link-invite] family_child=${childId} code=${code} expires=${expiresAt.toISOString()}`,
    );

    return this.requireById(childId, personId);
  }

  /**
   * POST /family/link — accept a family-link invitation. Dispatches on
   * invitation type + metadata shape:
   *
   *   FAMILY_INVITE
   *     A PARENT issued an open code via /family/generate-code. The
   *     accepter (current user) joins the inviter's family as a
   *     LINKED child. Auto-matches a same-name PLACEHOLDER row in
   *     the inviter's family if one exists; otherwise creates a
   *     fresh row using the accepter's iam_person identity.
   *
   *   CHILD_LINK with metadata.familyChildId
   *     Existing parent-issued path. The accepter is the CHILD
   *     (or second parent) named on the PLACEHOLDER family_child
   *     row; we stamp person_id + status=LINKED on that row.
   *
   *   CHILD_LINK without metadata.familyChildId
   *     New path — a CHILD issued the code via
   *     /family/generate-child-code. The accepter (current user) is
   *     the PARENT. We add the child to the parent's family the
   *     same way as FAMILY_INVITE but with inviter/accepter
   *     reversed — auto-match against a same-name PLACEHOLDER or
   *     create a fresh LINKED row using the child's iam_person.
   *
   * Persona refresh: whichever side is the PARENT (FAMILY_INVITE
   * inviter, parent-issued CHILD_LINK inviter, or child-issued
   * CHILD_LINK accepter) has their persona cache refreshed so PARENT
   * activates immediately.
   */
  async acceptLinkCode(
    personId: string,
    accountId: string,
    dto: AcceptFamilyLinkDto,
  ): Promise<FamilyLinkResultDto> {
    await this.assertLinkRateLimit(accountId);

    const codeUpper = dto.code.toUpperCase();
    const invitation = await this.prisma.platformInvitation.findUnique({
      where: { token: codeUpper },
      select: {
        id: true,
        type: true,
        status: true,
        inviterPersonId: true,
        targetEmail: true,
        metadata: true,
        expiresAt: true,
      },
    });
    if (
      !invitation ||
      invitation.status !== 'PENDING' ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new NotFoundException('Invalid or expired link code');
    }

    if (invitation.type === 'GUARDIAN_INVITE') {
      return this.acceptGuardianInvite(personId, invitation);
    }
    if (invitation.type === 'FAMILY_INVITE') {
      const child = await this.acceptFamilyInvite(personId, invitation);
      return { kind: 'CHILD', child };
    }
    if (invitation.type === 'CHILD_LINK') {
      const metadata = invitation.metadata as { familyChildId?: string } | null;
      const child = metadata?.familyChildId
        ? await this.acceptParentIssuedChildLink(personId, invitation, metadata.familyChildId)
        : await this.acceptChildIssuedLink(personId, invitation);
      return { kind: 'CHILD', child };
    }

    // Other invitation types (EMPLOYEE / PARENT_LINK / SUBSTITUTE)
    // have their own dispatcher in InvitationService. /family/link is
    // family-only — surface as NotFound rather than leak the type.
    throw new NotFoundException('Invalid or expired link code');
  }

  // ─── Generate codes — bidirectional family-link feature ─────

  /**
   * POST /family/generate-code — parent generates a FAMILY_INVITE
   * code. The accepter joins the parent's family as a LINKED child.
   * Ensures the caller has a platform_families row first (registration
   * normally seeds one; this is a safety net for accounts that
   * pre-date that flow).
   */
  async generateFamilyCode(
    personId: string,
    dto: GenerateFamilyCodeDto = {},
  ): Promise<GenerateLinkCodeDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, target_email, metadata, status, expires_at, created_at)
       VALUES ($1::uuid, 'FAMILY_INVITE', $2, $3::uuid, $4,
               jsonb_build_object('familyId', $5::text),
               'PENDING', $6::timestamptz, now())`,
      invitationId,
      code,
      personId,
      dto.email ?? null,
      familyId,
      expiresAt.toISOString(),
    );
    if (dto.email) {
      this.logger.log(
        `[family-invite] family=${familyId} code=${code} expires=${expiresAt.toISOString()}`,
      );
    }
    return { code, expiresAt: expiresAt.toISOString(), type: 'FAMILY_INVITE' };
  }

  /**
   * POST /family/invite-guardian — parent generates a GUARDIAN_INVITE
   * code. Whoever accepts is added to the family as a co-parent (a
   * second HEAD_OF_HOUSEHOLD row in platform_family_members) and
   * gains full read/write on every child in the family.
   *
   * Optional `email` lands on target_email so a future email-send
   * worker has the address to use; the code itself is shareable out
   * of band so the caller can also copy + paste it.
   */
  async generateGuardianInvite(
    personId: string,
    dto: InviteGuardianDto,
  ): Promise<GenerateLinkCodeDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);
    // The accepter's iam_person is the canonical source for their
    // name post-accept; firstName/lastName/relationship sit on the
    // invitation as informational hints for the eventual email body
    // and any pre-accept display in /invitations/mine.
    const metadata: Record<string, unknown> = { familyId };
    if (dto.firstName) metadata.targetFirstName = dto.firstName.trim();
    if (dto.lastName) metadata.targetLastName = dto.lastName.trim();
    if (dto.relationship) metadata.relationship = dto.relationship.trim();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, target_email, metadata, status, expires_at, created_at)
       VALUES ($1::uuid, 'GUARDIAN_INVITE', $2, $3::uuid, $4, $5::jsonb,
               'PENDING', $6::timestamptz, now())`,
      invitationId,
      code,
      personId,
      dto.email ?? null,
      JSON.stringify(metadata),
      expiresAt.toISOString(),
    );
    if (dto.email) {
      this.logger.log(
        `[guardian-invite] family=${familyId} code=${code} expires=${expiresAt.toISOString()}`,
      );
    }
    return { code, expiresAt: expiresAt.toISOString(), type: 'GUARDIAN_INVITE' };
  }

  // ─── Placeholder guardian members ─────────────────────────

  /**
   * POST /family/members — add a placeholder guardian. Creates a
   * platform_family_members row with person_id NULL, status=PLACEHOLDER,
   * and the parent-supplied display fields. No iam_person is created —
   * that comes later via create-account or invite-accept.
   */
  async addPlaceholderMember(personId: string, dto: AddFamilyMemberDto): Promise<FamilyMemberDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const id = generateId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_members
         (id, family_id, person_id, member_role, is_primary_contact, status,
          first_name, last_name, email, joined_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, NULL, 'PARENT', false, 'PLACEHOLDER',
               $3, $4, $5, now(), now(), now())`,
      id,
      familyId,
      dto.firstName.trim(),
      dto.lastName.trim(),
      dto.email?.trim() || null,
    );
    return this.requireMemberById(id, personId);
  }

  /**
   * PATCH /family/members/:id — edit a PLACEHOLDER or PENDING_INVITE
   * guardian's display fields. ACTIVE rows reject: an ACTIVE
   * INDEPENDENT guardian owns their identity via /profile + their
   * own iam_person row; an ACTIVE MANAGED guardian (created via
   * /family/members/:id/create-account) currently still routes
   * through this same row, but we refuse PATCH here and direct
   * those edits through the child/profile-edit path that already
   * writes both iam_person + the family-members mirror correctly.
   */
  async updateMember(
    personId: string,
    memberId: string,
    dto: UpdateFamilyMemberDto,
  ): Promise<FamilyMemberDto> {
    const row = await this.requireOwnedMemberRow(personId, memberId);

    // emergencyAuthorizedPickup is a family-level preference about
    // the guardian, NOT an identity field — settable on ACTIVE rows
    // too, even though firstName/lastName/email are not. Process it
    // first, before the ACTIVE-reject guard, so a parent toggling
    // pickup on a co-parent doesn't get the "edit their profile via
    // /profile" error.
    if (dto.emergencyAuthorizedPickup !== undefined) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform.platform_family_members
         SET emergency_authorized_pickup = $1, updated_at = now()
         WHERE id = $2::uuid`,
        dto.emergencyAuthorizedPickup,
        memberId,
      );
    }

    if (row.status === 'ACTIVE') {
      const wantsIdentityEdit =
        dto.firstName !== undefined || dto.lastName !== undefined || dto.email !== undefined;
      if (!wantsIdentityEdit) {
        // Pickup-only update (or no-op) — return the freshly-updated row.
        return this.requireMemberById(memberId, personId);
      }
      const familyGuardians = await this.loadFamilyGuardianPersonIds(personId);
      const accessLevel = computeAccessLevel(
        'LINKED',
        row.managed_by_person_id ?? null,
        familyGuardians,
      );
      if (accessLevel === 'INDEPENDENT') {
        throw new HttpException(
          'This account is managed by the account holder. You can view but not edit their information.',
          HttpStatus.FORBIDDEN,
        );
      }
      throw new BadRequestException(
        'Cannot edit a linked guardian here — edit their profile via /profile instead.',
      );
    }
    const set: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (dto.firstName !== undefined) {
      set.push('first_name = $' + i++);
      args.push(dto.firstName.trim());
    }
    if (dto.lastName !== undefined) {
      set.push('last_name = $' + i++);
      args.push(dto.lastName.trim());
    }
    if (dto.email !== undefined) {
      set.push('email = $' + i++);
      args.push(dto.email ? dto.email.trim() : null);
    }
    if (set.length === 0) {
      // The only field was the pickup toggle (already written above)
      // or genuinely empty patch — return the fresh row either way.
      return this.requireMemberById(memberId, personId);
    }
    set.push('updated_at = now()');
    args.push(memberId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_members SET ${set.join(', ')} WHERE id = $${i}::uuid`,
      ...args,
    );
    return this.requireMemberById(memberId, personId);
  }

  /**
   * DELETE /family/members/:id — remove a PLACEHOLDER or
   * PENDING_INVITE guardian. ACTIVE rows reject — leaving the family
   * is the guardian's own decision and lives on a separate unlink
   * surface. Outstanding GUARDIAN_INVITE codes for the row are
   * revoked in the same tx.
   */
  async removeMember(personId: string, memberId: string): Promise<void> {
    const row = await this.requireOwnedMemberRow(personId, memberId);
    if (row.status === 'ACTIVE') {
      throw new BadRequestException(
        'Cannot remove a linked guardian. They must leave the family themselves.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (row.invite_code) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_invitations
             SET status = 'REVOKED'
           WHERE token = $1 AND status = 'PENDING'`,
          row.invite_code,
        );
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_members WHERE id = $1::uuid`,
        memberId,
      );
    });
  }

  /**
   * POST /family/members/:id/create-account — synthesise an
   * iam_person + platform_users for a PLACEHOLDER guardian and link
   * them. The account lands at PENDING_VERIFICATION; the
   * family_members row is promoted to ACTIVE in the same tx. Refreshes
   * the new guardian's persona cache so PARENT activates on their
   * next sign-in. Returns the updated member.
   */
  async createAccountForMember(
    personId: string,
    memberId: string,
    dto: CreateMemberAccountDto,
  ): Promise<FamilyMemberDto> {
    const row = await this.requireOwnedMemberRow(personId, memberId);
    if (row.status === 'ACTIVE') {
      throw new BadRequestException('Member already has an account.');
    }
    const newPersonId = generateId();
    const newAccountId = generateId();
    const email = dto.email?.trim() || row.email || this.syntheticGuardianEmail(newPersonId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.iam_person
           (id, first_name, last_name, person_type, is_active, created_at)
         VALUES ($1::uuid, $2, $3, 'EXTERNAL', true, now())`,
        newPersonId,
        row.first_name ?? '',
        row.last_name ?? '',
      );
      await tx.$executeRawUnsafe(
        // managed_by_person_id = the parent who created the account.
        // This stamps the new guardian's platform_users row as a
        // MANAGED account from the caller's perspective — they're
        // the custodian, and PATCH /family/members/:id will let them
        // through. The new guardian becomes INDEPENDENT relative to
        // other family members.
        `INSERT INTO platform.platform_users
           (id, person_id, email, display_name, account_status, account_type,
            mfa_enabled, is_minor_account, managed_by_person_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'PENDING_VERIFICATION', 'HUMAN',
                 false, false, $5::uuid, now())`,
        newAccountId,
        newPersonId,
        email,
        ((row.first_name ?? '') + ' ' + (row.last_name ?? '')).trim() || 'Family member',
        personId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_members
           SET person_id = $1::uuid,
               status = 'ACTIVE',
               invite_code = NULL,
               invite_sent_at = NULL,
               updated_at = now()
         WHERE id = $2::uuid`,
        newPersonId,
        memberId,
      );
    });
    await this.refreshPersonaCacheSafe(newPersonId);
    return this.requireMemberById(memberId, personId);
  }

  /**
   * POST /family/members/:id/send-invite — generate a GUARDIAN_INVITE
   * scoped to this specific placeholder row. metadata.familyMemberId
   * tells acceptGuardianInvite to UPDATE the existing row in place
   * rather than INSERT a fresh one, preserving the parent-typed
   * display name + relationship.
   */
  async sendMemberInvite(
    personId: string,
    memberId: string,
    dto: SendMemberInviteDto,
  ): Promise<FamilyMemberDto> {
    const row = await this.requireOwnedMemberRow(personId, memberId);
    if (row.status === 'ACTIVE') {
      throw new BadRequestException('Member is already linked.');
    }
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);
    const targetEmail = dto.email?.trim() || row.email || null;
    await this.prisma.$transaction(async (tx) => {
      // Revoke any previous outstanding invite for this row so the
      // old code can't still link after a resend.
      if (row.invite_code) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_invitations
             SET status = 'REVOKED'
           WHERE token = $1 AND status = 'PENDING'`,
          row.invite_code,
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.platform_invitations
           (id, type, token, inviter_person_id, target_email, metadata, status, expires_at, created_at)
         VALUES ($1::uuid, 'GUARDIAN_INVITE', $2, $3::uuid, $4,
                 jsonb_build_object('familyId', $5::text, 'familyMemberId', $6::text),
                 'PENDING', $7::timestamptz, now())`,
        invitationId,
        code,
        personId,
        targetEmail,
        row.family_id,
        memberId,
        expiresAt.toISOString(),
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_members
           SET status = 'PENDING_INVITE',
               invite_code = $1,
               invite_sent_at = now(),
               updated_at = now()
         WHERE id = $2::uuid`,
        code,
        memberId,
      );
    });
    if (targetEmail) {
      this.logger.log(
        `[guardian-invite-member] member=${memberId} code=${code} expires=${expiresAt.toISOString()}`,
      );
    }
    return this.requireMemberById(memberId, personId);
  }

  /**
   * POST /family/generate-child-code — child generates a CHILD_LINK
   * code with NO familyChildId metadata. The parent who accepts
   * adds this person as a LINKED child in the parent's family
   * (auto-match against PLACEHOLDER if names line up, otherwise
   * fresh row).
   */
  async generateChildCode(personId: string): Promise<GenerateLinkCodeDto> {
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, metadata, status, expires_at, created_at)
       VALUES ($1::uuid, 'CHILD_LINK', $2, $3::uuid, NULL,
               'PENDING', $4::timestamptz, now())`,
      invitationId,
      code,
      personId,
      expiresAt.toISOString(),
    );
    return { code, expiresAt: expiresAt.toISOString(), type: 'CHILD_LINK' };
  }

  // ─── Internal accept-flow dispatchers ───────────────────────

  private async acceptParentIssuedChildLink(
    personId: string,
    invitation: { id: string; inviterPersonId: string },
    familyChildId: string,
  ): Promise<FamilyChildDto> {
    const child = await this.findById(familyChildId);
    if (!child || child.status === 'LINKED') {
      // Child was already linked through another flow — 404 so we
      // don't leak the family_child id state.
      throw new NotFoundException('Invalid or expired link code');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_children
           SET person_id = $1::uuid,
               status = 'LINKED',
               linked_at = now(),
               updated_at = now()
         WHERE id = $2::uuid`,
        personId,
        familyChildId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_invitations
           SET status = 'ACCEPTED',
               target_person_id = $1::uuid,
               accepted_at = now()
         WHERE id = $2::uuid`,
        personId,
        invitation.id,
      );
    });
    await this.refreshPersonaCacheSafe(invitation.inviterPersonId);
    return this.requireById(familyChildId, personId);
  }

  /**
   * Accept a GUARDIAN_INVITE — add the caller as a co-parent on the
   * inviter's family. Inserts a HEAD_OF_HOUSEHOLD (or upgrades a
   * pre-existing row to is_primary_contact=false) so the new
   * guardian appears alongside the inviter in /family.members[].
   * Refuses if the caller is already a member (idempotent re-accept
   * surfaces as a 400 rather than a UNIQUE-violation).
   */
  private async acceptGuardianInvite(
    personId: string,
    invitation: {
      id: string;
      inviterPersonId: string;
      targetEmail: string | null;
      metadata: unknown;
    },
  ): Promise<FamilyLinkResultDto> {
    const metadata = invitation.metadata as {
      familyId?: string;
      familyMemberId?: string;
      targetFirstName?: string;
      targetLastName?: string;
    } | null;
    const familyId = metadata?.familyId;
    const targetMemberId = metadata?.familyMemberId;
    if (!familyId) {
      throw new NotFoundException('Invalid or expired link code');
    }
    if (personId === invitation.inviterPersonId) {
      throw new BadRequestException('You cannot accept your own family code');
    }

    // platform_family_members.person_id is UNIQUE — a person can only
    // be a member of one family. If the caller is already a member of
    // ANY family, we need to decide what to do:
    //
    //   - Same family as the invite → 400 ("already a guardian of
    //     this family"). Idempotent-friendly.
    //   - Different family, but that family is "empty" (the auto-
    //     seeded singleton from /auth/register, with no children and
    //     no other guardians) → dissolve it and continue. This is
    //     the common case where Parent B registered independently,
    //     hasn't added any children of their own yet, and now Parent
    //     A invites them as a co-parent.
    //   - Different family that has children or other guardians of
    //     its own → 400 with a clearer message. Merging two real
    //     families isn't supported on this surface yet.
    const existing = await this.prisma.familyMember.findUnique({
      where: { personId },
      select: { id: true, familyId: true },
    });
    let existingFamilyToDissolve: string | null = null;
    if (existing) {
      if (existing.familyId === familyId) {
        throw new BadRequestException('You are already a guardian of this family');
      }
      const childCountRows = await this.prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        `SELECT COUNT(*)::bigint AS cnt
         FROM platform.platform_family_children
         WHERE family_id = $1::uuid`,
        existing.familyId,
      );
      const otherMemberRows = await this.prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        `SELECT COUNT(*)::bigint AS cnt
         FROM platform.platform_family_members
         WHERE family_id = $1::uuid AND id <> $2::uuid`,
        existing.familyId,
        existing.id,
      );
      const childCount = Number(childCountRows[0]?.cnt ?? 0n);
      const otherMemberCount = Number(otherMemberRows[0]?.cnt ?? 0n);
      if (childCount > 0 || otherMemberCount > 0) {
        throw new BadRequestException(
          "You already belong to a family with children or other guardians. Joining another family as a guardian isn't supported yet.",
        );
      }
      // Empty singleton — safe to dissolve in the same tx as the join.
      existingFamilyToDissolve = existing.familyId;
    }

    // metadata.familyMemberId distinguishes a targeted invite (from
    // /family/members/:id/send-invite, which created a placeholder
    // row and named this member specifically) from an open invite
    // (from /family/invite-guardian, which carries only familyId).
    // Targeted invites UPDATE the existing PLACEHOLDER /
    // PENDING_INVITE row to ACTIVE; open invites INSERT a new row.
    await this.prisma.$transaction(async (tx) => {
      if (existingFamilyToDissolve) {
        // Drop the singleton family_members row first so the UNIQUE
        // (person_id) constraint releases before the join below
        // tries to UPDATE/INSERT a new row for this person. Then
        // delete the now-empty family (its FK-cascade siblings —
        // emergency contacts, contact preferences — go with it).
        await tx.familyMember.delete({ where: { id: existing!.id } });
        await tx.platformFamily.delete({ where: { id: existingFamilyToDissolve } });
      }
      if (targetMemberId) {
        const targetRows = await tx.$queryRawUnsafe<Array<{ family_id: string; status: string }>>(
          `SELECT family_id::text AS family_id, status
           FROM platform.platform_family_members
           WHERE id = $1::uuid
           LIMIT 1`,
          targetMemberId,
        );
        const target = targetRows[0];
        if (!target || target.family_id !== familyId || target.status === 'ACTIVE') {
          throw new NotFoundException('Invalid or expired link code');
        }
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_members
             SET person_id = $1::uuid,
                 status = 'ACTIVE',
                 invite_code = NULL,
                 invite_sent_at = NULL,
                 joined_at = now(),
                 updated_at = now()
           WHERE id = $2::uuid`,
          personId,
          targetMemberId,
        );
      } else {
        // First — look for an existing ACTIVE row in the family
        // whose iam_person matches the invitation's named target
        // AND whose platform_users.email is the synthetic
        // `@external.invalid` shape (the createMemberAccount
        // artifact). That row is the placeholder-promoted-to-ACTIVE
        // shadow of the real accepter; without dropping it the
        // partial UNIQUE INDEX on (family_id, person_id) lets us
        // INSERT the real person too, but the /family page would
        // render Ashley twice (synthetic + real). Delete the
        // synthetic family_members row in-tx. The synthetic
        // iam_person + platform_users rows are left as orphans
        // intentionally — they may be referenced by persona cache
        // / managed-account links that future cleanup can prune.
        if (metadata?.targetFirstName && metadata?.targetLastName) {
          const syntheticActive = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT pfm.id::text AS id
             FROM platform.platform_family_members pfm
             JOIN platform.iam_person p ON p.id = pfm.person_id
             JOIN platform.platform_users u ON u.person_id = p.id
             WHERE pfm.family_id = $1::uuid
               AND pfm.status = 'ACTIVE'
               AND pfm.person_id IS NOT NULL
               AND pfm.person_id <> $4::uuid
               AND u.email LIKE '%@external.invalid'
               AND LOWER(p.first_name) = LOWER($2::text)
               AND LOWER(p.last_name)  = LOWER($3::text)
             ORDER BY pfm.created_at ASC
             LIMIT 1`,
            familyId,
            metadata.targetFirstName,
            metadata.targetLastName,
            personId,
          );
          if (syntheticActive[0]) {
            await tx.familyMember.delete({ where: { id: syntheticActive[0].id } });
          }
        }

        // Open invite — look for an unclaimed PLACEHOLDER /
        // PENDING_INVITE row in this family that matches the
        // accepter by email or by (first_name, last_name). The
        // common case: Adam previously added Ashley as a placeholder
        // guardian via /family/members POST, THEN issued an open
        // /family/invite-guardian code; without this match, the
        // accept would INSERT a duplicate ACTIVE row and the
        // /family page would render Ashley twice (once for the
        // placeholder + once for the ACTIVE row). Match in priority
        // order: email > name. Pick the oldest match so re-clicks
        // are deterministic.
        const claimable = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT pfm.id::text AS id
           FROM platform.platform_family_members pfm
           WHERE pfm.family_id = $1::uuid
             AND pfm.person_id IS NULL
             AND pfm.status IN ('PLACEHOLDER', 'PENDING_INVITE')
             AND (
               ($2::text IS NOT NULL AND LOWER(pfm.email) = LOWER($2::text))
               OR (
                 $3::text IS NOT NULL AND $4::text IS NOT NULL
                 AND LOWER(pfm.first_name) = LOWER($3::text)
                 AND LOWER(pfm.last_name)  = LOWER($4::text)
               )
             )
           ORDER BY pfm.created_at ASC
           LIMIT 1`,
          familyId,
          invitation.targetEmail,
          metadata?.targetFirstName ?? null,
          metadata?.targetLastName ?? null,
        );
        if (claimable[0]) {
          await tx.$executeRawUnsafe(
            `UPDATE platform.platform_family_members
               SET person_id = $1::uuid,
                   status = 'ACTIVE',
                   invite_code = NULL,
                   invite_sent_at = NULL,
                   joined_at = now(),
                   updated_at = now()
             WHERE id = $2::uuid`,
            personId,
            claimable[0].id,
          );
        } else {
          await tx.$executeRawUnsafe(
            `INSERT INTO platform.platform_family_members
               (id, family_id, person_id, member_role, is_primary_contact, status, joined_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', false, 'ACTIVE', now())`,
            generateId(),
            familyId,
            personId,
          );
        }
      }
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_invitations
           SET status = 'ACCEPTED', target_person_id = $1::uuid, accepted_at = now()
         WHERE id = $2::uuid`,
        personId,
        invitation.id,
      );
    });
    // The new guardian gains a PARENT persona via /auth/me's
    // resolveForPerson — the cache refresh below kicks that in
    // immediately without waiting for a re-login.
    await this.refreshPersonaCacheSafe(personId);

    const family = await this.prisma.platformFamily.findUnique({
      where: { id: familyId },
      select: { id: true, name: true },
    });
    const inviter = await this.prisma.iamPerson.findUnique({
      where: { id: invitation.inviterPersonId },
      select: { firstName: true, lastName: true, preferredName: true },
    });
    const inviterName = inviter
      ? [inviter.preferredName ?? inviter.firstName, inviter.lastName].filter(Boolean).join(' ')
      : 'a parent';
    const familyHeader: FamilyHeaderDto = {
      id: family?.id ?? familyId,
      name: family?.name ?? null,
    };
    return { kind: 'GUARDIAN', family: familyHeader, inviterName };
  }

  private async acceptFamilyInvite(
    personId: string,
    invitation: { id: string; inviterPersonId: string; metadata: unknown },
  ): Promise<FamilyChildDto> {
    const metadata = invitation.metadata as { familyId?: string } | null;
    const familyId = metadata?.familyId;
    if (!familyId) {
      throw new NotFoundException('Invalid or expired link code');
    }
    if (personId === invitation.inviterPersonId) {
      throw new BadRequestException('You cannot accept your own family code');
    }
    const newChildId = await this.upsertLinkedChildRow({
      familyId,
      childPersonId: personId,
      invitationId: invitation.id,
    });
    await this.refreshPersonaCacheSafe(invitation.inviterPersonId);
    return this.requireById(newChildId, personId);
  }

  private async acceptChildIssuedLink(
    personId: string,
    invitation: { id: string; inviterPersonId: string },
  ): Promise<FamilyChildDto> {
    if (personId === invitation.inviterPersonId) {
      throw new BadRequestException('You cannot accept your own family code');
    }
    const familyId = await this.ensureFamilyForPerson(personId);
    const newChildId = await this.upsertLinkedChildRow({
      familyId,
      childPersonId: invitation.inviterPersonId,
      invitationId: invitation.id,
      accepterPersonId: personId,
    });
    // The CALLER is the parent here; refresh their persona cache.
    await this.refreshPersonaCacheSafe(personId);
    return this.requireById(newChildId, personId);
  }

  /**
   * Shared write path for both FAMILY_INVITE and child-issued
   * CHILD_LINK accepts. Auto-matches a same-name PLACEHOLDER row in
   * the target family; if none (or multiple — ambiguous), creates a
   * fresh LINKED row using the child's iam_person identity.
   *
   * Refuses the write if a family_children row already exists for
   * (familyId, childPersonId) so re-accepting an already-LINKED code
   * surfaces as a clean 409 rather than a UNIQUE-constraint error.
   *
   * Returns the family_children id (existing PLACEHOLDER or
   * newly-inserted) so the caller can refetch the row for the
   * response.
   */
  private async upsertLinkedChildRow(opts: {
    familyId: string;
    childPersonId: string;
    invitationId: string;
    accepterPersonId?: string;
  }): Promise<string> {
    const { familyId, childPersonId, invitationId, accepterPersonId } = opts;

    const existing = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id
       FROM platform.platform_family_children
       WHERE family_id = $1::uuid AND person_id = $2::uuid
       LIMIT 1`,
      familyId,
      childPersonId,
    );
    if (existing.length > 0) {
      throw new BadRequestException('This person is already linked to the family');
    }

    const child = await this.prisma.iamPerson.findUnique({
      where: { id: childPersonId },
      select: {
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        // gender lives on sis_student_demographics, not iam_person —
        // leave NULL on the family_children row and let the parent
        // edit it through the wizard if it matters.
      },
    });
    if (!child) {
      throw new NotFoundException('Invalid or expired link code');
    }

    const placeholder = await this.findMatchingPlaceholder(
      familyId,
      child.firstName,
      child.lastName,
    );
    const dob = child.dateOfBirth ? child.dateOfBirth.toISOString().slice(0, 10) : null;
    const newId = placeholder?.id ?? generateId();
    const targetPersonForInvitation = accepterPersonId ?? childPersonId;

    await this.prisma.$transaction(async (tx) => {
      if (placeholder) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_children
             SET person_id = $1::uuid,
                 status = 'LINKED',
                 linked_at = now(),
                 updated_at = now()
           WHERE id = $2::uuid`,
          childPersonId,
          placeholder.id,
        );
      } else {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_family_children
             (id, family_id, person_id, first_name, last_name, date_of_birth, gender,
              status, linked_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, NULL,
                   'LINKED', now(), now())`,
          newId,
          familyId,
          childPersonId,
          child.firstName,
          child.lastName,
          dob,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_invitations
           SET status = 'ACCEPTED',
               target_person_id = $1::uuid,
               accepted_at = now()
         WHERE id = $2::uuid`,
        targetPersonForInvitation,
        invitationId,
      );
    });

    return newId;
  }

  private async findMatchingPlaceholder(
    familyId: string,
    firstName: string,
    lastName: string,
  ): Promise<{ id: string } | null> {
    // Case-insensitive exact-match on first + last. If 0 or 2+ rows
    // match we return null and let the caller create a fresh row;
    // ambiguity is safer to resolve by adding a new row than by
    // guessing which placeholder the parent meant.
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id
       FROM platform.platform_family_children
       WHERE family_id = $1::uuid
         AND status = 'PLACEHOLDER'
         AND lower(first_name) = lower($2)
         AND lower(last_name) = lower($3)
       LIMIT 2`,
      familyId,
      firstName.trim(),
      lastName.trim(),
    );
    return rows.length === 1 ? rows[0]! : null;
  }

  // ─── helpers ───────────────────────────────────────────────

  /**
   * The set of iam_person.id values that count as "guardians of the
   * viewer's family" for access-level purposes — used by
   * computeAccessLevel to expand MANAGED beyond the single
   * managed_by_person_id to include every co-guardian.
   *
   * Resolved via resolveViewerFamily so it works for both PARENT
   * (member of family_members) and CHILD (LINKED platform_family_children)
   * viewers. For the brand-new 0-persona case where the viewer has
   * no family yet, falls back to the viewer's own personId (so
   * single-user behaviour is preserved).
   *
   * Always includes the viewer's own personId, even if they're not
   * yet an ACTIVE member of any family.
   */
  private async loadFamilyGuardianPersonIds(viewerPersonId: string): Promise<Set<string>> {
    const set = new Set<string>([viewerPersonId]);
    const resolved = await this.resolveViewerFamily(viewerPersonId);
    if (!resolved) return set;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ person_id: string }>>(
      `SELECT person_id::text AS person_id
       FROM platform.platform_family_members
       WHERE family_id = $1::uuid
         AND status = 'ACTIVE'
         AND person_id IS NOT NULL`,
      resolved.familyId,
    );
    for (const r of rows) set.add(r.person_id);
    return set;
  }

  private async findFamilyForPerson(personId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ family_id: string }>>(
      `SELECT family_id::text AS family_id
       FROM platform.platform_family_members
       WHERE person_id = $1::uuid
       LIMIT 1`,
      personId,
    );
    return rows[0]?.family_id ?? null;
  }

  /**
   * Resolve the caller's family, creating one on demand if registration
   * didn't seed it. Idempotent — concurrent callers race on the UNIQUE
   * (family_id, person_id) constraint, so the loser falls back to the
   * existing row.
   */
  private async ensureFamilyForPerson(personId: string): Promise<string> {
    const existing = await this.findFamilyForPerson(personId);
    if (existing) return existing;
    const familyId = generateId();
    const memberId = generateId();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_families (id, name, home_language, mailing_address_same)
           VALUES ($1::uuid, NULL, 'en', true)`,
          familyId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_family_members
             (id, family_id, person_id, member_role, is_primary_contact, joined_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', true, now())`,
          memberId,
          familyId,
          personId,
        );
      });
      return familyId;
    } catch {
      // Lost the race — another concurrent call seeded the family.
      const fallback = await this.findFamilyForPerson(personId);
      if (!fallback) {
        throw new HttpException(
          'Could not resolve family for current user',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return fallback;
    }
  }

  private async requireOwnedRow(personId: string, childId: string): Promise<FamilyChildRow> {
    const familyId = await this.findFamilyForPerson(personId);
    const rows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE pfc.id = $1::uuid',
      childId,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Family child not found');
    if (!familyId || row.family_id !== familyId) {
      // Don't leak the existence of another family's child row.
      throw new NotFoundException('Family child not found');
    }
    return row;
  }

  private async requireById(childId: string, viewerPersonId: string): Promise<FamilyChildDto> {
    const row = await this.findById(childId);
    if (!row) throw new NotFoundException('Family child not found');
    const familyGuardians = await this.loadFamilyGuardianPersonIds(viewerPersonId);
    return this.toDto(row, familyGuardians);
  }

  private async findById(childId: string): Promise<FamilyChildRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE pfc.id = $1::uuid',
      childId,
    );
    return rows[0] ?? null;
  }

  /**
   * LEFT JOIN iam_person so LINKED rows surface the canonical identity
   * fields (middle_name / preferred_name / primary_phone / notes) that
   * don't have mirror columns on platform_family_children. For
   * first_name / last_name / date_of_birth — which DO have mirrors —
   * we COALESCE to the iam_person value first so a stale mirror (e.g.
   * after an out-of-band iam_person edit) doesn't shadow the
   * canonical name. PLACEHOLDER rows have person_id IS NULL so the
   * LEFT JOIN produces NULL columns and the COALESCE falls back to
   * the placeholder values.
   *
   * Required for the parent-edit form to round-trip middle_name /
   * preferred_name / phone / notes — the form's useEffect re-seeds
   * from this DTO after every save, so anything not on the wire
   * silently disappears from the inputs.
   */
  private selectSql(): string {
    return (
      'SELECT pfc.id::text AS id, ' +
      '  pfc.family_id::text AS family_id, ' +
      '  pfc.person_id::text AS person_id, ' +
      '  COALESCE(p.first_name, pfc.first_name) AS first_name, ' +
      '  COALESCE(p.middle_name, pfc.middle_name) AS middle_name, ' +
      '  COALESCE(p.last_name, pfc.last_name) AS last_name, ' +
      '  COALESCE(p.preferred_name, pfc.preferred_name) AS preferred_name, ' +
      '  COALESCE(p.date_of_birth::text, pfc.date_of_birth::text) AS date_of_birth, ' +
      '  pfc.gender AS gender, ' +
      '  p.primary_phone AS primary_phone, ' +
      '  p.notes AS notes, ' +
      '  pfc.status, ' +
      '  pfc.emergency_contact_source AS emergency_contact_source, ' +
      '  pfc.address_source, ' +
      '  pfc.custom_address_line1, pfc.custom_address_line2, ' +
      '  pfc.custom_city, pfc.custom_state, pfc.custom_postal_code, pfc.custom_country, ' +
      '  pfc.mailing_address_different, ' +
      '  pfc.mailing_line1, pfc.mailing_line2, pfc.mailing_city, ' +
      '  pfc.mailing_state, pfc.mailing_postal_code, pfc.mailing_country, ' +
      '  pu.email AS email, ' +
      '  pfc.invite_code, pfc.invite_email, ' +
      '  pfc.invite_sent_at::text AS invite_sent_at, ' +
      '  pfc.linked_at::text AS linked_at, ' +
      '  pfc.created_at::text AS created_at, ' +
      '  pu.managed_by_person_id::text AS managed_by_person_id ' +
      'FROM platform.platform_family_children pfc ' +
      'LEFT JOIN platform.iam_person p ON p.id = pfc.person_id ' +
      'LEFT JOIN platform.platform_users pu ON pu.person_id = pfc.person_id '
    );
  }

  private toDto(r: FamilyChildRow, familyGuardians: ReadonlySet<string>): FamilyChildDto {
    return {
      id: r.id,
      familyId: r.family_id,
      personId: r.person_id,
      firstName: r.first_name,
      middleName: r.middle_name,
      lastName: r.last_name,
      preferredName: r.preferred_name,
      dateOfBirth: r.date_of_birth,
      gender: r.gender,
      primaryPhone: r.primary_phone,
      notes: r.notes,
      status: r.status as FamilyChildDto['status'],
      accessLevel: computeAccessLevel(r.status, r.managed_by_person_id, familyGuardians),
      emergencyContactSource: r.emergency_contact_source === 'CUSTOM' ? 'CUSTOM' : 'FAMILY',
      addressSource: (r.address_source === 'CUSTOM' ? 'CUSTOM' : 'FAMILY') as 'FAMILY' | 'CUSTOM',
      customAddressLine1: r.custom_address_line1,
      customAddressLine2: r.custom_address_line2,
      customCity: r.custom_city,
      customState: r.custom_state,
      customPostalCode: r.custom_postal_code,
      customCountry: r.custom_country,
      mailingAddressDifferent: r.mailing_address_different,
      mailingLine1: r.mailing_line1,
      mailingLine2: r.mailing_line2,
      mailingCity: r.mailing_city,
      mailingState: r.mailing_state,
      mailingPostalCode: r.mailing_postal_code,
      mailingCountry: r.mailing_country,
      email: r.email,
      inviteCode: r.invite_code,
      inviteEmail: r.invite_email,
      inviteSentAt: r.invite_sent_at,
      linkedAt: r.linked_at,
      createdAt: r.created_at,
    };
  }

  /**
   * Generate an 8-char uppercase alphanumeric code using crypto.randomInt
   * (uniform distribution — NOT crypto.randomBytes + modulo, which biases
   * the alphabet). Token space = 36^8 ≈ 2.8 trillion combos.
   */
  private generateLinkCode(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += alphabet[randomInt(0, alphabet.length)];
    }
    return out;
  }

  private syntheticChildEmail(personId: string): string {
    // Stable per child so re-creation conflicts surface as 409 rather
    // than mutating an unrelated user. Domain is the unroutable .invalid
    // TLD so nothing ever sends mail here by accident.
    const suffix = randomBytes(4).toString('hex');
    return `child-${personId.slice(-6)}-${suffix}@minor.invalid`;
  }

  private syntheticGuardianEmail(personId: string): string {
    // Same .invalid pattern as the child synthetic email, but with a
    // distinct prefix so log greps + DB exports can tell them apart.
    const suffix = randomBytes(4).toString('hex');
    return `guardian-${personId.slice(-6)}-${suffix}@external.invalid`;
  }

  // ─── Member-row helpers ────────────────────────────────────

  /**
   * Raw shape of a platform_family_members row used by the placeholder
   * member mutations. Mirrors the column list — keeps the surface
   * away from Prisma since most of these writes are $executeRawUnsafe
   * and we don't want partial Prisma model exposure leaking into
   * service callers.
   */
  // (declared inside `private`-method block for proximity to use)
  private async requireOwnedMemberRow(
    personId: string,
    memberId: string,
  ): Promise<{
    id: string;
    family_id: string;
    person_id: string | null;
    member_role: string;
    is_primary_contact: boolean;
    status: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    invite_code: string | null;
    invite_sent_at: string | null;
    managed_by_person_id: string | null;
  }> {
    const familyId = await this.findFamilyForPerson(personId);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        family_id: string;
        person_id: string | null;
        member_role: string;
        is_primary_contact: boolean;
        status: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        invite_code: string | null;
        invite_sent_at: string | null;
        managed_by_person_id: string | null;
      }>
    >(
      `SELECT pfm.id::text AS id, pfm.family_id::text AS family_id,
              pfm.person_id::text AS person_id,
              pfm.member_role::text AS member_role, pfm.is_primary_contact,
              pfm.status, pfm.first_name, pfm.last_name, pfm.email,
              pfm.invite_code, pfm.invite_sent_at::text AS invite_sent_at,
              pu.managed_by_person_id::text AS managed_by_person_id
       FROM platform.platform_family_members pfm
       LEFT JOIN platform.platform_users pu ON pu.person_id = pfm.person_id
       WHERE pfm.id = $1::uuid`,
      memberId,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Family member not found');
    // Cross-family isolation: refuse if the row's family doesn't
    // match the caller's. Return 404 (not 403) so we don't leak the
    // existence of another family's member row.
    if (!familyId || row.family_id !== familyId) {
      throw new NotFoundException('Family member not found');
    }
    return row;
  }

  private async requireMemberById(
    memberId: string,
    viewerPersonId?: string,
  ): Promise<FamilyMemberDto> {
    const familyGuardians = viewerPersonId
      ? await this.loadFamilyGuardianPersonIds(viewerPersonId)
      : new Set<string>();
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        person_id: string | null;
        first_name: string | null;
        last_name: string | null;
        preferred_name: string | null;
        email: string | null;
        primary_phone: string | null;
        primary_phone_type: string | null;
        primary_email_type: string | null;
        member_role: string;
        is_primary_contact: boolean;
        emergency_authorized_pickup: boolean;
        emergency_priority_order: number;
        status: string;
        invite_code: string | null;
        invite_sent_at: string | null;
        managed_by_person_id: string | null;
      }>
    >(
      `SELECT pfm.id::text AS id,
              pfm.person_id::text AS person_id,
              COALESCE(p.first_name, pfm.first_name) AS first_name,
              COALESCE(p.last_name, pfm.last_name) AS last_name,
              p.preferred_name AS preferred_name,
              -- Primary contact email lives in platform_person_emails
              -- when the member has a linked iam_person. Falls back
              -- to pfm.email for PLACEHOLDER / PENDING_INVITE rows
              -- (no person_id) and historic rows that haven't had
              -- their first /profile/me/emails lazy-seed yet. The
              -- completion checker treats "has email" as the source
              -- of truth for guardian-profile completeness.
              COALESCE(
                (SELECT pe.email
                   FROM platform.platform_person_emails pe
                  WHERE pe.person_id = pfm.person_id
                  ORDER BY pe.is_primary DESC, pe.created_at ASC
                  LIMIT 1),
                pfm.email
              ) AS email,
              p.primary_phone AS primary_phone,
              (SELECT pp.type
                 FROM platform.platform_person_phones pp
                WHERE pp.person_id = pfm.person_id AND pp.is_primary = true
                LIMIT 1) AS primary_phone_type,
              (SELECT pe.type
                 FROM platform.platform_person_emails pe
                WHERE pe.person_id = pfm.person_id AND pe.is_primary = true
                LIMIT 1) AS primary_email_type,
              pfm.member_role::text AS member_role,
              pfm.is_primary_contact,
              pfm.emergency_authorized_pickup,
              pfm.emergency_priority_order,
              pfm.status,
              pfm.invite_code,
              pfm.invite_sent_at::text AS invite_sent_at,
              pu.managed_by_person_id::text AS managed_by_person_id
       FROM platform.platform_family_members pfm
       LEFT JOIN platform.iam_person p ON p.id = pfm.person_id
       LEFT JOIN platform.platform_users pu ON pu.person_id = pfm.person_id
       WHERE pfm.id = $1::uuid`,
      memberId,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Family member not found');
    return {
      id: row.id,
      personId: row.person_id,
      firstName: row.first_name ?? '',
      lastName: row.last_name ?? '',
      preferredName: row.preferred_name,
      email: row.email,
      primaryPhone: row.primary_phone,
      primaryPhoneType: row.primary_phone_type,
      primaryEmailType: row.primary_email_type,
      memberRole: row.member_role,
      isPrimaryContact: row.is_primary_contact,
      isCurrentUser: row.person_id !== null && row.person_id === viewerPersonId,
      status: row.status as FamilyMemberDto['status'],
      accessLevel: computeAccessLevel(
        row.status === 'ACTIVE' ? 'LINKED' : row.status,
        row.managed_by_person_id,
        familyGuardians,
      ),
      emergencyAuthorizedPickup: row.emergency_authorized_pickup,
      emergencyPriorityOrder: row.emergency_priority_order,
      inviteCode: row.invite_code,
      inviteSentAt: row.invite_sent_at,
    };
  }

  private async assertLinkRateLimit(accountId: string): Promise<void> {
    const key = `family:link-attempts:${accountId}`;
    const count = await this.redis.incrementCounter(key, 1, LINK_ATTEMPTS_WINDOW_SECONDS);
    if (count > LINK_ATTEMPTS_LIMIT) {
      throw new HttpException(
        'Too many link-code attempts; try again in a few minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async refreshPersonaCacheSafe(personId: string): Promise<void> {
    try {
      await this.personaResolution.refreshPersonaCache(personId);
    } catch (e: any) {
      // Cache refresh is best-effort — the next /auth/me read can re-resolve.
      this.logger.warn('[family-children] persona cache refresh failed: ' + (e?.message || e));
    }
  }

  // ─── Child medical / emergency / dietary ───────────────────
  //
  // TODO: sync platform medical/emergency/dietary to tenant tables
  // on enrolment. When sis_students is created for the linked
  // person, a worker reads these three platform tables + seeds
  // hlth_health_records / sis_emergency_contacts / fds_dietary_
  // restrictions and flips the source-of-truth from platform →
  // tenant. Until that worker ships, these endpoints are the only
  // surface and platform_child_* are authoritative.

  /**
   * Refuses every child-section endpoint when the row isn't a
   * LINKED child of the caller's family. requireOwnedRow already
   * enforces cross-family isolation; this helper layers on the
   * LINKED check (no iam_person → no row to attach medical info to).
   * Returns the resolved family_id so callers can stamp it onto the
   * new row without a second query.
   */
  private async requireLinkedChildOwned(
    personId: string,
    childId: string,
  ): Promise<{ familyId: string; personId: string }> {
    const row = await this.requireOwnedRow(personId, childId);
    if (row.status !== 'LINKED' || !row.person_id) {
      throw new BadRequestException(
        'This action requires a linked CampusOS account. Create the account first.',
      );
    }
    return { familyId: row.family_id, personId: row.person_id };
  }

  async getChildMedical(callerPersonId: string, childId: string): Promise<ChildMedicalInfoDto> {
    const { familyId, personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const row = await this.prisma.platformChildMedicalInfo.findUnique({
      where: { personId },
    });
    const family = await this.loadFamilyDoctorInsurance(familyId);
    return this.toMedicalDto(personId, row, family);
  }

  async updateChildMedical(
    callerPersonId: string,
    childId: string,
    dto: UpdateChildMedicalInfoDto,
  ): Promise<ChildMedicalInfoDto> {
    const { familyId, personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const upsertId = generateId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_child_medical_info
         (id, person_id, family_id, allergies, medications, conditions,
          medical_source, doctor_name, doctor_phone, doctor_clinic,
          insurance_provider, insurance_policy, insurance_group,
          blood_type, medical_notes)
       VALUES ($1::uuid, $2::uuid, $3::uuid,
               COALESCE($4::jsonb, '[]'::jsonb),
               COALESCE($5::jsonb, '[]'::jsonb),
               COALESCE($6::jsonb, '[]'::jsonb),
               COALESCE($7, 'FAMILY'),
               $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (person_id) DO UPDATE SET
         allergies = COALESCE(EXCLUDED.allergies, platform_child_medical_info.allergies),
         medications = COALESCE(EXCLUDED.medications, platform_child_medical_info.medications),
         conditions = COALESCE(EXCLUDED.conditions, platform_child_medical_info.conditions),
         medical_source = COALESCE($7, platform_child_medical_info.medical_source),
         doctor_name = COALESCE($8, platform_child_medical_info.doctor_name),
         doctor_phone = COALESCE($9, platform_child_medical_info.doctor_phone),
         doctor_clinic = COALESCE($10, platform_child_medical_info.doctor_clinic),
         insurance_provider = COALESCE($11, platform_child_medical_info.insurance_provider),
         insurance_policy = COALESCE($12, platform_child_medical_info.insurance_policy),
         insurance_group = COALESCE($13, platform_child_medical_info.insurance_group),
         blood_type = COALESCE($14, platform_child_medical_info.blood_type),
         medical_notes = COALESCE($15, platform_child_medical_info.medical_notes),
         updated_at = now()`,
      upsertId,
      personId,
      familyId,
      dto.allergies !== undefined ? JSON.stringify(dto.allergies) : null,
      dto.medications !== undefined ? JSON.stringify(dto.medications) : null,
      dto.conditions !== undefined ? JSON.stringify(dto.conditions) : null,
      dto.medicalSource ?? null,
      dto.doctorName ?? null,
      dto.doctorPhone ?? null,
      dto.doctorClinic ?? null,
      dto.insuranceProvider ?? null,
      dto.insurancePolicy ?? null,
      dto.insuranceGroup ?? null,
      dto.bloodType ?? null,
      dto.medicalNotes ?? null,
    );
    return this.getChildMedical(callerPersonId, childId);
  }

  /**
   * Pulls just the doctor + insurance fields off the platform_families
   * row so the per-child Medical DTO can render the inherited view
   * without a second round-trip from the client.
   */
  private async loadFamilyDoctorInsurance(familyId: string): Promise<{
    doctorName: string | null;
    doctorPhone: string | null;
    doctorClinic: string | null;
    insuranceProvider: string | null;
    insurancePolicy: string | null;
    insuranceGroup: string | null;
  } | null> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        doctor_name: string | null;
        doctor_phone: string | null;
        doctor_clinic: string | null;
        insurance_provider: string | null;
        insurance_policy: string | null;
        insurance_group: string | null;
      }>
    >(
      `SELECT doctor_name, doctor_phone, doctor_clinic,
              insurance_provider, insurance_policy, insurance_group
       FROM platform.platform_families WHERE id = $1::uuid LIMIT 1`,
      familyId,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      doctorName: r.doctor_name,
      doctorPhone: r.doctor_phone,
      doctorClinic: r.doctor_clinic,
      insuranceProvider: r.insurance_provider,
      insurancePolicy: r.insurance_policy,
      insuranceGroup: r.insurance_group,
    };
  }

  private toMedicalDto(
    personId: string,
    row: {
      allergies: unknown;
      medications: unknown;
      conditions: unknown;
      medicalSource: string;
      doctorName: string | null;
      doctorPhone: string | null;
      doctorClinic: string | null;
      insuranceProvider: string | null;
      insurancePolicy: string | null;
      insuranceGroup: string | null;
      bloodType: string | null;
      medicalNotes: string | null;
    } | null,
    family: {
      doctorName: string | null;
      doctorPhone: string | null;
      doctorClinic: string | null;
      insuranceProvider: string | null;
      insurancePolicy: string | null;
      insuranceGroup: string | null;
    } | null,
  ): ChildMedicalInfoDto {
    if (!row) {
      // No per-child row yet — default to FAMILY-mode, with the
      // family-record doctor + insurance surfaced on the wire so the
      // UI can render them straight away.
      return {
        personId,
        allergies: [],
        medications: [],
        conditions: [],
        medicalSource: 'FAMILY',
        doctorName: family?.doctorName ?? null,
        doctorPhone: family?.doctorPhone ?? null,
        doctorClinic: family?.doctorClinic ?? null,
        insuranceProvider: family?.insuranceProvider ?? null,
        insurancePolicy: family?.insurancePolicy ?? null,
        insuranceGroup: family?.insuranceGroup ?? null,
        bloodType: null,
        medicalNotes: null,
      };
    }
    const source = (row.medicalSource === 'CUSTOM' ? 'CUSTOM' : 'FAMILY') as 'FAMILY' | 'CUSTOM';
    const useFamily = source === 'FAMILY' && family !== null;
    return {
      personId,
      allergies: Array.isArray(row.allergies) ? (row.allergies as ChildAllergyEntry[]) : [],
      medications: Array.isArray(row.medications)
        ? (row.medications as ChildMedicationEntry[])
        : [],
      conditions: Array.isArray(row.conditions) ? (row.conditions as ChildConditionEntry[]) : [],
      medicalSource: source,
      doctorName: useFamily ? family!.doctorName : row.doctorName,
      doctorPhone: useFamily ? family!.doctorPhone : row.doctorPhone,
      doctorClinic: useFamily ? family!.doctorClinic : row.doctorClinic,
      insuranceProvider: useFamily ? family!.insuranceProvider : row.insuranceProvider,
      insurancePolicy: useFamily ? family!.insurancePolicy : row.insurancePolicy,
      insuranceGroup: useFamily ? family!.insuranceGroup : row.insuranceGroup,
      bloodType: row.bloodType,
      medicalNotes: row.medicalNotes,
    };
  }

  // ─── Child phones / emails (multi-row contact lists) ──────
  //
  // Mirror /profile/me/phones + /profile/me/emails but key off the
  // child's iam_person.id rather than the caller's. Only LINKED
  // children can carry these rows (no iam_person → nothing to attach
  // to). Authorization matches the existing child-section endpoints:
  // `requireLinkedChildOwned` enforces same-family + LINKED; the
  // frontend further gates the write affordances behind accessLevel
  // === 'MANAGED' for parents of independent kids.

  async listChildPhones(callerPersonId: string, childId: string): Promise<PersonPhoneDto[]> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    let rows = await this.prisma.platformPersonPhone.findMany({
      where: { personId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (rows.length === 0) {
      const ip = await this.prisma.iamPerson.findUnique({
        where: { id: personId },
        select: { primaryPhone: true },
      });
      if (ip?.primaryPhone) {
        try {
          await this.prisma.platformPersonPhone.create({
            data: {
              id: generateId(),
              personId,
              number: ip.primaryPhone,
              type: 'CELL',
              textsAllowed: true,
              isPrimary: true,
            },
          });
        } catch {
          // Race seed — re-read below.
        }
        rows = await this.prisma.platformPersonPhone.findMany({
          where: { personId },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        });
      }
    }
    return rows.map((r) => this.personPhoneRowToDto(r));
  }

  async addChildPhone(
    callerPersonId: string,
    childId: string,
    dto: AddPersonPhoneDto,
  ): Promise<PersonPhoneDto> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const existing = await this.prisma.platformPersonPhone.findMany({
      where: { personId },
      select: { id: true, isPrimary: true },
    });
    const shouldBePrimary = dto.isPrimary === true || existing.length === 0;
    const id = generateId();
    await this.prisma.$transaction(async (tx) => {
      if (shouldBePrimary) {
        await tx.platformPersonPhone.updateMany({
          where: { personId, isPrimary: true },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }
      await tx.platformPersonPhone.create({
        data: {
          id,
          personId,
          number: dto.number,
          type: dto.type ?? 'CELL',
          textsAllowed: dto.textsAllowed ?? false,
          isPrimary: shouldBePrimary,
        },
      });
      if (shouldBePrimary) {
        await tx.iamPerson.update({
          where: { id: personId },
          data: { primaryPhone: dto.number },
        });
      }
    });
    const created = await this.prisma.platformPersonPhone.findUniqueOrThrow({
      where: { id },
    });
    return this.personPhoneRowToDto(created);
  }

  async updateChildPhone(
    callerPersonId: string,
    childId: string,
    phoneId: string,
    dto: UpdatePersonPhoneDto,
  ): Promise<PersonPhoneDto> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const existing = await this.prisma.platformPersonPhone.findUnique({
      where: { id: phoneId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Phone not found');
    }
    const willBePrimary = dto.isPrimary === true && !existing.isPrimary;
    const losesPrimary = dto.isPrimary === false && existing.isPrimary;
    await this.prisma.$transaction(async (tx) => {
      if (willBePrimary) {
        await tx.platformPersonPhone.updateMany({
          where: { personId, isPrimary: true },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }
      const updated = await tx.platformPersonPhone.update({
        where: { id: phoneId },
        data: {
          number: dto.number ?? undefined,
          type: dto.type ?? undefined,
          textsAllowed: dto.textsAllowed ?? undefined,
          isPrimary: dto.isPrimary ?? undefined,
          updatedAt: new Date(),
        },
      });
      if (updated.isPrimary) {
        await tx.iamPerson.update({
          where: { id: personId },
          data: { primaryPhone: updated.number },
        });
      } else if (losesPrimary) {
        const next = await tx.platformPersonPhone.findFirst({
          where: { personId, isPrimary: true },
        });
        const fallback = next
          ? next.number
          : ((
              await tx.platformPersonPhone.findFirst({
                where: { personId },
                orderBy: { createdAt: 'asc' },
              })
            )?.number ?? null);
        await tx.iamPerson.update({
          where: { id: personId },
          data: { primaryPhone: fallback },
        });
      }
    });
    const refreshed = await this.prisma.platformPersonPhone.findUniqueOrThrow({
      where: { id: phoneId },
    });
    return this.personPhoneRowToDto(refreshed);
  }

  async deleteChildPhone(callerPersonId: string, childId: string, phoneId: string): Promise<void> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const existing = await this.prisma.platformPersonPhone.findUnique({
      where: { id: phoneId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Phone not found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.platformPersonPhone.delete({ where: { id: phoneId } });
      if (existing.isPrimary) {
        const next = await tx.platformPersonPhone.findFirst({
          where: { personId },
          orderBy: { createdAt: 'asc' },
        });
        if (next) {
          await tx.platformPersonPhone.update({
            where: { id: next.id },
            data: { isPrimary: true, updatedAt: new Date() },
          });
          await tx.iamPerson.update({
            where: { id: personId },
            data: { primaryPhone: next.number },
          });
        } else {
          await tx.iamPerson.update({
            where: { id: personId },
            data: { primaryPhone: null },
          });
        }
      }
    });
  }

  private personPhoneRowToDto(row: {
    id: string;
    number: string;
    type: string;
    textsAllowed: boolean;
    isPrimary: boolean;
  }): PersonPhoneDto {
    return {
      id: row.id,
      number: row.number,
      type: (row.type === 'HOME' || row.type === 'WORK' || row.type === 'OTHER'
        ? row.type
        : 'CELL') as PersonPhoneType,
      textsAllowed: row.textsAllowed,
      isPrimary: row.isPrimary,
    };
  }

  /**
   * Synthetic login addresses are never real contact emails:
   *   @external.invalid — placeholder guardian (createMemberAccount)
   *   @minor.invalid    — parent-managed minor (syntheticChildEmail)
   * We neither seed them into platform_person_emails nor surface
   * them on the child Contact tab — a young child legitimately has
   * no email, and showing the unroutable placeholder confuses
   * parents + schools.
   */
  private isPlaceholderEmail(email: string | null | undefined): boolean {
    const e = (email ?? '').toLowerCase();
    return e.endsWith('@external.invalid') || e.endsWith('@minor.invalid');
  }

  async listChildEmails(callerPersonId: string, childId: string): Promise<PersonEmailDto[]> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    let rows = await this.prisma.platformPersonEmail.findMany({
      where: { personId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (rows.length === 0) {
      // Seed from platform_users.email (the child's login email if
      // they have an account). Synthetic placeholder logins
      // (@external.invalid / @minor.invalid) are skipped — those
      // shouldn't graduate into a usable contact email.
      const account = await this.prisma.platformUser.findUnique({
        where: { personId },
        select: { email: true },
      });
      const seedEmail = account?.email?.trim();
      if (seedEmail && !this.isPlaceholderEmail(seedEmail)) {
        try {
          await this.prisma.platformPersonEmail.create({
            data: {
              id: generateId(),
              personId,
              email: seedEmail,
              type: 'PERSONAL',
              isPrimary: true,
              verified: true,
            },
          });
        } catch {
          // Race seed — re-read below.
        }
        rows = await this.prisma.platformPersonEmail.findMany({
          where: { personId },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        });
      }
    }
    // Filter placeholder rows that may have been seeded by an earlier
    // build (before @minor.invalid was excluded). They stay in the DB
    // — inert — but never reach the client.
    return rows
      .filter((r) => !this.isPlaceholderEmail(r.email))
      .map((r) => this.personEmailRowToDto(r));
  }

  async addChildEmail(
    callerPersonId: string,
    childId: string,
    dto: AddPersonEmailDto,
  ): Promise<PersonEmailDto> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const normalised = dto.email.trim();
    if (!normalised) throw new BadRequestException('Email is required.');
    const existing = await this.prisma.platformPersonEmail.findMany({
      where: { personId },
      select: { id: true, email: true, isPrimary: true },
    });
    const lower = normalised.toLowerCase();
    if (existing.some((r) => r.email.toLowerCase() === lower)) {
      throw new ConflictException('This email is already on this child’s list.');
    }
    // Count only real emails — a hidden @minor.invalid / @external.invalid
    // placeholder must not block the first real email from becoming
    // primary. shouldBePrimary then demotes any existing primary
    // (including the hidden placeholder) inside the tx, so the real
    // email lands as the single visible primary.
    const realExisting = existing.filter((r) => !this.isPlaceholderEmail(r.email));
    const shouldBePrimary = dto.isPrimary === true || realExisting.length === 0;
    const id = generateId();
    await this.prisma.$transaction(async (tx) => {
      if (shouldBePrimary) {
        await tx.platformPersonEmail.updateMany({
          where: { personId, isPrimary: true },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }
      await tx.platformPersonEmail.create({
        data: {
          id,
          personId,
          email: normalised,
          type: dto.type ?? 'PERSONAL',
          isPrimary: shouldBePrimary,
          verified: false,
        },
      });
    });
    const created = await this.prisma.platformPersonEmail.findUniqueOrThrow({
      where: { id },
    });
    return this.personEmailRowToDto(created);
  }

  async updateChildEmail(
    callerPersonId: string,
    childId: string,
    emailId: string,
    dto: UpdatePersonEmailDto,
  ): Promise<PersonEmailDto> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const existing = await this.prisma.platformPersonEmail.findUnique({
      where: { id: emailId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Email not found');
    }
    const willBePrimary = dto.isPrimary === true && !existing.isPrimary;
    const losesPrimary = dto.isPrimary === false && existing.isPrimary;
    await this.prisma.$transaction(async (tx) => {
      if (willBePrimary) {
        await tx.platformPersonEmail.updateMany({
          where: { personId, isPrimary: true },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }
      await tx.platformPersonEmail.update({
        where: { id: emailId },
        data: {
          type: dto.type ?? undefined,
          isPrimary: dto.isPrimary ?? undefined,
          updatedAt: new Date(),
        },
      });
      if (losesPrimary) {
        const fallback = await tx.platformPersonEmail.findFirst({
          where: { personId, NOT: { id: emailId } },
          orderBy: { createdAt: 'asc' },
        });
        if (fallback) {
          await tx.platformPersonEmail.update({
            where: { id: fallback.id },
            data: { isPrimary: true, updatedAt: new Date() },
          });
        }
      }
    });
    const refreshed = await this.prisma.platformPersonEmail.findUniqueOrThrow({
      where: { id: emailId },
    });
    return this.personEmailRowToDto(refreshed);
  }

  async deleteChildEmail(callerPersonId: string, childId: string, emailId: string): Promise<void> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const existing = await this.prisma.platformPersonEmail.findUnique({
      where: { id: emailId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Email not found');
    }
    const total = await this.prisma.platformPersonEmail.count({ where: { personId } });
    if (total <= 1) {
      throw new BadRequestException(
        'A child must have at least one email on file. Add another email before removing this one.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.platformPersonEmail.delete({ where: { id: emailId } });
      if (existing.isPrimary) {
        const next = await tx.platformPersonEmail.findFirst({
          where: { personId },
          orderBy: { createdAt: 'asc' },
        });
        if (next) {
          await tx.platformPersonEmail.update({
            where: { id: next.id },
            data: { isPrimary: true, updatedAt: new Date() },
          });
        }
      }
    });
  }

  private personEmailRowToDto(row: {
    id: string;
    email: string;
    type: string;
    isPrimary: boolean;
    verified: boolean;
  }): PersonEmailDto {
    return {
      id: row.id,
      email: row.email,
      type: (row.type === 'WORK' || row.type === 'SCHOOL' || row.type === 'OTHER'
        ? row.type
        : 'PERSONAL') as PersonEmailType,
      isPrimary: row.isPrimary,
      verified: row.verified,
    };
  }

  // ─── Emergency contacts ────────────────────────────────────

  async listChildEmergencyContacts(
    callerPersonId: string,
    childId: string,
  ): Promise<ChildEmergencyContactDto[]> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const rows = await this.prisma.platformChildEmergencyContact.findMany({
      where: { personId },
      orderBy: [{ priorityOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(this.toEmergencyDto);
  }

  async addChildEmergencyContact(
    callerPersonId: string,
    childId: string,
    dto: AddChildEmergencyContactDto,
  ): Promise<ChildEmergencyContactDto> {
    const { familyId, personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const id = generateId();
    try {
      await this.prisma.platformChildEmergencyContact.create({
        data: {
          id,
          personId,
          familyId,
          name: dto.name.trim(),
          relationship: dto.relationship.trim(),
          phonePrimary: dto.phonePrimary.trim(),
          phoneAlternate: dto.phoneAlternate?.trim() || null,
          email: dto.email?.trim() || null,
          authorizedPickup: dto.authorizedPickup ?? false,
          priorityOrder: dto.priorityOrder ?? 0,
        },
      });
    } catch (e: any) {
      // UNIQUE (person_id, phone_primary)
      if (e?.meta?.code === '23505' || /unique constraint/i.test(String(e))) {
        throw new ConflictException(
          'A contact with that primary phone number already exists for this child.',
        );
      }
      throw e;
    }
    const row = await this.prisma.platformChildEmergencyContact.findUnique({ where: { id } });
    return this.toEmergencyDto(row!);
  }

  async updateChildEmergencyContact(
    callerPersonId: string,
    childId: string,
    contactId: string,
    dto: UpdateChildEmergencyContactDto,
  ): Promise<ChildEmergencyContactDto> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const existing = await this.prisma.platformChildEmergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Emergency contact not found');
    }
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.relationship !== undefined) patch.relationship = dto.relationship.trim();
    if (dto.phonePrimary !== undefined) patch.phonePrimary = dto.phonePrimary.trim();
    if (dto.phoneAlternate !== undefined)
      patch.phoneAlternate = dto.phoneAlternate ? dto.phoneAlternate.trim() : null;
    if (dto.email !== undefined) patch.email = dto.email ? dto.email.trim() : null;
    if (dto.authorizedPickup !== undefined) patch.authorizedPickup = dto.authorizedPickup;
    if (dto.priorityOrder !== undefined) patch.priorityOrder = dto.priorityOrder;
    if (Object.keys(patch).length === 0) return this.toEmergencyDto(existing);
    patch.updatedAt = new Date();
    const updated = await this.prisma.platformChildEmergencyContact.update({
      where: { id: contactId },
      data: patch,
    });
    return this.toEmergencyDto(updated);
  }

  async removeChildEmergencyContact(
    callerPersonId: string,
    childId: string,
    contactId: string,
  ): Promise<void> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const existing = await this.prisma.platformChildEmergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Emergency contact not found');
    }
    await this.prisma.platformChildEmergencyContact.delete({ where: { id: contactId } });
  }

  private toEmergencyDto(row: {
    id: string;
    name: string;
    relationship: string;
    phonePrimary: string;
    phoneAlternate: string | null;
    email: string | null;
    authorizedPickup: boolean;
    priorityOrder: number;
  }): ChildEmergencyContactDto {
    return {
      id: row.id,
      name: row.name,
      relationship: row.relationship,
      phonePrimary: row.phonePrimary,
      phoneAlternate: row.phoneAlternate,
      email: row.email,
      authorizedPickup: row.authorizedPickup,
      priorityOrder: row.priorityOrder,
    };
  }

  // ─── Dietary ───────────────────────────────────────────────

  async getChildDietary(callerPersonId: string, childId: string): Promise<ChildDietaryInfoDto> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const row = await this.prisma.platformChildDietaryInfo.findUnique({ where: { personId } });
    return this.toDietaryDto(personId, row);
  }

  async updateChildDietary(
    callerPersonId: string,
    childId: string,
    dto: UpdateChildDietaryInfoDto,
  ): Promise<ChildDietaryInfoDto> {
    const { familyId, personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const upsertId = generateId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_child_dietary_info
         (id, person_id, family_id, dietary_type, food_allergies,
          additional_restrictions, meal_preference)
       VALUES ($1::uuid, $2::uuid, $3::uuid,
               COALESCE($4, 'NONE'),
               COALESCE($5::jsonb, '[]'::jsonb),
               $6, $7)
       ON CONFLICT (person_id) DO UPDATE SET
         dietary_type = COALESCE($4, platform_child_dietary_info.dietary_type),
         food_allergies = COALESCE(EXCLUDED.food_allergies, platform_child_dietary_info.food_allergies),
         additional_restrictions = COALESCE($6, platform_child_dietary_info.additional_restrictions),
         meal_preference = COALESCE($7, platform_child_dietary_info.meal_preference),
         updated_at = now()`,
      upsertId,
      personId,
      familyId,
      dto.dietaryType ?? null,
      dto.foodAllergies !== undefined ? JSON.stringify(dto.foodAllergies) : null,
      dto.additionalRestrictions ?? null,
      dto.mealPreference ?? null,
    );
    return this.getChildDietary(callerPersonId, childId);
  }

  private toDietaryDto(
    personId: string,
    row: {
      dietaryType: string;
      foodAllergies: unknown;
      additionalRestrictions: string | null;
      mealPreference: string | null;
    } | null,
  ): ChildDietaryInfoDto {
    if (!row) {
      return {
        personId,
        dietaryType: 'NONE',
        foodAllergies: [],
        additionalRestrictions: null,
        mealPreference: null,
      };
    }
    return {
      personId,
      dietaryType: row.dietaryType as ChildDietaryInfoDto['dietaryType'],
      foodAllergies: Array.isArray(row.foodAllergies)
        ? (row.foodAllergies as ChildFoodAllergyEntry[])
        : [],
      additionalRestrictions: row.additionalRestrictions,
      mealPreference: row.mealPreference,
    };
  }
}

function ageInYears(dateOfBirth: string): number {
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return 0;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
