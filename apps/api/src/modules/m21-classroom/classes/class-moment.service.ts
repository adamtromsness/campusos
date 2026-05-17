import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  ClassMomentPhotoDto,
  ClassMomentReactionDto,
  ClassMomentResponseDto,
  CreateClassMomentDto,
  CreateMomentReactionDto,
} from './dto/class-moment.dto';

const VALID_REACTIONS = ['LIKE', 'LOVE', 'CELEBRATE'];

interface MomentRow {
  id: string;
  class_id: string;
  class_name: string | null;
  posted_by: string;
  posted_by_name: string | null;
  caption: string | null;
  posted_at: Date | string;
  is_approved: boolean;
}

interface PhotoRow {
  id: string;
  moment_id: string;
  s3_key: string;
  sort_order: number;
  file_size_bytes: number | null;
  created_at: Date | string;
}

interface ReactionRow {
  id: string;
  moment_id: string;
  reacted_by: string;
  reacted_by_name: string | null;
  reaction_type: 'LIKE' | 'LOVE' | 'CELEBRATE';
  created_at: Date | string;
}

function toIso(v: Date | string | null): string {
  if (v === null) return '';
  return typeof v === 'string' ? v : v.toISOString();
}

function photoRowToDto(row: PhotoRow): ClassMomentPhotoDto {
  return {
    id: row.id,
    s3Key: row.s3_key,
    sortOrder: row.sort_order,
    fileSizeBytes: row.file_size_bytes,
    createdAt: toIso(row.created_at),
  };
}

function reactionRowToDto(row: ReactionRow): ClassMomentReactionDto {
  return {
    id: row.id,
    reactedBy: row.reacted_by,
    reactedByName: row.reacted_by_name,
    reactionType: row.reaction_type,
    createdAt: toIso(row.created_at),
  };
}

const SELECT_MOMENT_BASE =
  'SELECT m.id, m.class_id, ' +
  "(co.name || ' (' || c.section_code || ')') AS class_name, " +
  'm.posted_by, ' +
  "(ip.first_name || ' ' || ip.last_name) AS posted_by_name, " +
  'm.caption, m.posted_at, m.is_approved ' +
  'FROM cls_class_moments m ' +
  'LEFT JOIN sis_classes c ON c.id = m.class_id ' +
  'LEFT JOIN sis_courses co ON co.id = c.course_id ' +
  'LEFT JOIN hr_employees he ON he.id = m.posted_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = he.person_id ';

@Injectable()
export class ClassMomentService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Authorise a moment WRITE for a class — admin OR teacher of the class.
   */
  private async assertCanWriteForClass(classId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) {
      const exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_classes WHERE id = $1::uuid',
          classId,
        );
      });
      if (exists.length === 0) throw new NotFoundException('Class ' + classId + ' not found');
      return;
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees can post class moments. The calling user has no hr_employees record.',
      );
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers ' +
          'WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
        classId,
        actor.employeeId,
      );
    });
    if (rows.length === 0) {
      throw new ForbiddenException(
        'You are not assigned to class ' + classId + ' and cannot post moments to it.',
      );
    }
  }

  /**
   * Authorise a class moment READ. Admins / teachers / staff with TCH-009:read
   * see all classes. Parents see classes their children are enrolled in.
   * Students see classes they are enrolled in.
   */
  private async assertCanReadForClass(classId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) {
      const exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_classes WHERE id = $1::uuid',
          classId,
        );
      });
      if (exists.length === 0) throw new NotFoundException('Class ' + classId + ' not found');
      return;
    }
    if (actor.personType === 'STAFF' && actor.employeeId) {
      // Generic STAFF with TCH-009:read can view any class's feed; teacher-of-class additionally
      // can write but read is OK either way for class oversight.
      const exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_classes WHERE id = $1::uuid',
          classId,
        );
      });
      if (exists.length === 0) throw new NotFoundException('Class ' + classId + ' not found');
      return;
    }
    if (actor.personType === 'GUARDIAN') {
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_enrollments e ' +
            'JOIN sis_students s ON s.id = e.student_id ' +
            'JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            "WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' AND g.person_id = $2::uuid",
          classId,
          actor.personId,
        );
      });
      if (rows.length === 0) throw new NotFoundException('Class ' + classId + ' not found');
      return;
    }
    if (actor.personType === 'STUDENT') {
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_enrollments e ' +
            'JOIN sis_students s ON s.id = e.student_id ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            "WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' AND ps.person_id = $2::uuid",
          classId,
          actor.personId,
        );
      });
      if (rows.length === 0) throw new NotFoundException('Class ' + classId + ' not found');
      return;
    }
    throw new NotFoundException('Class ' + classId + ' not found');
  }

  private async loadMomentChildren(
    momentIds: string[],
    actorPersonId: string | null,
  ): Promise<{
    photoMap: Map<string, ClassMomentPhotoDto[]>;
    reactionMap: Map<string, ClassMomentReactionDto[]>;
    myReactionMap: Map<string, 'LIKE' | 'LOVE' | 'CELEBRATE' | null>;
  }> {
    if (momentIds.length === 0) {
      return {
        photoMap: new Map(),
        reactionMap: new Map(),
        myReactionMap: new Map(),
      };
    }
    const photoMap = new Map<string, ClassMomentPhotoDto[]>();
    const reactionMap = new Map<string, ClassMomentReactionDto[]>();
    const myReactionMap = new Map<string, 'LIKE' | 'LOVE' | 'CELEBRATE' | null>();

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const photos = await client.$queryRawUnsafe<PhotoRow[]>(
        'SELECT id, moment_id, s3_key, sort_order, file_size_bytes, created_at ' +
          'FROM cls_class_moment_photos WHERE moment_id = ANY($1::uuid[]) ORDER BY moment_id, sort_order',
        momentIds,
      );
      for (const p of photos) {
        const arr = photoMap.get(p.moment_id) ?? [];
        arr.push(photoRowToDto(p));
        photoMap.set(p.moment_id, arr);
      }
      const reactions = await client.$queryRawUnsafe<ReactionRow[]>(
        'SELECT r.id, r.moment_id, r.reacted_by, ' +
          "(ip.first_name || ' ' || ip.last_name) AS reacted_by_name, " +
          'r.reaction_type, r.created_at ' +
          'FROM cls_class_moment_reactions r ' +
          'LEFT JOIN platform.iam_person ip ON ip.id = r.reacted_by ' +
          'WHERE r.moment_id = ANY($1::uuid[]) ORDER BY r.moment_id, r.created_at',
        momentIds,
      );
      for (const r of reactions) {
        const arr = reactionMap.get(r.moment_id) ?? [];
        arr.push(reactionRowToDto(r));
        reactionMap.set(r.moment_id, arr);
        if (actorPersonId && r.reacted_by === actorPersonId) {
          myReactionMap.set(r.moment_id, r.reaction_type);
        }
      }
    });

    return { photoMap, reactionMap, myReactionMap };
  }

  private async assembleDtos(
    rows: MomentRow[],
    actor: ResolvedActor,
  ): Promise<ClassMomentResponseDto[]> {
    const ids = rows.map((r) => r.id);
    const { photoMap, reactionMap, myReactionMap } = await this.loadMomentChildren(
      ids,
      actor.personId,
    );
    return rows.map((row) => ({
      id: row.id,
      classId: row.class_id,
      className: row.class_name,
      postedBy: row.posted_by,
      postedByName: row.posted_by_name,
      caption: row.caption,
      postedAt: toIso(row.posted_at),
      isApproved: row.is_approved,
      photos: photoMap.get(row.id) ?? [],
      reactions: reactionMap.get(row.id) ?? [],
      reactionCount: (reactionMap.get(row.id) ?? []).length,
      myReaction: myReactionMap.get(row.id) ?? null,
    }));
  }

  /** GET /classroom/classes/:id/moments — class feed. */
  async listForClass(classId: string, actor: ResolvedActor): Promise<ClassMomentResponseDto[]> {
    await this.assertCanReadForClass(classId, actor);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MomentRow[]>(
        SELECT_MOMENT_BASE +
          ' WHERE m.class_id = $1::uuid AND m.is_approved = true ORDER BY m.posted_at DESC',
        classId,
      );
    });
    return this.assembleDtos(rows, actor);
  }

  /** GET /classroom/moments/:id */
  async getById(id: string, actor: ResolvedActor): Promise<ClassMomentResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MomentRow[]>(SELECT_MOMENT_BASE + ' WHERE m.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Moment ' + id + ' not found');
    await this.assertCanReadForClass(rows[0]!.class_id, actor);
    if (!rows[0]!.is_approved && !actor.isSchoolAdmin && rows[0]!.posted_by !== actor.employeeId) {
      throw new NotFoundException('Moment ' + id + ' not found');
    }
    const dtos = await this.assembleDtos(rows, actor);
    return dtos[0]!;
  }

  /** POST /classroom/classes/:classId/moments */
  async create(
    classId: string,
    input: CreateClassMomentDto,
    actor: ResolvedActor,
  ): Promise<ClassMomentResponseDto> {
    await this.assertCanWriteForClass(classId, actor);
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees can post class moments. The calling user has no hr_employees record.',
      );
    }
    if (input.photos.length === 0) {
      throw new BadRequestException('At least one photo is required.');
    }
    const momentId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_class_moments (id, class_id, posted_by, caption, posted_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())',
        momentId,
        classId,
        actor.employeeId,
        input.caption ?? null,
      );
      let i = 0;
      for (const photo of input.photos) {
        await tx.$executeRawUnsafe(
          'INSERT INTO cls_class_moment_photos (id, moment_id, s3_key, sort_order, file_size_bytes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::int, $5)',
          generateId(),
          momentId,
          photo.s3Key,
          photo.sortOrder ?? i,
          photo.fileSizeBytes ?? null,
        );
        i++;
      }
    });
    return this.getById(momentId, actor);
  }

  /** DELETE /classroom/moments/:id */
  async delete(id: string, actor: ResolvedActor): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ posted_by: string; class_id: string }>>(
        'SELECT posted_by::text AS posted_by, class_id::text AS class_id ' +
          'FROM cls_class_moments WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Moment ' + id + ' not found');
      const row = rows[0]!;
      if (!actor.isSchoolAdmin && row.posted_by !== actor.employeeId) {
        throw new ForbiddenException('Only the posting teacher or an admin can delete a moment.');
      }
      await tx.$executeRawUnsafe('DELETE FROM cls_class_moments WHERE id = $1::uuid', id);
    });
  }

  /** POST /classroom/moments/:id/react — UPSERT reaction. */
  async react(
    momentId: string,
    input: CreateMomentReactionDto,
    actor: ResolvedActor,
  ): Promise<ClassMomentResponseDto> {
    if (!VALID_REACTIONS.includes(input.reactionType)) {
      throw new BadRequestException('reactionType must be one of: ' + VALID_REACTIONS.join(', '));
    }
    // Ensure caller can see the parent moment
    const moment = await this.getById(momentId, actor);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_class_moment_reactions (id, moment_id, reacted_by, reaction_type) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4) ' +
          'ON CONFLICT (moment_id, reacted_by) DO UPDATE SET ' +
          'reaction_type = EXCLUDED.reaction_type, updated_at = now()',
        generateId(),
        momentId,
        actor.personId,
        input.reactionType,
      );
    });

    return this.getById(moment.id, actor);
  }

  /** DELETE /classroom/moments/:id/react */
  async unreact(momentId: string, actor: ResolvedActor): Promise<ClassMomentResponseDto> {
    const moment = await this.getById(momentId, actor);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM cls_class_moment_reactions WHERE moment_id = $1::uuid AND reacted_by = $2::uuid',
        momentId,
        actor.personId,
      );
    });
    return this.getById(moment.id, actor);
  }
}
