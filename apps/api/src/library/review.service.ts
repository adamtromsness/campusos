import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { CreateReviewDto, ReviewResponseDto, UpdateReviewDto } from './dto/library.dto';

interface ReviewRow {
  id: string;
  item_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  rating: number;
  review_text: string | null;
  is_approved: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_REVIEW_BASE =
  'SELECT r.id::text AS id, r.item_id::text AS item_id, ' +
  'r.student_id::text AS student_id, ' +
  'p.first_name AS student_first, p.last_name AS student_last, ' +
  'r.rating, r.review_text, r.is_approved, ' +
  'TO_CHAR(r.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(r.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_reviews r ' +
  'LEFT JOIN sis_students s ON s.id = r.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = ps.person_id ';

function rowToDto(r: ReviewRow): ReviewResponseDto {
  return {
    id: r.id,
    itemId: r.item_id,
    studentId: r.student_id,
    studentName: r.student_first && r.student_last ? r.student_first + ' ' + r.student_last : null,
    rating: r.rating,
    reviewText: r.review_text,
    isApproved: r.is_approved,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ReviewService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Reviewer / moderator scope: admin OR non-student STAFF holding
   * lib-003:write. Students hold lib-003:write per the IAM seed but
   * are not moderators — the personType guard prevents student
   * self-moderation. Granted to Teacher + Staff + Admin.
   */
  private async hasModeratorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType === 'STUDENT') return false;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-003:write',
    ]);
  }

  /**
   * Resolve the calling student's sis_students.id. Returns null for
   * non-STUDENT actors.
   */
  private async resolveCallerStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid',
        actor.personId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) return null;
      return rows[0]!.id;
    });
  }

  /**
   * List reviews for a catalogue item. Public to anyone with
   * lib-003:read but only is_approved=true rows are returned for
   * non-moderator readers (the librarian soft-hide path).
   */
  async listForItem(itemId: string, actor: ResolvedActor): Promise<ReviewResponseDto[]> {
    const isModerator = await this.hasModeratorScope(actor);
    const where: string[] = ['r.item_id = $1::uuid'];
    if (!isModerator) where.push('r.is_approved = true');
    const sql =
      SELECT_REVIEW_BASE + 'WHERE ' + where.join(' AND ') + ' ORDER BY r.created_at DESC LIMIT 200';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ReviewRow[]>(sql, itemId);
    });
    return rows.map(rowToDto);
  }

  /**
   * Student submits a review. UNIQUE(item_id, student_id) means each
   * student gets exactly one review per item — duplicate POST returns
   * a friendly 400 telling the caller to PATCH instead.
   */
  async create(
    itemId: string,
    input: CreateReviewDto,
    actor: ResolvedActor,
  ): Promise<ReviewResponseDto> {
    if (actor.personType !== 'STUDENT') {
      throw new ForbiddenException('Only students can submit book reviews');
    }
    const studentId = await this.resolveCallerStudentId(actor);
    if (!studentId) {
      throw new ForbiddenException(
        'Calling actor has no sis_students row in this school — reviews are student-only',
      );
    }
    const tenant = getCurrentTenant();

    // Validate the catalogue item exists in this tenant.
    const itemExists = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM lib_catalogue_items WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        itemId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      return rows.length > 0;
    });
    if (!itemExists) {
      throw new NotFoundException('Catalogue item ' + itemId);
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO lib_reviews (id, item_id, student_id, rating, review_text, is_approved) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, true)',
          id,
          itemId,
          studentId,
          input.rating,
          input.reviewText ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'You have already reviewed this book. PATCH /library/reviews/:id to edit your existing review.',
        );
      }
      throw err;
    }
    return this.loadOrFail(id);
  }

  /**
   * Patch a review. Student edits own only (row-scope inside the tx).
   * Moderator can edit anyone's review (e.g. correct a typo) but the
   * common moderator action is PATCH `is_approved=false` via the
   * dedicated /hide endpoint below.
   */
  async patch(
    id: string,
    input: UpdateReviewDto,
    actor: ResolvedActor,
  ): Promise<ReviewResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, student_id::text AS student_id FROM lib_reviews WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; student_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Review ' + id);

      const isModerator = await this.hasModeratorScope(actor);
      if (!isModerator) {
        const callerStudentId = await this.resolveCallerStudentId(actor);
        if (!callerStudentId || lockRows[0]!.student_id !== callerStudentId) {
          throw new ForbiddenException('You can only edit your own reviews');
        }
      }

      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      const set = (col: string, val: unknown) => {
        updates.push(col + ' = $' + idx);
        params.push(val);
        idx++;
      };
      if (input.rating !== undefined) set('rating', input.rating);
      if (input.reviewText !== undefined) set('review_text', input.reviewText);
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      await tx.$executeRawUnsafe(
        'UPDATE lib_reviews SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * Librarian / admin soft-hides a review by flipping
   * `is_approved=false`. The row is preserved for audit; non-moderator
   * readers no longer see the review on the public catalogue page.
   * To restore, call PATCH with `is_approved=true` (a librarian
   * unhide path — admin-supplied via the same endpoint).
   */
  async setApproval(
    id: string,
    isApproved: boolean,
    actor: ResolvedActor,
  ): Promise<ReviewResponseDto> {
    if (!(await this.hasModeratorScope(actor))) {
      throw new ForbiddenException(
        'Only librarians, teachers, or admins can hide / unhide reviews',
      );
    }
    const r = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE lib_reviews SET is_approved = $2, updated_at = now() WHERE id = $1::uuid',
        id,
        isApproved,
      );
    });
    if (r === 0) throw new NotFoundException('Review ' + id);
    return this.loadOrFail(id);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string): Promise<ReviewResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ReviewRow[]>(SELECT_REVIEW_BASE + 'WHERE r.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Review ' + id);
    return rowToDto(rows[0]!);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
