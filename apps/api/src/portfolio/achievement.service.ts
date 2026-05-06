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
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type {
  AchievementDto,
  AchievementShareDto,
  AchievementType,
  CreateAchievementDto,
  CreateAchievementShareDto,
  UpdateAchievementDto,
} from './dto/portfolio.dto';

interface AchievementRow {
  id: string;
  student_id: string;
  student_name: string | null;
  school_id: string;
  title: string;
  achievement_type: AchievementType;
  source_module: string | null;
  source_ref_id: string | null;
  awarded_at: string;
  awarded_by_id: string | null;
  awarded_by_name: string | null;
  description: string | null;
  badge_image_url: string | null;
  share_count: number;
  created_at: string;
}

const SELECT_ACHIEVEMENT_BASE = `
  SELECT
    a.id::text AS id,
    a.student_id::text AS student_id,
    (SELECT ip.first_name || ' ' || ip.last_name
       FROM sis_students s
       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
       JOIN platform.iam_person ip ON ip.id = ps.person_id
       WHERE s.id = a.student_id LIMIT 1) AS student_name,
    a.school_id::text AS school_id,
    a.title,
    a.achievement_type,
    a.source_module,
    a.source_ref_id::text AS source_ref_id,
    a.awarded_at::text AS awarded_at,
    a.awarded_by::text AS awarded_by_id,
    (SELECT ip2.first_name || ' ' || ip2.last_name
       FROM hr_employees e
       JOIN platform.iam_person ip2 ON ip2.id = e.person_id
       WHERE e.id = a.awarded_by LIMIT 1) AS awarded_by_name,
    a.description,
    a.badge_image_url,
    (SELECT COUNT(*)::int FROM pfl_achievement_shares sh WHERE sh.achievement_id = a.id) AS share_count,
    a.created_at::text AS created_at
  FROM pfl_achievements a
`;

@Injectable()
export class AchievementService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private rowToDto(r: AchievementRow): AchievementDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      schoolId: r.school_id,
      title: r.title,
      achievementType: r.achievement_type,
      sourceModule: r.source_module,
      sourceRefId: r.source_ref_id,
      awardedAt: r.awarded_at,
      awardedById: r.awarded_by_id,
      awardedByName: r.awarded_by_name,
      description: r.description,
      badgeImageUrl: r.badge_image_url,
      shareCount: Number(r.share_count),
      createdAt: r.created_at,
    };
  }

  // BLOCKING 5 (REVIEW-CYCLE24) — validate that the supplied (sourceModule,
  // sourceRefId) pair refers to a real prior-cycle row that belongs to the
  // awarded student. The four supported modules cover the cross-cycle
  // integration points documented in the Cycle 24 handoff:
  //
  //   - 'library'   -> lib_programme_completions (Cycle 12)
  //   - 'clubs'     -> ext_service_progress (Cycle 17)
  //   - 'athletics' -> ath_player_game_stats / ath_all_time_records (Cycle 13)
  //   - 'classroom' -> cls_grades (Cycle 2)
  //
  // For 'classroom' we resolve via cls_grades.student_id (matches the
  // PortfolioItemService SUBMISSION/GRADE source-resolution pattern). For
  // 'athletics' we walk ath_player_game_stats first (per-game stats are
  // student-scoped); ath_all_time_records is school-scoped, so we accept
  // the row by school match without student ownership for that table.
  // Unknown modules fall through to BadRequestException.
  private async assertSourceOwnedBy(
    sourceModule: string,
    sourceRefId: string,
    studentId: string,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    if (sourceModule === 'library') {
      const ok = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM lib_programme_completions WHERE id = $1::uuid AND student_id = $2::uuid LIMIT 1',
          sourceRefId,
          studentId,
        );
      })) as Array<unknown>;
      if (ok.length === 0) {
        throw new BadRequestException(
          'sourceRefId does not match a library programme completion belonging to this student.',
        );
      }
      return;
    }
    if (sourceModule === 'clubs') {
      const ok = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM ext_service_progress WHERE id = $1::uuid AND student_id = $2::uuid LIMIT 1',
          sourceRefId,
          studentId,
        );
      })) as Array<unknown>;
      if (ok.length === 0) {
        throw new BadRequestException(
          'sourceRefId does not match a service progress row belonging to this student.',
        );
      }
      return;
    }
    if (sourceModule === 'classroom') {
      const ok = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM cls_grades WHERE id = $1::uuid AND student_id = $2::uuid LIMIT 1',
          sourceRefId,
          studentId,
        );
      })) as Array<unknown>;
      if (ok.length === 0) {
        throw new BadRequestException(
          'sourceRefId does not match a classroom grade belonging to this student.',
        );
      }
      return;
    }
    if (sourceModule === 'athletics') {
      // Try per-game stats (student-scoped) first.
      const stats = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM ath_player_game_stats WHERE id = $1::uuid AND student_id = $2::uuid LIMIT 1',
          sourceRefId,
          studentId,
        );
      })) as Array<unknown>;
      if (stats.length > 0) return;
      // Fall back to all-time records (school-scoped — confirm at school level).
      const allTime = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM ath_all_time_records WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          sourceRefId,
          tenant.schoolId,
        );
      })) as Array<unknown>;
      if (allTime.length > 0) return;
      throw new BadRequestException(
        'sourceRefId does not match an athletics record in this school.',
      );
    }
    throw new BadRequestException(
      `sourceModule '${sourceModule}' is not a supported cross-cycle achievement source. Supported: library, clubs, classroom, athletics.`,
    );
  }

  // Visibility for the achievement list:
  //   - admin: all
  //   - staff (teacher/counsellor with ach-001:write): students in their tenant
  //   - student: own
  //   - guardian: linked children
  private async buildVisibility(
    actor: ResolvedActor,
  ): Promise<{ predicate: string; params: unknown[] }> {
    const tenant = getCurrentTenant();
    if (actor.isSchoolAdmin) {
      return {
        predicate: 'WHERE a.school_id = $1::uuid',
        params: [tenant.schoolId],
      };
    }
    if (actor.personType === 'STAFF') {
      const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
        'ach-001:read',
      ]);
      if (ok) {
        return {
          predicate: 'WHERE a.school_id = $1::uuid',
          params: [tenant.schoolId],
        };
      }
    }
    if (actor.personType === 'STUDENT') {
      return {
        predicate:
          'WHERE a.school_id = $1::uuid AND a.student_id = (SELECT s.id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $2::uuid LIMIT 1)',
        params: [tenant.schoolId, actor.personId],
      };
    }
    if (actor.personType === 'GUARDIAN') {
      return {
        predicate:
          'WHERE a.school_id = $1::uuid AND a.student_id IN (SELECT sg.student_id FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id WHERE g.person_id = $2::uuid)',
        params: [tenant.schoolId, actor.personId],
      };
    }
    // No visibility — return a predicate that excludes everything.
    return { predicate: 'WHERE FALSE', params: [] };
  }

  async list(actor: ResolvedActor, studentId?: string): Promise<AchievementDto[]> {
    const vis = await this.buildVisibility(actor);
    let where = vis.predicate;
    const params = [...vis.params];
    if (studentId && vis.params.length > 0) {
      params.push(studentId);
      where += ` AND a.student_id = $${params.length}::uuid`;
    }
    if (vis.params.length === 0) return [];
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ACHIEVEMENT_BASE + ' ' + where + ' ORDER BY a.awarded_at DESC',
        ...params,
      );
    })) as AchievementRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(actor: ResolvedActor, id: string): Promise<AchievementDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ACHIEVEMENT_BASE + ' WHERE a.id = $1::uuid AND a.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as AchievementRow[];
    if (rows.length === 0) throw new NotFoundException('Achievement not found');
    const r = rows[0]!;
    // Re-apply row scope so a non-authorised actor can't read by id.
    const scoped = await this.list(actor, r.student_id);
    if (!scoped.some((a) => a.id === id)) throw new NotFoundException('Achievement not found');
    return this.rowToDto(r);
  }

  // Award an achievement. Teacher / counsellor / staff only — student cannot
  // self-award via this surface (they curate their own portfolio via the
  // pfl_portfolio_items REFLECTION + EXTERNAL_FILE paths).
  async create(actor: ResolvedActor, input: CreateAchievementDto): Promise<AchievementDto> {
    const tenant = getCurrentTenant();
    if (!actor.isSchoolAdmin) {
      const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
        'ach-001:write',
      ]);
      if (!ok) {
        throw new ForbiddenException(
          'Only teachers, counsellors, or school admins can award achievements.',
        );
      }
      if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
        throw new ForbiddenException('Only staff can award achievements.');
      }
    }

    // Validate student exists in tenant
    const studentExists = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      );
    })) as Array<unknown>;
    if (studentExists.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school.');
    }

    // BLOCKING 5 (REVIEW-CYCLE24) — when sourceModule + sourceRefId are
    // supplied, validate the source row exists AND belongs to the awarded
    // student AND matches the source module. The 4 supported modules below
    // are the cross-cycle integration points the handoff documents; an
    // unknown sourceModule with a sourceRefId is rejected. Manual teacher-
    // awarded achievements with neither field set are accepted as-is.
    if (input.sourceRefId && !input.sourceModule) {
      throw new BadRequestException('sourceModule must be supplied when sourceRefId is provided.');
    }
    if (input.sourceModule && input.sourceRefId) {
      await this.assertSourceOwnedBy(input.sourceModule, input.sourceRefId, input.studentId);
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO pfl_achievements (id, student_id, school_id, title, achievement_type, source_module, source_ref_id, awarded_at, awarded_by, description, badge_image_url) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8::date, $9::uuid, $10, $11)',
        id,
        input.studentId,
        tenant.schoolId,
        input.title,
        input.achievementType,
        input.sourceModule ?? null,
        input.sourceRefId ?? null,
        input.awardedAt ?? new Date().toISOString().slice(0, 10),
        actor.employeeId ?? null,
        input.description ?? null,
        input.badgeImageUrl ?? null,
      );
    });

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ACHIEVEMENT_BASE + ' WHERE a.id = $1::uuid LIMIT 1', id);
    })) as AchievementRow[];
    const dto = this.rowToDto(rows[0]!);

    // Emit pfl.achievement.awarded after the row is committed.
    await this.kafka.emit({
      topic: 'pfl.achievement.awarded',
      key: dto.id,
      sourceModule: 'portfolio',
      payload: {
        // achievementId is the new pfl_achievements row; sourceRefId is the
        // ORIGINATING module reference (lib_programme_completions.id, etc.) —
        // null for manual teacher awards. Fixes REVIEW-CYCLE24 MAJOR 8.
        achievementId: dto.id,
        sourceRefId: dto.sourceRefId,
        studentId: dto.studentId,
        studentName: dto.studentName,
        schoolId: dto.schoolId,
        title: dto.title,
        achievementType: dto.achievementType,
        sourceModuleHint: dto.sourceModule,
        awardedAt: dto.awardedAt,
        awardedById: dto.awardedById,
        awardedByName: dto.awardedByName,
        badgeImageUrl: dto.badgeImageUrl,
      },
    });

    return dto;
  }

  async patch(
    actor: ResolvedActor,
    id: string,
    input: UpdateAchievementDto,
  ): Promise<AchievementDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT awarded_by::text AS awarded_by FROM pfl_achievements WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ awarded_by: string | null }>;
      if (rows.length === 0) throw new NotFoundException('Achievement not found');
      // Owner-edit OR admin override. Owner = the awarding teacher.
      // MAJOR 9 (REVIEW-CYCLE24) — when awarded_by IS NULL the achievement
      // was created by a system path (Cycle 12 lib_programme_completions
      // backfill, Cycle 17 service-hour milestone, etc.) and has no
      // human awarder to defer to. Restrict edits to school admin in that
      // case so a generic ach-001:write holder can't rewrite a system-
      // generated cross-module achievement.
      if (!actor.isSchoolAdmin) {
        if (rows[0]!.awarded_by === null) {
          throw new ForbiddenException(
            'System-generated achievements (no awarding teacher) can only be edited by a school admin.',
          );
        }
        const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
          'ach-001:write',
        ]);
        if (!ok)
          throw new ForbiddenException('Only the awarder or admin can edit this achievement.');
        if (!actor.employeeId || actor.employeeId !== rows[0]!.awarded_by) {
          throw new ForbiddenException(
            'Only the awarding teacher or a school admin can edit this achievement.',
          );
        }
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (sql: string, value: unknown) => {
        params.push(value);
        sets.push(`${sql} = $${params.length}`);
      };
      if (input.title !== undefined) push('title', input.title);
      if (input.description !== undefined) push('description', input.description);
      if (input.badgeImageUrl !== undefined) push('badge_image_url', input.badgeImageUrl);
      if (sets.length === 0) {
        const cur = (await client.$queryRawUnsafe(
          SELECT_ACHIEVEMENT_BASE + ' WHERE a.id = $1::uuid LIMIT 1',
          id,
        )) as AchievementRow[];
        return this.rowToDto(cur[0]!);
      }
      sets.push('updated_at = now()');
      params.push(id);
      await client.$executeRawUnsafe(
        `UPDATE pfl_achievements SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
        ...params,
      );
      const cur = (await client.$queryRawUnsafe(
        SELECT_ACHIEVEMENT_BASE + ' WHERE a.id = $1::uuid LIMIT 1',
        id,
      )) as AchievementRow[];
      return this.rowToDto(cur[0]!);
    });
  }

  // ── Achievement shares ────────────────────────────────────

  async listShares(actor: ResolvedActor, achievementId: string): Promise<AchievementShareDto[]> {
    // Make sure caller can read the achievement (visibility-gated).
    await this.getById(actor, achievementId);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, achievement_id::text AS achievement_id, shared_by::text AS shared_by, platform, shared_at::text AS shared_at FROM pfl_achievement_shares WHERE achievement_id = $1::uuid ORDER BY shared_at DESC',
        achievementId,
      );
    })) as Array<{
      id: string;
      achievement_id: string;
      shared_by: string;
      platform: 'EMAIL' | 'SOCIAL' | 'PORTFOLIO';
      shared_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      achievementId: r.achievement_id,
      sharedById: r.shared_by,
      platform: r.platform,
      sharedAt: r.shared_at,
    }));
  }

  async createShare(
    actor: ResolvedActor,
    achievementId: string,
    input: CreateAchievementShareDto,
  ): Promise<AchievementShareDto> {
    // Only the owning student or admin can share their own achievement.
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT student_id::text AS student_id FROM pfl_achievements WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        achievementId,
        tenant.schoolId,
      );
    })) as Array<{ student_id: string }>;
    if (rows.length === 0) throw new NotFoundException('Achievement not found');
    if (!actor.isSchoolAdmin) {
      if (actor.personType !== 'STUDENT') {
        throw new ForbiddenException(
          'Only students can share their own achievements. Admins may share on behalf of a student.',
        );
      }
      const callerStudentRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT s.id::text AS id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1',
          actor.personId,
        );
      })) as Array<{ id: string }>;
      if (callerStudentRows[0]?.id !== rows[0]!.student_id) {
        throw new NotFoundException('Achievement not found');
      }
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO pfl_achievement_shares (id, achievement_id, shared_by, platform) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
        id,
        achievementId,
        actor.accountId,
        input.platform,
      );
    });
    const fresh = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, achievement_id::text AS achievement_id, shared_by::text AS shared_by, platform, shared_at::text AS shared_at FROM pfl_achievement_shares WHERE id = $1::uuid LIMIT 1',
        id,
      );
    })) as Array<{
      id: string;
      achievement_id: string;
      shared_by: string;
      platform: 'EMAIL' | 'SOCIAL' | 'PORTFOLIO';
      shared_at: string;
    }>;
    const r = fresh[0]!;
    return {
      id: r.id,
      achievementId: r.achievement_id,
      sharedById: r.shared_by,
      platform: r.platform,
      sharedAt: r.shared_at,
    };
  }
}
