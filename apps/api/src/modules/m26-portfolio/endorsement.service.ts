import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  isUniqueViolation,
  isOwningStudent,
  isAssignedTeacherOf,
  isLinkedGuardianOf,
  resolveStudentIdForActor,
} from './portfolio-access';
import type {
  CreateEndorsementDto,
  EndorsementDto,
  UpdateEndorsementVisibilityDto,
} from './dto/portfolio-advanced.dto';

interface EndorsementRow {
  id: string;
  portfolio_id: string;
  endorsed_by: string | null;
  endorsed_by_name: string | null;
  endorser_role: 'TEACHER' | 'COUNSELLOR' | 'MENTOR';
  skills: string[];
  comment: string;
  is_visible_on_share: boolean;
  endorsed_at: string;
  updated_at: string;
}

// REVIEW-P2C27 BLOCKING 5 — every endorsement read joins through
// pfl_portfolios so the school predicate is bound on every list /
// get / reload.
const SELECT_ENDORSEMENT_BASE = `
  SELECT
    e.id::text AS id,
    e.portfolio_id::text AS portfolio_id,
    e.endorsed_by::text AS endorsed_by,
    (SELECT ip.first_name || ' ' || ip.last_name
       FROM hr_employees emp JOIN platform.iam_person ip ON ip.id = emp.person_id
       WHERE emp.id = e.endorsed_by LIMIT 1) AS endorsed_by_name,
    e.endorser_role,
    e.skills,
    e.comment,
    e.is_visible_on_share,
    e.endorsed_at::text AS endorsed_at,
    e.updated_at::text AS updated_at
  FROM pfl_endorsements e
  JOIN pfl_portfolios p ON p.id = e.portfolio_id
`;

@Injectable()
export class EndorsementService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: EndorsementRow): EndorsementDto {
    return {
      id: r.id,
      portfolioId: r.portfolio_id,
      endorsedById: r.endorsed_by,
      endorsedByName: r.endorsed_by_name,
      endorserRole: r.endorser_role,
      skills: r.skills,
      comment: r.comment,
      isVisibleOnShare: r.is_visible_on_share,
      endorsedAt: r.endorsed_at,
      updatedAt: r.updated_at,
    };
  }

  private async loadPortfolioContext(
    portfolioId: string,
  ): Promise<{ studentId: string; visibility: string } | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT student_id::text AS student_id, visibility::text AS visibility FROM pfl_portfolios WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        portfolioId,
        tenant.schoolId,
      );
    })) as Array<{ student_id: string; visibility: string }>;
    if (rows.length === 0) return null;
    return { studentId: rows[0]!.student_id, visibility: rows[0]!.visibility };
  }

  async listForPortfolio(portfolioId: string, actor: ResolvedActor): Promise<EndorsementDto[]> {
    const ctx = await this.loadPortfolioContext(portfolioId);
    if (!ctx) throw new NotFoundException('Portfolio not found');

    const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
    const isOwner = ownerStudentId === ctx.studentId;
    const canSeeAll = isOwner || actor.isSchoolAdmin;

    if (!canSeeAll) {
      if (ctx.visibility === 'PRIVATE') throw new NotFoundException('Portfolio not found');
      if (ctx.visibility === 'TEACHER') {
        if (!(await isAssignedTeacherOf(this.tenantPrisma, actor, ctx.studentId))) {
          throw new NotFoundException('Portfolio not found');
        }
      }
      if (ctx.visibility === 'PARENT') {
        const ok =
          (await isAssignedTeacherOf(this.tenantPrisma, actor, ctx.studentId)) ||
          (await isLinkedGuardianOf(this.tenantPrisma, actor, ctx.studentId));
        if (!ok) throw new NotFoundException('Portfolio not found');
      }
    }

    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ENDORSEMENT_BASE +
          ' WHERE e.portfolio_id = $1::uuid AND p.school_id = $2::uuid ORDER BY e.endorsed_at DESC',
        portfolioId,
        tenant.schoolId,
      );
    })) as EndorsementRow[];
    return rows.filter((r) => canSeeAll || r.is_visible_on_share).map((r) => this.rowToDto(r));
  }

  async create(
    portfolioId: string,
    actor: ResolvedActor,
    input: CreateEndorsementDto,
  ): Promise<EndorsementDto> {
    if (actor.personType === 'STUDENT') {
      throw new ForbiddenException(
        'Students cannot endorse portfolios. Endorsements are written by teachers, counsellors, and mentors.',
      );
    }
    if (actor.personType === 'GUARDIAN') {
      throw new ForbiddenException(
        'Guardians cannot endorse portfolios. Endorsements are written by teachers, counsellors, and mentors.',
      );
    }
    if (actor.personType !== 'STAFF' || !actor.employeeId) {
      throw new ForbiddenException(
        'Only staff (teachers, counsellors, mentors) can write endorsements.',
      );
    }

    const ctx = await this.loadPortfolioContext(portfolioId);
    if (!ctx) throw new NotFoundException('Portfolio not found');

    if (!actor.isSchoolAdmin) {
      const isAssigned = await isAssignedTeacherOf(this.tenantPrisma, actor, ctx.studentId);
      if (!isAssigned && input.endorserRole === 'TEACHER') {
        throw new ForbiddenException(
          "Only the student's assigned teachers can endorse as TEACHER. Use COUNSELLOR or MENTOR if you do not formally teach this student.",
        );
      }
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO pfl_endorsements (id, portfolio_id, endorsed_by, endorser_role, skills, comment, is_visible_on_share) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)',
          id,
          portfolioId,
          actor.employeeId,
          input.endorserRole,
          input.skills,
          input.comment,
          input.isVisibleOnShare ?? true,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'You have already endorsed this portfolio. Edit the existing endorsement to update.',
        );
      }
      throw err;
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ENDORSEMENT_BASE + ' WHERE e.id = $1::uuid AND p.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as EndorsementRow[];
    if (rows.length === 0) throw new NotFoundException('Endorsement not found');
    return this.rowToDto(rows[0]!);
  }

  async updateVisibility(
    endorsementId: string,
    actor: ResolvedActor,
    input: UpdateEndorsementVisibilityDto,
  ): Promise<EndorsementDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        `SELECT e.id::text AS id, p.student_id::text AS student_id
         FROM pfl_endorsements e
         JOIN pfl_portfolios p ON p.id = e.portfolio_id
         WHERE e.id = $1::uuid AND p.school_id = $2::uuid
         FOR UPDATE OF e`,
        endorsementId,
        tenant.schoolId,
      )) as Array<{ id: string; student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Endorsement not found');
      if (!(await isOwningStudent(this.tenantPrisma, actor, rows[0]!.student_id))) {
        throw new ForbiddenException(
          'Only the owning student or a school admin can change endorsement visibility.',
        );
      }
      // REVIEW-P2C27 BLOCKING 5 — UPDATE joins through pfl_portfolios so the
      // school predicate is enforced on the write.
      await client.$executeRawUnsafe(
        `UPDATE pfl_endorsements AS upd
         SET is_visible_on_share = $1, updated_at = now()
         FROM pfl_portfolios p
         WHERE p.id = upd.portfolio_id
           AND upd.id = $2::uuid
           AND p.school_id = $3::uuid`,
        input.isVisibleOnShare,
        endorsementId,
        tenant.schoolId,
      );
      const after = (await client.$queryRawUnsafe(
        SELECT_ENDORSEMENT_BASE + ' WHERE e.id = $1::uuid AND p.school_id = $2::uuid',
        endorsementId,
        tenant.schoolId,
      )) as EndorsementRow[];
      if (after.length === 0) throw new NotFoundException('Endorsement not found');
      return this.rowToDto(after[0]!);
    });
  }

  async remove(endorsementId: string, actor: ResolvedActor): Promise<void> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        `SELECT e.endorsed_by::text AS endorsed_by
         FROM pfl_endorsements e
         JOIN pfl_portfolios p ON p.id = e.portfolio_id
         WHERE e.id = $1::uuid AND p.school_id = $2::uuid
         FOR UPDATE OF e`,
        endorsementId,
        tenant.schoolId,
      )) as Array<{ endorsed_by: string | null }>;
      if (rows.length === 0) throw new NotFoundException('Endorsement not found');
      const isOriginalEndorser =
        actor.personType === 'STAFF' &&
        actor.employeeId !== null &&
        actor.employeeId !== undefined &&
        actor.employeeId === rows[0]!.endorsed_by;
      if (!actor.isSchoolAdmin && !isOriginalEndorser) {
        throw new ForbiddenException(
          'Only the original endorser or a school admin can remove an endorsement.',
        );
      }
      // REVIEW-P2C27 BLOCKING 5 — DELETE joins through pfl_portfolios so the
      // school predicate is enforced on the write.
      await client.$executeRawUnsafe(
        `DELETE FROM pfl_endorsements AS del
         USING pfl_portfolios p
         WHERE p.id = del.portfolio_id
           AND del.id = $1::uuid
           AND p.school_id = $2::uuid`,
        endorsementId,
        tenant.schoolId,
      );
    });
  }
}
