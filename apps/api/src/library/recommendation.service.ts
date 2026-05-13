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
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { RecommendationReason, RecommendationResponseDto } from './dto/library-advanced.dto';

/**
 * P2-25a Step 5 — RecommendationService.
 *
 * Read-side surface for student book recommendations. The
 * LibraryRecommendationWorker (a sibling class, deferred to a future
 * cron-deploy slot — placeholder lives in
 * library-recommendation.worker.ts) is the canonical writer. Until
 * the worker ships, the seed plants representative rows so the UI +
 * dashboard can render against real data.
 *
 * Read path:
 *   - Students read their own recommendations only.
 *   - Guardians read recommendations for their own children
 *     (cross-cycle via sis_student_guardians).
 *   - Librarians + admins read any.
 *
 * Dismiss path:
 *   - Student dismisses an active recommendation. The service stamps
 *     dismissed_at + dismissed_by (the dismisser's hr_employees id
 *     when present; for student dismissals dismissed_by stays NULL
 *     because students do not have hr_employees rows). The next
 *     LibraryRecommendationWorker run filters dismissed rows out and
 *     produces a fresh batch.
 */

const STUDENT_PERSON_TYPE = 'STUDENT';
const GUARDIAN_PERSON_TYPE = 'GUARDIAN';

interface RecommendationRow {
  id: string;
  student_id: string;
  recommended_item_id: string;
  item_title: string | null;
  item_author: string | null;
  item_cover_image_url: string | null;
  reason_type: string;
  score: string | null;
  reason_metadata: unknown;
  dismissed_at: string | null;
  generated_at: string;
}

const SELECT_REC_BASE =
  'SELECT r.id::text AS id, r.student_id::text AS student_id, ' +
  'r.recommended_item_id::text AS recommended_item_id, ' +
  'ci.title AS item_title, ci.author AS item_author, ' +
  'ci.cover_image_url AS item_cover_image_url, ' +
  'r.reason_type, r.score::text AS score, r.reason_metadata, ' +
  'TO_CHAR(r.dismissed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS dismissed_at, ' +
  'TO_CHAR(r.generated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS generated_at ' +
  'FROM lib_recommendations r ' +
  'LEFT JOIN lib_catalogue_items ci ON ci.id = r.recommended_item_id ';

function rowToRecDto(r: RecommendationRow): RecommendationResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    recommendedItemId: r.recommended_item_id,
    itemTitle: r.item_title,
    itemAuthor: r.item_author,
    itemCoverImageUrl: r.item_cover_image_url,
    reasonType: r.reason_type as RecommendationReason,
    score: r.score === null ? null : Number(r.score),
    reasonMetadata: (r.reason_metadata as Record<string, unknown> | null) ?? null,
    dismissedAt: r.dismissed_at,
    generatedAt: r.generated_at,
  };
}

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async hasLibrarianScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-002:write',
    ]);
  }

  /**
   * Visibility:
   *   - admin / librarian: any studentId
   *   - student: own studentId only
   *   - guardian: a studentId linked via sis_student_guardians
   *   - else: 403
   */
  private async assertCanReadFor(studentId: string, actor: ResolvedActor): Promise<void> {
    if (await this.hasLibrarianScope(actor)) return;
    if (actor.personType === STUDENT_PERSON_TYPE) {
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        );
      });
      if (rows.length === 0) {
        throw new ForbiddenException('Students can only read their own recommendations');
      }
      return;
    }
    if (actor.personType === GUARDIAN_PERSON_TYPE) {
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        );
      });
      if (rows.length === 0) {
        throw new ForbiddenException(
          'Guardians can only read recommendations for their linked children',
        );
      }
      return;
    }
    throw new ForbiddenException('Not authorised to read these recommendations');
  }

  async listForStudent(
    studentId: string,
    actor: ResolvedActor,
    args: { includeDismissed?: boolean },
  ): Promise<RecommendationResponseDto[]> {
    await this.assertCanReadFor(studentId, actor);
    const sql: string[] = [SELECT_REC_BASE, 'WHERE r.student_id = $1::uuid '];
    const params: unknown[] = [studentId];
    if (!args.includeDismissed) {
      sql.push('AND r.dismissed_at IS NULL ');
    }
    sql.push('ORDER BY r.score DESC NULLS LAST, r.generated_at DESC LIMIT 20');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RecommendationRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToRecDto);
  }

  /**
   * Dismiss a recommendation. Student-owned action — service-side
   * check that the recommendation belongs to the calling student.
   * The next LibraryRecommendationWorker run filters dismissed rows
   * out of the next batch (and excludes the same item from
   * re-recommend for 90 days).
   */
  async dismiss(recommendationId: string, actor: ResolvedActor): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, student_id::text AS student_id, dismissed_at ' +
          'FROM lib_recommendations WHERE id = $1::uuid FOR UPDATE',
        recommendationId,
      )) as Array<{ id: string; student_id: string; dismissed_at: string | null }>;
      if (lockRows.length === 0) throw new NotFoundException('Recommendation ' + recommendationId);
      const row = lockRows[0]!;
      if (row.dismissed_at) {
        throw new BadRequestException('Recommendation already dismissed');
      }
      // Authorisation — students may only dismiss their own
      if (!actor.isSchoolAdmin && actor.personType === STUDENT_PERSON_TYPE) {
        const ok = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
          row.student_id,
          actor.personId,
        )) as Array<{ ok: number }>;
        if (ok.length === 0) {
          throw new ForbiddenException('Students can only dismiss their own recommendations');
        }
      } else if (!actor.isSchoolAdmin) {
        const isLibrarian = await this.permissions.hasAnyPermissionInTenant(
          actor.accountId,
          getCurrentTenant().schoolId,
          ['lib-002:write'],
        );
        if (!isLibrarian) {
          throw new ForbiddenException(
            'Only the owning student or a librarian / admin can dismiss a recommendation',
          );
        }
      }
      await tx.$executeRawUnsafe(
        'UPDATE lib_recommendations SET dismissed_at = now(), dismissed_by = $1::uuid, updated_at = now() WHERE id = $2::uuid',
        actor.employeeId ?? null,
        recommendationId,
      );
      this.logger.log('[recommendation.dismiss] id=' + recommendationId.slice(0, 8));
    });
  }

  /**
   * Helper for the future LibraryRecommendationWorker — DELETE all
   * non-dismissed recommendations for a student and INSERT a fresh
   * batch in one tx. The full-replace contract is documented in
   * migration 165.
   *
   * Public so a future Cycle 25 follow-up worker can reuse it
   * without re-implementing the contract. Out of P2-25a scope to
   * actually fire from a worker — the seed plants representative
   * data and the dismiss endpoint exercises the soft-hide path.
   */
  async replaceForStudent(
    studentId: string,
    fresh: Array<{
      itemId: string;
      reasonType: RecommendationReason;
      score?: number | null;
      reasonMetadata?: Record<string, unknown> | null;
    }>,
  ): Promise<number> {
    const capped = fresh.slice(0, 20);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'DELETE FROM lib_recommendations WHERE student_id = $1::uuid',
        studentId,
      );
      for (const r of capped) {
        await tx.$executeRawUnsafe(
          'INSERT INTO lib_recommendations ' +
            '(id, student_id, recommended_item_id, reason_type, score, reason_metadata, generated_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, now())',
          generateId(),
          studentId,
          r.itemId,
          r.reasonType,
          r.score ?? null,
          r.reasonMetadata ? JSON.stringify(r.reasonMetadata) : null,
        );
      }
    });
    return capped.length;
  }
}
