import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import type {
  AchievementDto,
  CreateShareDto,
  PublicPortfolioViewDto,
  ShareDto,
  ShareStatus,
} from './dto/portfolio.dto';
import { PortfolioService } from './portfolio.service';

interface ShareRow {
  id: string;
  portfolio_id: string;
  share_token: string;
  expires_at: string | null;
  recipient_email: string | null;
  viewed_at: string | null;
  status: ShareStatus;
  created_at: string;
}

@Injectable()
export class ShareService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly portfolios: PortfolioService,
  ) {}

  private rowToDto(r: ShareRow): ShareDto {
    return {
      id: r.id,
      portfolioId: r.portfolio_id,
      shareToken: r.share_token,
      expiresAt: r.expires_at,
      recipientEmail: r.recipient_email,
      viewedAt: r.viewed_at,
      status: r.status,
      createdAt: r.created_at,
    };
  }

  async listForPortfolio(actor: ResolvedActor, portfolioId: string): Promise<ShareDto[]> {
    // BLOCKING 2 (REVIEW-CYCLE24) — gate the share-token list to owner+admin
    // BEFORE returning rows. share_token is a bearer credential; even one
    // existing share row would have leaked the active token to any reader
    // with ach-002:read. Now: load the portfolio first, validate caller is
    // the owning student or admin, and only then surface the rows.
    const tenant = getCurrentTenant();
    const exists = await this.portfolios.loadByIdRaw(portfolioId);
    if (!exists) throw new NotFoundException('Portfolio not found');
    const ownerStudentId = exists.student_id;
    const callerStudentRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
    })) as Array<{ id: string }>;
    const callerStudentId = callerStudentRows[0]?.id;
    if (!actor.isSchoolAdmin && callerStudentId !== ownerStudentId) {
      // Collapse to 404 don't-leak-existence — non-owner non-admin should
      // not be able to distinguish a portfolio with shares from one without.
      throw new NotFoundException('Portfolio not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.portfolio_id::text AS portfolio_id, s.share_token, s.expires_at::text AS expires_at, s.recipient_email, s.viewed_at::text AS viewed_at, s.status, s.created_at::text AS created_at FROM pfl_portfolio_shares s JOIN pfl_portfolios p ON p.id = s.portfolio_id WHERE s.portfolio_id = $1::uuid AND p.school_id = $2::uuid ORDER BY s.created_at DESC',
        portfolioId,
        tenant.schoolId,
      );
    })) as ShareRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async create(
    actor: ResolvedActor,
    portfolioId: string,
    input: CreateShareDto,
  ): Promise<ShareDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT student_id::text AS student_id FROM pfl_portfolios WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        portfolioId,
        tenant.schoolId,
      )) as Array<{ student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Portfolio not found');
      const studentId = rows[0]!.student_id;
      const callerStudentRows = (await client.$queryRawUnsafe(
        'SELECT s.id::text AS id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      )) as Array<{ id: string }>;
      const callerStudentId = callerStudentRows[0]?.id;
      if (!actor.isSchoolAdmin && callerStudentId !== studentId) {
        throw new ForbiddenException('Only the owning student or admin can generate share links.');
      }

      const token = randomBytes(32).toString('hex');
      const id = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO pfl_portfolio_shares (id, portfolio_id, share_token, expires_at, recipient_email, status, created_by) VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5, $6, $7::uuid)',
        id,
        portfolioId,
        token,
        input.expiresAt ?? null,
        input.recipientEmail ?? null,
        'ACTIVE',
        actor.accountId,
      );
      // Make sure share_link_enabled flag is true so the UI knows the surface is on.
      await client.$executeRawUnsafe(
        'UPDATE pfl_portfolios SET share_link_enabled = true, updated_at = now() WHERE id = $1::uuid',
        portfolioId,
      );
      const fresh = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, portfolio_id::text AS portfolio_id, share_token, expires_at::text AS expires_at, recipient_email, viewed_at::text AS viewed_at, status, created_at::text AS created_at FROM pfl_portfolio_shares WHERE id = $1::uuid LIMIT 1',
        id,
      )) as ShareRow[];
      return this.rowToDto(fresh[0]!);
    });
  }

  async revoke(actor: ResolvedActor, shareId: string): Promise<void> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT p.student_id::text AS student_id FROM pfl_portfolio_shares s JOIN pfl_portfolios p ON p.id = s.portfolio_id WHERE s.id = $1::uuid AND p.school_id = $2::uuid FOR UPDATE OF s',
        shareId,
        tenant.schoolId,
      )) as Array<{ student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Share not found');
      const callerStudentRows = (await client.$queryRawUnsafe(
        'SELECT s.id::text AS id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      )) as Array<{ id: string }>;
      const callerStudentId = callerStudentRows[0]?.id;
      if (!actor.isSchoolAdmin && callerStudentId !== rows[0]!.student_id) {
        throw new ForbiddenException('Only the owning student or admin can revoke share links.');
      }
      await client.$executeRawUnsafe(
        "UPDATE pfl_portfolio_shares SET status = 'REVOKED' WHERE id = $1::uuid",
        shareId,
      );
    });
  }

  // Public unauthenticated endpoint. Stamps viewed_at on first view.
  // Returns 410 Gone for expired/revoked tokens.
  async viewByToken(token: string): Promise<PublicPortfolioViewDto> {
    if (!token || token.length < 16) {
      throw new BadRequestException('Invalid share token');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, portfolio_id::text AS portfolio_id, expires_at::text AS expires_at, status FROM pfl_portfolio_shares WHERE share_token = $1 LIMIT 1 FOR UPDATE',
        token,
      )) as Array<{
        id: string;
        portfolio_id: string;
        expires_at: string | null;
        status: ShareStatus;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Share link not found');
      }
      const r = rows[0]!;
      if (r.status === 'REVOKED') {
        throw new GoneException('This share link has been revoked.');
      }
      if (r.expires_at && new Date(r.expires_at) < new Date()) {
        // Auto-flip ACTIVE -> EXPIRED if past expiry
        if (r.status === 'ACTIVE') {
          await client.$executeRawUnsafe(
            "UPDATE pfl_portfolio_shares SET status = 'EXPIRED' WHERE id = $1::uuid",
            r.id,
          );
        }
        throw new GoneException('This share link has expired.');
      }
      if (r.status === 'EXPIRED') {
        throw new GoneException('This share link has expired.');
      }

      // Stamp viewed_at on first view (idempotent — only sets if currently NULL).
      await client.$executeRawUnsafe(
        'UPDATE pfl_portfolio_shares SET viewed_at = COALESCE(viewed_at, now()) WHERE id = $1::uuid',
        r.id,
      );

      // Load portfolio + items + achievements (bypassing visibility checks since
      // the share token is the access gate).
      const portfolioRows = (await client.$queryRawUnsafe(
        'SELECT p.id::text AS portfolio_id, p.title, p.description, ' +
          "(SELECT ip.first_name || ' ' || ip.last_name FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.iam_person ip ON ip.id = ps.person_id WHERE s.id = p.student_id LIMIT 1) AS student_name, " +
          'p.student_id::text AS student_id, p.school_id::text AS school_id, ' +
          '(SELECT name FROM platform.schools WHERE id = p.school_id LIMIT 1) AS school_name ' +
          'FROM pfl_portfolios p WHERE p.id = $1::uuid LIMIT 1',
        r.portfolio_id,
      )) as Array<{
        portfolio_id: string;
        title: string;
        description: string | null;
        student_name: string | null;
        student_id: string;
        school_id: string;
        school_name: string | null;
      }>;
      if (portfolioRows.length === 0) {
        throw new NotFoundException('Portfolio not found');
      }
      const p = portfolioRows[0]!;

      // MAJOR 6 (REVIEW-CYCLE24) — public share view strips internal-only
      // fields. Raw S3 keys are internal storage paths (not signed URLs);
      // sourceRefId would let an unauthenticated viewer probe internal
      // tenant UUIDs. Both are nulled for the public surface. When file
      // download lands as a future polish, the public API should sign a
      // short-lived URL on demand, never expose the raw key.
      const rawItems = await this.portfolios.listItemsInternal(p.portfolio_id);
      const items = rawItems.map((i) => ({
        ...i,
        s3Key: null,
        sourceRefId: null,
      }));
      const featuredItems = items.filter((i) => i.isFeatured);

      const achievementRows = (await client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.student_id::text AS student_id, a.school_id::text AS school_id, a.title, a.achievement_type, a.source_module, a.source_ref_id::text AS source_ref_id, a.awarded_at::text AS awarded_at, a.awarded_by::text AS awarded_by_id, a.description, a.badge_image_url, a.created_at::text AS created_at, ' +
          "(SELECT ip2.first_name || ' ' || ip2.last_name FROM hr_employees e JOIN platform.iam_person ip2 ON ip2.id = e.person_id WHERE e.id = a.awarded_by LIMIT 1) AS awarded_by_name, " +
          "(SELECT ip3.first_name || ' ' || ip3.last_name FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.iam_person ip3 ON ip3.id = ps.person_id WHERE s.id = a.student_id LIMIT 1) AS student_name, " +
          '(SELECT COUNT(*)::int FROM pfl_achievement_shares sh WHERE sh.achievement_id = a.id) AS share_count ' +
          'FROM pfl_achievements a WHERE a.student_id = $1::uuid AND a.school_id = $2::uuid ORDER BY a.awarded_at DESC',
        p.student_id,
        p.school_id,
      )) as Array<{
        id: string;
        student_id: string;
        school_id: string;
        title: string;
        achievement_type: AchievementDto['achievementType'];
        source_module: string | null;
        source_ref_id: string | null;
        awarded_at: string;
        awarded_by_id: string | null;
        awarded_by_name: string | null;
        student_name: string | null;
        description: string | null;
        badge_image_url: string | null;
        share_count: number;
        created_at: string;
      }>;
      const achievements: AchievementDto[] = achievementRows.map((row) => ({
        id: row.id,
        studentId: row.student_id,
        studentName: row.student_name,
        schoolId: row.school_id,
        title: row.title,
        achievementType: row.achievement_type,
        sourceModule: row.source_module,
        sourceRefId: row.source_ref_id,
        awardedAt: row.awarded_at,
        awardedById: row.awarded_by_id,
        awardedByName: row.awarded_by_name,
        description: row.description,
        badgeImageUrl: row.badge_image_url,
        shareCount: Number(row.share_count),
        createdAt: row.created_at,
      }));

      const out: PublicPortfolioViewDto = {
        portfolioId: p.portfolio_id,
        studentName: p.student_name,
        title: p.title,
        description: p.description,
        schoolName: p.school_name,
        featuredItems,
        items,
        achievements,
      };
      return out;
    });
  }
}
