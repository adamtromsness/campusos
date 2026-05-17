import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import { OutboxService } from '@shared/kafka';
import type { ResolvedActor } from '@modules/m00-platform';
import type {
  AvatarStatus,
  ReviewAvatarDto,
  StudentProfileDto,
  UpdateStudentProfileDto,
  UploadAvatarDto,
} from './dto/sis-advanced.dto';
import { deterministicAvatarReviewedEventId } from './event-ids-advanced';

interface ProfileRow {
  id: string;
  student_id: string;
  bio: string | null;
  currently_reading: string | null;
  favourite_song: string | null;
  interests: string[];
  motto: string | null;
  avatar_s3_key: string | null;
  avatar_status: string;
  avatar_reviewed_by: string | null;
  avatar_reviewed_at: string | null;
  avatar_review_notes: string | null;
  created_at: string;
  updated_at: string;
}

const PROFILE_SELECT_COLS =
  'p.id::text, p.student_id::text, p.bio, p.currently_reading, p.favourite_song, ' +
  'p.interests, p.motto, p.avatar_s3_key, p.avatar_status, p.avatar_reviewed_by::text, ' +
  'p.avatar_reviewed_at::text, p.avatar_review_notes, p.created_at::text, p.updated_at::text';

/**
 * Student profile service.
 *
 * REVIEW-P2C13 ROUND 1 BLOCKING 1 + 2 (this commit) — every direct
 * object reference is now school-scoped through a join to
 * sis_students.school_id = tenant.schoolId.
 *
 *   1. resolveOwnStudentId joins sis_students + platform_students with a
 *      sis_students.school_id predicate — a student linked across schools
 *      cannot resolve into another school's row by walking
 *      platform_students.person_id alone.
 *   2. assertStudentExists requires the student to live in the calling
 *      tenant's school.
 *   3. assertCanReadProfile no longer blanket-bypasses STAFF — STAFF must
 *      hold stu-002:write or be an assigned class teacher of the student
 *      (mirrors the row-scope shape used by Cycle 11.1 wellbeing /
 *      Cycle 12 reading logs / Cycle 17 service hours). GUARDIAN check
 *      joins through sis_students.school_id so a parent in school A
 *      cannot read a child's profile in school B by UUID.
 *   4. reviewAvatar locks + updates + reloads through a sis_students
 *      JOIN — a foreign-school reviewer cannot approve a foreign-school
 *      avatar by guessing the profile UUID.
 *   5. listPendingAvatars carries a sis_students.school_id predicate
 *      so the queue is per-school.
 *   6. sis.avatar.reviewed is now durable via OutboxService.enqueueInTx
 *      inside the same tx as the status flip — Kafka outage cannot drop
 *      the downstream notification.
 */
@Injectable()
export class StudentProfileService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private rowToDto(r: ProfileRow): StudentProfileDto {
    return {
      id: r.id,
      studentId: r.student_id,
      bio: r.bio,
      currentlyReading: r.currently_reading,
      favouriteSong: r.favourite_song,
      interests: r.interests ?? [],
      motto: r.motto,
      avatarS3Key: r.avatar_s3_key,
      avatarStatus: r.avatar_status as AvatarStatus,
      avatarReviewedBy: r.avatar_reviewed_by,
      avatarReviewedAt: r.avatar_reviewed_at,
      avatarReviewNotes: r.avatar_review_notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Resolve the calling actor's own sis_students.id in the CURRENT
   * tenant only. REVIEW-P2C13 BLOCKING 1 — predicate joins through
   * sis_students.school_id = tenant.schoolId so a student with the
   * same platform identity linked to a sister school cannot
   * resolve into another school's student row.
   */
  private async resolveOwnStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE s.school_id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
        tenant.schoolId,
        actor.personId,
      );
      return rows[0]?.id ?? null;
    });
  }

  private async assertStudentExists(studentId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Student ' + studentId + ' not found');
  }

  /**
   * REVIEW-P2C13 BLOCKING 1 — generic STAFF no longer bypasses row
   * scope. STAFF must either be an assigned class teacher of the
   * student (mirrors Cycle 11 / 12 row-scope shape) OR hold
   * stu-002:write at write tier.
   */
  private async isAssignedTeacher(actor: ResolvedActor, studentId: string): Promise<boolean> {
    if (actor.personType !== 'STAFF' || !actor.employeeId) return false;
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers ct ' +
          'JOIN sis_enrollments en ON en.class_id = ct.class_id ' +
          'JOIN sis_classes c ON c.id = ct.class_id ' +
          'WHERE ct.teacher_employee_id = $1::uuid AND en.student_id = $2::uuid ' +
          "AND en.status = 'ACTIVE' AND c.school_id = $3::uuid LIMIT 1",
        actor.employeeId,
        studentId,
        tenant.schoolId,
      ),
    );
    return rows.length > 0;
  }

  private async assertCanReadProfile(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const ownId = await this.resolveOwnStudentId(actor);
    if (ownId === studentId) return;
    if (actor.personType === 'STAFF') {
      // Staff write-tier (homeroom / counselling) OR assigned teacher.
      if (await this.isReviewer(actor)) return;
      if (await this.isAssignedTeacher(actor, studentId)) return;
      throw new NotFoundException('Profile not found');
    }
    if (actor.personType === 'GUARDIAN') {
      const tenant = getCurrentTenant();
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'JOIN sis_students s ON s.id = sg.student_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid ' +
            'AND s.school_id = $3::uuid LIMIT 1',
          studentId,
          actor.personId,
          tenant.schoolId,
        ),
      );
      if (rows.length > 0) return;
    }
    throw new NotFoundException('Profile not found');
  }

  private async assertOwnStudentOrAdmin(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const ownId = await this.resolveOwnStudentId(actor);
    if (ownId !== studentId) {
      throw new ForbiddenException('Only the student themself or an admin can edit this profile.');
    }
  }

  private async isReviewer(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-002:write',
      'stu-002:admin',
    ]);
  }

  /**
   * Look up the profile by student_id. Creates an empty profile row on
   * first read so the front-end always has something to render. Student
   * existence + read-scope checks both carry the current-school predicate.
   */
  async getOrCreateProfile(studentId: string, actor: ResolvedActor): Promise<StudentProfileDto> {
    await this.assertStudentExists(studentId);
    await this.assertCanReadProfile(studentId, actor);

    const rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = await tx.$queryRawUnsafe<ProfileRow[]>(
        'SELECT ' +
          PROFILE_SELECT_COLS +
          ' ' +
          'FROM sis_student_profiles p WHERE p.student_id = $1::uuid',
        studentId,
      );
      if (existing.length > 0) return existing;

      const id = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO sis_student_profiles (id, student_id) VALUES ($1::uuid, $2::uuid)',
        id,
        studentId,
      );
      return tx.$queryRawUnsafe<ProfileRow[]>(
        'SELECT ' + PROFILE_SELECT_COLS + ' FROM sis_student_profiles p WHERE p.id = $1::uuid',
        id,
      );
    });
    return this.rowToDto(rows[0]!);
  }

  async updateProfile(
    studentId: string,
    dto: UpdateStudentProfileDto,
    actor: ResolvedActor,
  ): Promise<StudentProfileDto> {
    await this.assertStudentExists(studentId);
    await this.assertOwnStudentOrAdmin(studentId, actor);

    if (dto.bio !== undefined && dto.bio !== null && dto.bio.length > 500) {
      throw new BadRequestException('Bio exceeds 500 character limit.');
    }
    if (dto.motto !== undefined && dto.motto !== null && dto.motto.length > 200) {
      throw new BadRequestException('Motto exceeds 200 character limit.');
    }

    const rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM sis_student_profiles WHERE student_id = $1::uuid FOR UPDATE',
        studentId,
      );
      if (existing.length === 0) {
        const newId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_student_profiles (id, student_id) VALUES ($1::uuid, $2::uuid)',
          newId,
          studentId,
        );
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      let n = 1;
      if (dto.bio !== undefined) {
        sets.push('bio = $' + n);
        params.push(dto.bio);
        n += 1;
      }
      if (dto.currentlyReading !== undefined) {
        sets.push('currently_reading = $' + n);
        params.push(dto.currentlyReading);
        n += 1;
      }
      if (dto.favouriteSong !== undefined) {
        sets.push('favourite_song = $' + n);
        params.push(dto.favouriteSong);
        n += 1;
      }
      if (dto.interests !== undefined) {
        sets.push('interests = $' + n + '::text[]');
        params.push(dto.interests);
        n += 1;
      }
      if (dto.motto !== undefined) {
        sets.push('motto = $' + n);
        params.push(dto.motto);
        n += 1;
      }
      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(studentId);
        await tx.$executeRawUnsafe(
          'UPDATE sis_student_profiles SET ' +
            sets.join(', ') +
            ' WHERE student_id = $' +
            n +
            '::uuid',
          ...params,
        );
      }
      return tx.$queryRawUnsafe<ProfileRow[]>(
        'SELECT ' +
          PROFILE_SELECT_COLS +
          ' FROM sis_student_profiles p ' +
          'WHERE p.student_id = $1::uuid',
        studentId,
      );
    });
    return this.rowToDto(rows[0]!);
  }

  async uploadAvatar(
    studentId: string,
    dto: UploadAvatarDto,
    actor: ResolvedActor,
  ): Promise<StudentProfileDto> {
    await this.assertStudentExists(studentId);
    await this.assertOwnStudentOrAdmin(studentId, actor);

    const rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM sis_student_profiles WHERE student_id = $1::uuid FOR UPDATE',
        studentId,
      );
      if (existing.length === 0) {
        const newId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_student_profiles (id, student_id, avatar_s3_key, avatar_status) ' +
            "VALUES ($1::uuid, $2::uuid, $3, 'PENDING_APPROVAL')",
          newId,
          studentId,
          dto.s3Key,
        );
      } else {
        await tx.$executeRawUnsafe(
          'UPDATE sis_student_profiles SET ' +
            "avatar_s3_key = $1, avatar_status = 'PENDING_APPROVAL', " +
            'avatar_reviewed_by = NULL, avatar_reviewed_at = NULL, avatar_review_notes = NULL, ' +
            'updated_at = now() WHERE student_id = $2::uuid',
          dto.s3Key,
          studentId,
        );
      }
      return tx.$queryRawUnsafe<ProfileRow[]>(
        'SELECT ' +
          PROFILE_SELECT_COLS +
          ' FROM sis_student_profiles p ' +
          'WHERE p.student_id = $1::uuid',
        studentId,
      );
    });
    return this.rowToDto(rows[0]!);
  }

  /**
   * Avatar approval keystone — reviewer-only. REVIEW-P2C13 BLOCKING 2:
   *   - Lock joins through sis_students with the school predicate so a
   *     foreign-school reviewer cannot approve a foreign-school avatar
   *     by guessing the profile UUID.
   *   - sis.avatar.reviewed lands via OutboxService.enqueueInTx INSIDE
   *     the same tx so Kafka outage cannot drop the downstream event.
   */
  async reviewAvatar(
    profileId: string,
    dto: ReviewAvatarDto,
    actor: ResolvedActor,
  ): Promise<StudentProfileDto> {
    if (!(await this.isReviewer(actor))) {
      throw new ForbiddenException(
        'Only homeroom staff or admins can review student avatar uploads.',
      );
    }
    const tenant = getCurrentTenant();

    const rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the profile row only when its student belongs to the
      // calling tenant's school. A foreign-school profile UUID
      // resolves to 0 rows and collapses to 404 don't-leak-existence.
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        'SELECT p.id::text AS id, p.avatar_status AS status ' +
          'FROM sis_student_profiles p ' +
          'JOIN sis_students s ON s.id = p.student_id ' +
          'WHERE p.id = $1::uuid AND s.school_id = $2::uuid FOR UPDATE OF p',
        profileId,
        tenant.schoolId,
      );
      if (locked.length === 0) throw new NotFoundException('Profile not found');
      if (locked[0]!.status !== 'PENDING_APPROVAL') {
        throw new BadRequestException(
          'Avatar status is ' +
            locked[0]!.status +
            '; only PENDING_APPROVAL avatars can be reviewed.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_student_profiles SET avatar_status = $1, ' +
          'avatar_reviewed_by = $2::uuid, avatar_reviewed_at = now(), ' +
          'avatar_review_notes = $3, updated_at = now() WHERE id = $4::uuid',
        dto.decision,
        actor.personId,
        dto.reviewNotes ?? null,
        profileId,
      );
      const after = await tx.$queryRawUnsafe<ProfileRow[]>(
        'SELECT ' +
          PROFILE_SELECT_COLS +
          ' FROM sis_student_profiles p ' +
          'JOIN sis_students s ON s.id = p.student_id ' +
          'WHERE p.id = $1::uuid AND s.school_id = $2::uuid',
        profileId,
        tenant.schoolId,
      );
      // REVIEW-P2C13 BLOCKING 2 — durable emit. OutboxPublisherWorker
      // publishes when the broker recovers; deterministic event id
      // means a retry lands the same envelope.
      await this.outbox.enqueueInTx(tx, {
        topic: 'sis.avatar.reviewed',
        key: profileId,
        sourceModule: 'sis-advanced',
        eventId: deterministicAvatarReviewedEventId(profileId),
        payload: {
          profileId,
          studentId: after[0]!.student_id,
          schoolId: tenant.schoolId,
          decision: dto.decision,
          reviewedBy: actor.personId,
          reviewedAt: after[0]!.avatar_reviewed_at,
          reviewNotes: dto.reviewNotes ?? null,
          sourceRefId: profileId,
        },
      });
      return after;
    });
    return this.rowToDto(rows[0]!);
  }

  /**
   * Admin queue — every profile with avatar_status='PENDING_APPROVAL'
   * WITHIN the current tenant's school. REVIEW-P2C13 BLOCKING 2 — the
   * queue used to be school-wide across the tenant schema regardless
   * of which school the reviewer was operating under.
   */
  async listPendingAvatars(actor: ResolvedActor): Promise<StudentProfileDto[]> {
    if (!(await this.isReviewer(actor))) {
      throw new ForbiddenException(
        'Only homeroom staff or admins can view the avatar approval queue.',
      );
    }
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ProfileRow[]>(
        'SELECT ' +
          PROFILE_SELECT_COLS +
          ' FROM sis_student_profiles p ' +
          'JOIN sis_students s ON s.id = p.student_id ' +
          "WHERE p.avatar_status = 'PENDING_APPROVAL' AND s.school_id = $1::uuid " +
          'ORDER BY p.created_at DESC',
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }
}
