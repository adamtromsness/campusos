import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  DEFAULT_RECOMMENDATION_WEIGHTS,
  RECOMMENDATION_WEIGHTS_KEY,
  RecommendationReason,
  RecommendationResponseDto,
  RecommendationWeights,
  UpdateRecommendationWeightsDto,
} from './dto/library-advanced.dto';

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
  // REVIEW-P2C25 BLOCKING 3 — join through sis_students so every read
  // path proves the recommendation belongs to a student in this tenant.
  'JOIN sis_students s ON s.id = r.student_id ' +
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
   *   - admin / librarian: any studentId IN this school (REVIEW-P2C25
   *     BLOCKING 3 — even admins must prove the student belongs to the
   *     current tenant before reading recommendations).
   *   - student: own studentId only, joined through current-school
   *     sis_students so cross-school identities cannot resolve.
   *   - guardian: a studentId linked via sis_student_guardians AND the
   *     student belongs to the current school (the join through
   *     sis_students enforces it).
   *   - else: 403
   */
  private async assertCanReadFor(studentId: string, actor: ResolvedActor): Promise<void> {
    const tenant = getCurrentTenant();
    if (await this.hasLibrarianScope(actor)) {
      // Librarian / admin still must prove the student exists in this
      // school — REVIEW-P2C25 BLOCKING 3 — otherwise a cross-school
      // UUID could leak recommendations.
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          studentId,
          tenant.schoolId,
        );
      });
      if (rows.length === 0) {
        throw new NotFoundException('Student ' + studentId);
      }
      return;
    }
    if (actor.personType === STUDENT_PERSON_TYPE) {
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.id = $1::uuid AND s.school_id = $2::uuid AND ps.person_id = $3::uuid LIMIT 1',
          studentId,
          tenant.schoolId,
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
            'JOIN sis_students s ON s.id = sg.student_id ' +
            'WHERE sg.student_id = $1::uuid AND s.school_id = $2::uuid AND g.person_id = $3::uuid LIMIT 1',
          studentId,
          tenant.schoolId,
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
    const tenant = getCurrentTenant();
    // REVIEW-P2C25 BLOCKING 3 — bind via s.school_id even though
    // assertCanReadFor already proved the student belongs to this
    // school. Defence-in-depth.
    const sql: string[] = [
      SELECT_REC_BASE,
      'WHERE r.student_id = $1::uuid AND s.school_id = $2::uuid ',
    ];
    const params: unknown[] = [studentId, tenant.schoolId];
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
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C25 BLOCKING 3 — lock through sis_students.school_id
      // so a cross-school recommendation UUID resolves to 0 rows
      // before any UPDATE fires.
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT r.id::text AS id, r.student_id::text AS student_id, r.dismissed_at ' +
          'FROM lib_recommendations r ' +
          'JOIN sis_students s ON s.id = r.student_id ' +
          'WHERE r.id = $1::uuid AND s.school_id = $2::uuid FOR UPDATE OF r',
        recommendationId,
        tenant.schoolId,
      )) as Array<{ id: string; student_id: string; dismissed_at: string | null }>;
      if (lockRows.length === 0) throw new NotFoundException('Recommendation ' + recommendationId);
      const row = lockRows[0]!;
      if (row.dismissed_at) {
        throw new BadRequestException('Recommendation already dismissed');
      }
      // Authorisation — students may only dismiss their own; the
      // sis_students lookup binds through current-school identity so a
      // student whose identity spans schools cannot resolve through
      // this tenant unless the row belongs to their own current-school
      // sis_students record.
      if (!actor.isSchoolAdmin && actor.personType === STUDENT_PERSON_TYPE) {
        const ok = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.id = $1::uuid AND s.school_id = $2::uuid AND ps.person_id = $3::uuid LIMIT 1',
          row.student_id,
          tenant.schoolId,
          actor.personId,
        )) as Array<{ ok: number }>;
        if (ok.length === 0) {
          throw new ForbiddenException('Students can only dismiss their own recommendations');
        }
      } else if (!actor.isSchoolAdmin) {
        const isLibrarian = await this.permissions.hasAnyPermissionInTenant(
          actor.accountId,
          tenant.schoolId,
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
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C25 BLOCKING 3 — validate the student belongs to this
      // school before mutating recommendations. A buggy worker call
      // with a cross-school studentId cannot replace into another
      // tenant's recommendations from this tenant context.
      const studentRows = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (studentRows.length === 0) {
        throw new NotFoundException('Student ' + studentId);
      }
      // Validate every recommended item belongs to this school's catalogue.
      if (capped.length > 0) {
        const itemIds = capped.map((c) => c.itemId);
        const foundRows = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id FROM lib_catalogue_items WHERE school_id = $1::uuid AND id = ANY($2::uuid[])',
          tenant.schoolId,
          itemIds,
        )) as Array<{ id: string }>;
        const found = new Set(foundRows.map((r) => r.id));
        const missing = itemIds.filter((i) => !found.has(i));
        if (missing.length > 0) {
          throw new BadRequestException(
            'Recommended items do not belong to this school: ' + missing.join(', '),
          );
        }
      }
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

  /**
   * P2-25b Step 8 — Load the per-school recommendation engine
   * weights from school_config. Falls back to
   * DEFAULT_RECOMMENDATION_WEIGHTS when no row exists. Mirrors the
   * P2-24 EngagementScoreService.loadWeights pattern.
   */
  async loadWeights(): Promise<RecommendationWeights> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT config_value FROM school_config WHERE config_key = $1 LIMIT 1',
        RECOMMENDATION_WEIGHTS_KEY,
      );
    })) as Array<{ config_value: unknown }>;
    if (rows.length === 0) return { ...DEFAULT_RECOMMENDATION_WEIGHTS };
    const raw = rows[0]!.config_value;
    const parsed: unknown = typeof raw === 'string' ? safeJsonParse(raw) : raw;
    return mergeWeights(parsed);
  }

  async getConfig(actor: ResolvedActor): Promise<RecommendationWeights> {
    if (!actor.isSchoolAdmin) {
      const ok = await this.permissions.hasAnyPermissionInTenant(
        actor.accountId,
        getCurrentTenant().schoolId,
        ['lib-002:read', 'lib-002:write'],
      );
      if (!ok) {
        throw new ForbiddenException('Reading recommendation config requires lib-002 access');
      }
    }
    return this.loadWeights();
  }

  /**
   * Update recommendation weights. Admin-only — librarians read but
   * cannot mutate this surface. PATCH-merge semantics: only supplied
   * keys overwrite the stored value; omitted keys retain their
   * current value. The merged weights must sum to 100 (±0.5),
   * matching the P2-24 engagement-score convention.
   */
  async updateConfig(
    actor: ResolvedActor,
    input: UpdateRecommendationWeightsDto,
  ): Promise<RecommendationWeights> {
    if (!actor.isSchoolAdmin) {
      const ok = await this.permissions.hasAnyPermissionInTenant(
        actor.accountId,
        getCurrentTenant().schoolId,
        ['lib-002:admin', 'lib-003:admin'],
      );
      if (!ok) {
        throw new ForbiddenException(
          'Updating recommendation weights requires lib-002:admin or lib-003:admin',
        );
      }
    }
    const current = await this.loadWeights();
    const merged: RecommendationWeights = {
      collaborativeFiltering: input.collaborativeFiltering ?? current.collaborativeFiltering,
      readingLevelMatch: input.readingLevelMatch ?? current.readingLevelMatch,
      subjectMatch: input.subjectMatch ?? current.subjectMatch,
      newArrival: input.newArrival ?? current.newArrival,
      staffPick: input.staffPick ?? current.staffPick,
    };
    const sum =
      merged.collaborativeFiltering +
      merged.readingLevelMatch +
      merged.subjectMatch +
      merged.newArrival +
      merged.staffPick;
    if (Math.abs(sum - 100) > 0.5) {
      throw new BadRequestException(
        'Recommendation weights must sum to 100. Provided sum=' + sum.toFixed(2),
      );
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO school_config (id, config_key, config_value, description) ' +
          'VALUES ($1::uuid, $2, $3::jsonb, $4) ' +
          'ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now()',
        generateId(),
        RECOMMENDATION_WEIGHTS_KEY,
        JSON.stringify(merged),
        'Library recommendation engine weights — 5-strategy scoring blend.',
      );
    });
    return merged;
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mergeWeights(raw: unknown): RecommendationWeights {
  const base = { ...DEFAULT_RECOMMENDATION_WEIGHTS };
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  return {
    collaborativeFiltering:
      typeof r.collaborativeFiltering === 'number'
        ? r.collaborativeFiltering
        : base.collaborativeFiltering,
    readingLevelMatch:
      typeof r.readingLevelMatch === 'number' ? r.readingLevelMatch : base.readingLevelMatch,
    subjectMatch: typeof r.subjectMatch === 'number' ? r.subjectMatch : base.subjectMatch,
    newArrival: typeof r.newArrival === 'number' ? r.newArrival : base.newArrival,
    staffPick: typeof r.staffPick === 'number' ? r.staffPick : base.staffPick,
  };
}
