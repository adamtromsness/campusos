import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  CreateRecruitingInterestDto,
  CreateRecruitingProfileDto,
  RecruitingInterestLevel,
  RecruitingInterestResponseDto,
  RecruitingProfileResponseDto,
  UpdateRecruitingInterestDto,
  UpdateRecruitingProfileDto,
} from './dto/athletics-advanced.dto';

interface ProfileRow {
  id: string;
  student_id: string;
  student_name: string | null;
  sport: string;
  graduation_year: number;
  position: string | null;
  height_inches: number | null;
  weight_lbs: number | null;
  gpa: string | null;
  gpa_snapshot_at: string | null;
  highlight_reel_s3_key: string | null;
  is_published: boolean;
  published_at: string | null;
  coach_recommendation: string | null;
  achievements: string | null;
  contact_email: string | null;
  interest_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT_PROFILE =
  'SELECT rp.id::text AS id, rp.student_id::text AS student_id, ' +
  "(p.first_name || ' ' || p.last_name) AS student_name, " +
  'rp.sport, rp.graduation_year, rp.position, rp.height_inches, rp.weight_lbs, ' +
  'rp.gpa::text AS gpa, ' +
  'TO_CHAR(rp.gpa_snapshot_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS gpa_snapshot_at, ' +
  'rp.highlight_reel_s3_key, rp.is_published, ' +
  'TO_CHAR(rp.published_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS published_at, ' +
  'rp.coach_recommendation, rp.achievements, rp.contact_email, ' +
  '(SELECT COUNT(*)::int FROM ath_recruiting_interests ri WHERE ri.recruiting_profile_id = rp.id) AS interest_count, ' +
  'TO_CHAR(rp.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(rp.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_recruiting_profiles rp ' +
  'LEFT JOIN sis_students s ON s.id = rp.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = ps.person_id ';

interface InterestRow {
  id: string;
  recruiting_profile_id: string;
  college_name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  interest_level: string;
  last_contact_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_INTEREST =
  'SELECT id::text AS id, recruiting_profile_id::text AS recruiting_profile_id, ' +
  'college_name, contact_name, contact_email, contact_phone, interest_level, ' +
  "TO_CHAR(last_contact_date, 'YYYY-MM-DD') AS last_contact_date, notes, " +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_recruiting_interests ';

function rowToProfileDto(r: ProfileRow): RecruitingProfileResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    sport: r.sport,
    graduationYear: r.graduation_year,
    position: r.position,
    heightInches: r.height_inches,
    weightLbs: r.weight_lbs,
    gpa: r.gpa === null ? null : Number(r.gpa),
    gpaSnapshotAt: r.gpa_snapshot_at,
    highlightReelS3Key: r.highlight_reel_s3_key,
    isPublished: r.is_published,
    publishedAt: r.published_at,
    coachRecommendation: r.coach_recommendation,
    achievements: r.achievements,
    contactEmail: r.contact_email,
    interestCount: r.interest_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToInterestDto(r: InterestRow): RecruitingInterestResponseDto {
  return {
    id: r.id,
    recruitingProfileId: r.recruiting_profile_id,
    collegeName: r.college_name,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    contactPhone: r.contact_phone,
    interestLevel: r.interest_level as RecruitingInterestLevel,
    lastContactDate: r.last_contact_date,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class RecruitingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Coach scope — admin OR holds ath-001:write (Team Management).
   * Coaches can edit a recruiting profile to add the recommendation
   * letter on behalf of a student.
   */
  async hasCoachScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ath-001:write',
    ]);
  }

  /**
   * Resolve whether the calling actor IS the student that the profile belongs to.
   * Recruiting profiles are STUDENT-OWNED — only the student themself can edit
   * their own profile (admins and coaches override per the policy above).
   */
  private async isStudentSelf(
    client: { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> },
    actor: ResolvedActor,
    studentId: string,
  ): Promise<boolean> {
    if (actor.personType !== 'STUDENT' || !actor.personId) return false;
    const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT s.id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE s.id = $1::uuid AND ps.person_id = $2::uuid',
      studentId,
      actor.personId,
    );
    return rows.length > 0;
  }

  /**
   * Resolve whether the calling actor is a parent linked to the student
   * (via sis_student_guardians). Parents have READ-ONLY access to their
   * own child's profile through the standard row-scope check; they cannot
   * edit or publish it.
   */
  private async isLinkedGuardian(
    client: { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> },
    actor: ResolvedActor,
    studentId: string,
  ): Promise<boolean> {
    if (actor.personType !== 'GUARDIAN' || !actor.personId) return false;
    const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT sg.id FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid',
      studentId,
      actor.personId,
    );
    return rows.length > 0;
  }

  // ── Profile reads ───────────────────────────────────────────────

  async listProfiles(
    filters: { graduationYear?: number; sport?: string; isPublished?: boolean },
    actor: ResolvedActor,
  ): Promise<RecruitingProfileResponseDto[]> {
    // Visibility — admin/coach see all profiles in this school. Students
    // see their own. Guardians see their linked children's. Everyone
    // else (other students, unrelated parents) sees nothing.
    const tenant = getCurrentTenant();
    const isAdmin = await this.hasCoachScope(actor);
    const sql: string[] = [
      SELECT_PROFILE,
      'WHERE EXISTS (SELECT 1 FROM sis_students sx WHERE sx.id = rp.student_id AND sx.school_id = $1::uuid) ',
    ];
    const params: unknown[] = [tenant.schoolId];
    if (!isAdmin) {
      if (actor.personType === 'STUDENT' && actor.personId) {
        params.push(actor.personId);
        sql.push(
          'AND EXISTS (SELECT 1 FROM sis_students sx2 JOIN platform.platform_students psx ON psx.id = sx2.platform_student_id WHERE sx2.id = rp.student_id AND psx.person_id = $' +
            params.length +
            '::uuid) ',
        );
      } else if (actor.personType === 'GUARDIAN' && actor.personId) {
        params.push(actor.personId);
        sql.push(
          'AND EXISTS (SELECT 1 FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id WHERE sg.student_id = rp.student_id AND g.person_id = $' +
            params.length +
            '::uuid) ',
        );
      } else {
        // Teachers/staff without ath-001:write — published profiles only
        sql.push('AND rp.is_published = true ');
      }
    }
    if (filters.graduationYear !== undefined) {
      params.push(filters.graduationYear);
      sql.push('AND rp.graduation_year = $' + params.length + ' ');
    }
    if (filters.sport) {
      params.push(filters.sport);
      sql.push('AND rp.sport = $' + params.length + ' ');
    }
    if (filters.isPublished !== undefined) {
      params.push(filters.isPublished);
      sql.push('AND rp.is_published = $' + params.length + ' ');
    }
    sql.push('ORDER BY rp.updated_at DESC LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<ProfileRow[]>(sql.join(''), ...params),
    );
    return (rows as ProfileRow[]).map(rowToProfileDto);
  }

  async getProfileById(id: string, actor: ResolvedActor): Promise<RecruitingProfileResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<ProfileRow[]>(
        SELECT_PROFILE +
          'WHERE rp.id = $1::uuid AND EXISTS (SELECT 1 FROM sis_students sx WHERE sx.id = rp.student_id AND sx.school_id = $2::uuid)',
        id,
        tenant.schoolId,
      ),
    );
    if ((rows as ProfileRow[]).length === 0) {
      throw new NotFoundException('Recruiting profile not found');
    }
    const r = (rows as ProfileRow[])[0]!;
    // Authorisation gate — admin/coach all; student-self always; guardian linked-only;
    // other authenticated users only when is_published=true.
    const isAdmin = await this.hasCoachScope(actor);
    if (!isAdmin) {
      const checked = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const c = client as {
          $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        };
        if (await this.isStudentSelf(c, actor, r.student_id)) return true;
        if (await this.isLinkedGuardian(c, actor, r.student_id)) return true;
        return r.is_published;
      });
      if (!checked) {
        throw new NotFoundException('Recruiting profile not found');
      }
    }
    return rowToProfileDto(r);
  }

  async getProfileByStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<RecruitingProfileResponseDto | null> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<ProfileRow[]>(
        SELECT_PROFILE +
          'WHERE rp.student_id = $1::uuid AND EXISTS (SELECT 1 FROM sis_students sx WHERE sx.id = $1::uuid AND sx.school_id = $2::uuid)',
        studentId,
        tenant.schoolId,
      ),
    );
    if ((rows as ProfileRow[]).length === 0) return null;
    const r = (rows as ProfileRow[])[0]!;
    const isAdmin = await this.hasCoachScope(actor);
    if (!isAdmin) {
      const checked = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const c = client as {
          $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        };
        if (await this.isStudentSelf(c, actor, r.student_id)) return true;
        if (await this.isLinkedGuardian(c, actor, r.student_id)) return true;
        return r.is_published;
      });
      if (!checked) return null;
    }
    return rowToProfileDto(r);
  }

  // ── Profile writes (STUDENT-OWNED) ──────────────────────────────

  async createProfile(
    input: CreateRecruitingProfileDto,
    actor: ResolvedActor,
  ): Promise<RecruitingProfileResponseDto> {
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const c = client as {
        $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      // Verify student is in this school
      const student = await c.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid',
        input.studentId,
        tenant.schoolId,
      );
      if (student.length === 0) {
        throw new BadRequestException('studentId does not match a student in this school');
      }
      // Authorisation — student-self OR coach/admin
      const isSelf = await this.isStudentSelf(c, actor, input.studentId);
      const isCoach = await this.hasCoachScope(actor);
      if (!isSelf && !isCoach) {
        throw new ForbiddenException(
          'Recruiting profiles are student-owned — only the student or a coach can create one',
        );
      }
      try {
        await c.$executeRawUnsafe(
          'INSERT INTO ath_recruiting_profiles (id, student_id, sport, graduation_year, position, height_inches, weight_lbs, highlight_reel_s3_key, achievements, contact_email) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)',
          id,
          input.studentId,
          input.sport,
          input.graduationYear,
          input.position ?? null,
          input.heightInches ?? null,
          input.weightLbs ?? null,
          input.highlightReelS3Key ?? null,
          input.achievements ?? null,
          input.contactEmail ?? null,
        );
      } catch (err) {
        const e = err as { code?: string; meta?: { code?: string } };
        if (e.code === '23505' || e.meta?.code === '23505') {
          throw new BadRequestException('Student already has a recruiting profile');
        }
        throw err;
      }
    });
    return this.getProfileById(id, actor);
  }

  async updateProfile(
    id: string,
    input: UpdateRecruitingProfileDto,
    actor: ResolvedActor,
  ): Promise<RecruitingProfileResponseDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const t = tx as {
        $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      const tenant = getCurrentTenant();
      const lock = await t.$queryRawUnsafe<
        Array<{ id: string; student_id: string; is_published: boolean; school_id: string }>
      >(
        'SELECT rp.id::text AS id, rp.student_id::text AS student_id, rp.is_published, sx.school_id::text AS school_id ' +
          'FROM ath_recruiting_profiles rp JOIN sis_students sx ON sx.id = rp.student_id ' +
          'WHERE rp.id = $1::uuid FOR UPDATE OF rp',
        id,
      );
      if (lock.length === 0) throw new NotFoundException('Recruiting profile not found');
      if (lock[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Recruiting profile not found');
      }
      // Authorisation — student-self OR coach/admin. The coachRecommendation
      // field is intentionally writable only by coach/admin (the student
      // cannot author their own recommendation letter).
      const isSelf = await this.isStudentSelf(t, actor, lock[0]!.student_id);
      const isCoach = await this.hasCoachScope(actor);
      if (!isSelf && !isCoach) {
        throw new ForbiddenException(
          'Only the owning student or a coach can edit this recruiting profile',
        );
      }
      if (input.coachRecommendation !== undefined && !isCoach) {
        throw new ForbiddenException('Only a coach or admin can write the coach recommendation');
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.sport !== undefined) {
        params.push(input.sport);
        sets.push('sport = $' + params.length);
      }
      if (input.graduationYear !== undefined) {
        params.push(input.graduationYear);
        sets.push('graduation_year = $' + params.length);
      }
      if (input.position !== undefined) {
        params.push(input.position);
        sets.push('position = $' + params.length);
      }
      if (input.heightInches !== undefined) {
        params.push(input.heightInches);
        sets.push('height_inches = $' + params.length);
      }
      if (input.weightLbs !== undefined) {
        params.push(input.weightLbs);
        sets.push('weight_lbs = $' + params.length);
      }
      if (input.highlightReelS3Key !== undefined) {
        params.push(input.highlightReelS3Key);
        sets.push('highlight_reel_s3_key = $' + params.length);
      }
      if (input.coachRecommendation !== undefined) {
        params.push(input.coachRecommendation);
        sets.push('coach_recommendation = $' + params.length);
      }
      if (input.achievements !== undefined) {
        params.push(input.achievements);
        sets.push('achievements = $' + params.length);
      }
      if (input.contactEmail !== undefined) {
        params.push(input.contactEmail);
        sets.push('contact_email = $' + params.length);
      }
      if (input.isPublished !== undefined) {
        params.push(input.isPublished);
        sets.push('is_published = $' + params.length);
        if (input.isPublished) {
          sets.push('published_at = now()');
          // Wave 7 FIX: the rpt_student_academic_summary column is
          // `current_gpa` (Cycle 29 read model), not `gpa`. The original
          // implementation queried `gpa` and silently swallowed the
          // 42703 in production — but inside a tx the failure aborts
          // the whole publish. Resolve via the correct column name.
          const gpaRow = await t.$queryRawUnsafe<Array<{ gpa: string | null }>>(
            'SELECT current_gpa::text AS gpa FROM rpt_student_academic_summary WHERE student_id = $1::uuid LIMIT 1',
            lock[0]!.student_id,
          );
          if (gpaRow.length > 0 && gpaRow[0]!.gpa !== null) {
            params.push(gpaRow[0]!.gpa);
            // Cast TEXT → NUMERIC explicitly. Prisma raw param binding
            // sends the value as TEXT; without the cast Postgres raises
            // 42804 (column "gpa" is of type numeric but expression
            // is of type text).
            sets.push('gpa = $' + params.length + '::numeric');
            sets.push('gpa_snapshot_at = now()');
          }
        } else {
          sets.push('published_at = NULL');
        }
      }
      if (sets.length === 0) {
        const noop = await t.$queryRawUnsafe<ProfileRow[]>(
          SELECT_PROFILE + 'WHERE rp.id = $1::uuid',
          id,
        );
        return rowToProfileDto((noop as ProfileRow[])[0]!);
      }
      sets.push('updated_at = now()');
      params.push(id);
      await t.$executeRawUnsafe(
        'UPDATE ath_recruiting_profiles SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      const final = await t.$queryRawUnsafe<ProfileRow[]>(
        SELECT_PROFILE + 'WHERE rp.id = $1::uuid',
        id,
      );
      return rowToProfileDto((final as ProfileRow[])[0]!);
    });
  }

  // ── Recruiting interests ────────────────────────────────────────

  async listInterestsForProfile(
    profileId: string,
    actor: ResolvedActor,
  ): Promise<RecruitingInterestResponseDto[]> {
    // Profile authorisation gate first
    await this.getProfileById(profileId, actor);
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<InterestRow[]>(
        SELECT_INTEREST +
          'WHERE recruiting_profile_id = $1::uuid ORDER BY interest_level, college_name LIMIT 200',
        profileId,
      ),
    );
    return (rows as InterestRow[]).map(rowToInterestDto);
  }

  async createInterest(
    profileId: string,
    input: CreateRecruitingInterestDto,
    actor: ResolvedActor,
  ): Promise<RecruitingInterestResponseDto> {
    // Authorisation — student-self OR coach/admin only
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const t = tx as {
        $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      const tenant = getCurrentTenant();
      const profile = await t.$queryRawUnsafe<
        Array<{ id: string; student_id: string; school_id: string }>
      >(
        'SELECT rp.id::text AS id, rp.student_id::text AS student_id, sx.school_id::text AS school_id ' +
          'FROM ath_recruiting_profiles rp JOIN sis_students sx ON sx.id = rp.student_id ' +
          'WHERE rp.id = $1::uuid',
        profileId,
      );
      if (profile.length === 0) throw new NotFoundException('Recruiting profile not found');
      if (profile[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Recruiting profile not found');
      }
      const isSelf = await this.isStudentSelf(t, actor, profile[0]!.student_id);
      const isCoach = await this.hasCoachScope(actor);
      if (!isSelf && !isCoach) {
        throw new ForbiddenException(
          'Only the owning student or a coach can add a college interest',
        );
      }
      const id = generateId();
      await t.$executeRawUnsafe(
        'INSERT INTO ath_recruiting_interests (id, recruiting_profile_id, college_name, contact_name, contact_email, contact_phone, interest_level, last_contact_date, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::date, $9)',
        id,
        profileId,
        input.collegeName,
        input.contactName ?? null,
        input.contactEmail ?? null,
        input.contactPhone ?? null,
        input.interestLevel ?? 'EXPLORING',
        input.lastContactDate ?? null,
        input.notes ?? null,
      );
      const rows = await t.$queryRawUnsafe<InterestRow[]>(
        SELECT_INTEREST + 'WHERE id = $1::uuid',
        id,
      );
      return rowToInterestDto((rows as InterestRow[])[0]!);
    });
  }

  async updateInterest(
    id: string,
    input: UpdateRecruitingInterestDto,
    actor: ResolvedActor,
  ): Promise<RecruitingInterestResponseDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const t = tx as {
        $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      const tenant = getCurrentTenant();
      const lock = await t.$queryRawUnsafe<
        Array<{ id: string; student_id: string; school_id: string }>
      >(
        'SELECT ri.id::text AS id, rp.student_id::text AS student_id, sx.school_id::text AS school_id ' +
          'FROM ath_recruiting_interests ri JOIN ath_recruiting_profiles rp ON rp.id = ri.recruiting_profile_id JOIN sis_students sx ON sx.id = rp.student_id ' +
          'WHERE ri.id = $1::uuid FOR UPDATE OF ri',
        id,
      );
      if (lock.length === 0) throw new NotFoundException('Recruiting interest not found');
      if (lock[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Recruiting interest not found');
      }
      const isSelf = await this.isStudentSelf(t, actor, lock[0]!.student_id);
      const isCoach = await this.hasCoachScope(actor);
      if (!isSelf && !isCoach) {
        throw new ForbiddenException(
          'Only the owning student or a coach can edit a college interest',
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.collegeName !== undefined) {
        params.push(input.collegeName);
        sets.push('college_name = $' + params.length);
      }
      if (input.contactName !== undefined) {
        params.push(input.contactName);
        sets.push('contact_name = $' + params.length);
      }
      if (input.contactEmail !== undefined) {
        params.push(input.contactEmail);
        sets.push('contact_email = $' + params.length);
      }
      if (input.contactPhone !== undefined) {
        params.push(input.contactPhone);
        sets.push('contact_phone = $' + params.length);
      }
      if (input.interestLevel !== undefined) {
        params.push(input.interestLevel);
        sets.push('interest_level = $' + params.length);
      }
      if (input.lastContactDate !== undefined) {
        params.push(input.lastContactDate);
        sets.push('last_contact_date = $' + params.length + '::date');
      }
      if (input.notes !== undefined) {
        params.push(input.notes);
        sets.push('notes = $' + params.length);
      }
      if (sets.length === 0) {
        const rows = await t.$queryRawUnsafe<InterestRow[]>(
          SELECT_INTEREST + 'WHERE id = $1::uuid',
          id,
        );
        return rowToInterestDto((rows as InterestRow[])[0]!);
      }
      sets.push('updated_at = now()');
      params.push(id);
      await t.$executeRawUnsafe(
        'UPDATE ath_recruiting_interests SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      const rows = await t.$queryRawUnsafe<InterestRow[]>(
        SELECT_INTEREST + 'WHERE id = $1::uuid',
        id,
      );
      return rowToInterestDto((rows as InterestRow[])[0]!);
    });
  }
}
