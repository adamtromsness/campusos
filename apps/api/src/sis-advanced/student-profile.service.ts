import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { PermissionCheckService } from '../iam/permission-check.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import type {
  AvatarStatus,
  ReviewAvatarDto,
  StudentProfileDto,
  UpdateStudentProfileDto,
  UploadAvatarDto,
} from './dto/sis-advanced.dto';

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

/**
 * Student profile service.
 *
 * Two row-scope contracts:
 *   1. Only the owning STUDENT actor (matched via platform_students.person_id)
 *      can edit bio + interests + motto + currently_reading + favourite_song.
 *      Avatar upload also restricted to the owning student. Admins bypass
 *      via actor.isSchoolAdmin.
 *   2. Avatar review (APPROVED or REJECTED) restricted to STAFF actors via
 *      stu-002:write (homeroom teacher OR admin). Service-layer narrows the
 *      write to STAFF + admin; the controller gate keeps students out
 *      because they hold stu-002:write themselves for the self-service
 *      edit path — the personType check is the actual access boundary.
 */
@Injectable()
export class StudentProfileService {
  private readonly logger = new Logger(StudentProfileService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
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
   * Resolve the calling actor's own sis_students.id when the actor is
   * a STUDENT persona. Returns null otherwise. Used by the self-edit
   * + avatar-upload paths to verify the actor owns the target profile.
   */
  private async resolveOwnStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
      return rows[0]?.id ?? null;
    });
  }

  private async assertStudentExists(studentId: string): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        studentId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Student ' + studentId + ' not found');
  }

  private async assertCanReadProfile(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    const ownId = await this.resolveOwnStudentId(actor);
    if (ownId === studentId) return;
    if (actor.personType === 'GUARDIAN') {
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
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
   * Look up the profile by student_id. Creates an empty profile row on first
   * read so the front-end always has something to render (idempotent
   * upsert-on-read keystone). Avatar status defaults to PENDING_APPROVAL
   * but the avatar_s3_key is NULL until the student uploads.
   */
  async getOrCreateProfile(studentId: string, actor: ResolvedActor): Promise<StudentProfileDto> {
    await this.assertStudentExists(studentId);
    await this.assertCanReadProfile(studentId, actor);

    const rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = await tx.$queryRawUnsafe<ProfileRow[]>(
        'SELECT id::text, student_id::text, bio, currently_reading, favourite_song, ' +
          'interests, motto, avatar_s3_key, avatar_status, avatar_reviewed_by::text, ' +
          'avatar_reviewed_at::text, avatar_review_notes, created_at::text, updated_at::text ' +
          'FROM sis_student_profiles WHERE student_id = $1::uuid',
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
        'SELECT id::text, student_id::text, bio, currently_reading, favourite_song, ' +
          'interests, motto, avatar_s3_key, avatar_status, avatar_reviewed_by::text, ' +
          'avatar_reviewed_at::text, avatar_review_notes, created_at::text, updated_at::text ' +
          'FROM sis_student_profiles WHERE id = $1::uuid',
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
      // Ensure a row exists.
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
      if (sets.length === 0) {
        // No-op patch.
      } else {
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
        'SELECT id::text, student_id::text, bio, currently_reading, favourite_song, ' +
          'interests, motto, avatar_s3_key, avatar_status, avatar_reviewed_by::text, ' +
          'avatar_reviewed_at::text, avatar_review_notes, created_at::text, updated_at::text ' +
          'FROM sis_student_profiles WHERE student_id = $1::uuid',
        studentId,
      );
    });
    return this.rowToDto(rows[0]!);
  }

  /**
   * Avatar upload keystone — only the owning student or an admin can
   * upload. New uploads always land as PENDING_APPROVAL and clear any
   * prior reviewer audit so the homeroom teacher reviews the fresh
   * image.
   */
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
        'SELECT id::text, student_id::text, bio, currently_reading, favourite_song, ' +
          'interests, motto, avatar_s3_key, avatar_status, avatar_reviewed_by::text, ' +
          'avatar_reviewed_at::text, avatar_review_notes, created_at::text, updated_at::text ' +
          'FROM sis_student_profiles WHERE student_id = $1::uuid',
        studentId,
      );
    });
    return this.rowToDto(rows[0]!);
  }

  /**
   * Avatar approval keystone — teacher or admin only. Stamps reviewer + ts
   * inside the same UPDATE so the multi-column lockstep CHECK never sees a
   * half-state row.
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

    const rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        'SELECT id::text AS id, avatar_status AS status FROM sis_student_profiles ' +
          'WHERE id = $1::uuid FOR UPDATE',
        profileId,
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
      return tx.$queryRawUnsafe<ProfileRow[]>(
        'SELECT id::text, student_id::text, bio, currently_reading, favourite_song, ' +
          'interests, motto, avatar_s3_key, avatar_status, avatar_reviewed_by::text, ' +
          'avatar_reviewed_at::text, avatar_review_notes, created_at::text, updated_at::text ' +
          'FROM sis_student_profiles WHERE id = $1::uuid',
        profileId,
      );
    });

    // Emit sis.avatar.reviewed for downstream notification fan-out. ADR-057
    // envelope wrapped by KafkaProducerService.emit(EmitOptions).
    this.kafka
      .emit({
        topic: 'sis.avatar.reviewed',
        key: rows[0]!.id,
        payload: {
          profileId: rows[0]!.id,
          studentId: rows[0]!.student_id,
          decision: dto.decision,
          reviewedBy: actor.personId,
          reviewedAt: rows[0]!.avatar_reviewed_at,
        },
        sourceModule: 'sis-advanced',
      })
      .catch((err) => this.logger.warn('Failed to emit sis.avatar.reviewed', err));

    return this.rowToDto(rows[0]!);
  }

  /**
   * Admin queue — every profile with avatar_status='PENDING_APPROVAL'.
   * Hits the partial INDEX `sis_student_profiles_avatar_pending_idx`.
   */
  async listPendingAvatars(actor: ResolvedActor): Promise<StudentProfileDto[]> {
    if (!(await this.isReviewer(actor))) {
      throw new ForbiddenException(
        'Only homeroom staff or admins can view the avatar approval queue.',
      );
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ProfileRow[]>(
        'SELECT id::text, student_id::text, bio, currently_reading, favourite_song, ' +
          'interests, motto, avatar_s3_key, avatar_status, avatar_reviewed_by::text, ' +
          'avatar_reviewed_at::text, avatar_review_notes, created_at::text, updated_at::text ' +
          "FROM sis_student_profiles WHERE avatar_status = 'PENDING_APPROVAL' " +
          'ORDER BY created_at DESC',
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }
}
