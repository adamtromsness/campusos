import { BadRequestException, Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import {
  SlaPolicyResponseDto,
  SlaSnapshotDto,
  TicketPriority,
  UpsertSlaPolicyDto,
} from './dto/ticket.dto';

interface SlaPolicyRow {
  id: string;
  school_id: string;
  category_id: string;
  category_name: string;
  priority: string;
  response_hours: number;
  resolution_hours: number;
}

interface TicketSlaInputs {
  createdAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  responseHours: number | null;
  resolutionHours: number | null;
}

const HOUR_MS = 60 * 60 * 1000;

const SELECT_SLA_BASE =
  'SELECT sla.id::text AS id, sla.school_id::text AS school_id, ' +
  'sla.category_id::text AS category_id, c.name AS category_name, ' +
  'sla.priority, sla.response_hours, sla.resolution_hours ' +
  'FROM tkt_sla_policies sla ' +
  'JOIN tkt_categories c ON c.id = sla.category_id ';

function rowToDto(r: SlaPolicyRow): SlaPolicyResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    categoryId: r.category_id,
    categoryName: r.category_name,
    priority: r.priority as TicketPriority,
    responseHours: r.response_hours,
    resolutionHours: r.resolution_hours,
  };
}

@Injectable()
export class SlaService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Full SLA matrix for the school. Sorted by category then priority urgency.
   */
  async list(): Promise<SlaPolicyResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SlaPolicyRow[]>(
        SELECT_SLA_BASE +
          "ORDER BY c.name, CASE sla.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END",
      );
    });
    return rows.map(rowToDto);
  }

  /**
   * Upsert by (school, category, priority). The schema's unique index
   * lets us write either an INSERT or an UPDATE depending on whether a
   * row already exists. Returns the resulting policy.
   */
  async upsert(input: UpsertSlaPolicyDto): Promise<SlaPolicyResponseDto> {
    const tenant = getCurrentTenant();
    if (input.resolutionHours < input.responseHours) {
      throw new BadRequestException(
        'resolutionHours must be greater than or equal to responseHours',
      );
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const existing = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM tkt_sla_policies WHERE school_id = $1::uuid AND category_id = $2::uuid AND priority = $3 LIMIT 1',
        tenant.schoolId,
        input.categoryId,
        input.priority,
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        await client.$executeRawUnsafe(
          'UPDATE tkt_sla_policies SET response_hours = $1, resolution_hours = $2, updated_at = now() WHERE id = $3::uuid',
          input.responseHours,
          input.resolutionHours,
          existing[0]!.id,
        );
      } else {
        await client.$executeRawUnsafe(
          'INSERT INTO tkt_sla_policies (id, school_id, category_id, priority, response_hours, resolution_hours) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
          generateId(),
          tenant.schoolId,
          input.categoryId,
          input.priority,
          input.responseHours,
          input.resolutionHours,
        );
      }
    });
    const all = await this.list();
    const match = all.find(
      (p) => p.categoryId === input.categoryId && p.priority === input.priority,
    );
    if (!match) {
      // Should not happen — upsert guarantees the row exists.
      throw new BadRequestException('Policy upsert succeeded but row could not be re-read');
    }
    return match;
  }

  /**
   * Look up the policy id for (school, category, priority). Returns null
   * when no policy is configured. TicketService uses this at submission
   * time to denormalise sla_policy_id onto the ticket row.
   */
  async lookupPolicyId(
    categoryId: string,
    priority: TicketPriority,
  ): Promise<{ id: string; responseHours: number; resolutionHours: number } | null> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{ id: string; response_hours: number; resolution_hours: number }>
      >(
        'SELECT id::text AS id, response_hours, resolution_hours FROM tkt_sla_policies ' +
          'WHERE school_id = $1::uuid AND category_id = $2::uuid AND priority = $3 LIMIT 1',
        tenant.schoolId,
        categoryId,
        priority,
      );
    });
    if (rows.length === 0) return null;
    return {
      id: rows[0]!.id,
      responseHours: rows[0]!.response_hours,
      resolutionHours: rows[0]!.resolution_hours,
    };
  }

  /**
   * Compute the SLA breach snapshot for a ticket. Pure function over the
   * timestamps + policy hours; no DB access. The clock is computed not
   * stored — admin UI calls this at read time so the response is always
   * up-to-date with the wall clock.
   */
  static computeSnapshot(input: TicketSlaInputs, policyId: string | null): SlaSnapshotDto {
    const now = Date.now();
    const createdMs = Date.parse(input.createdAt);
    const responseHours = input.responseHours;
    const resolutionHours = input.resolutionHours;

    let responseBreached = false;
    let responseHoursRemaining: number | null = null;
    if (responseHours !== null) {
      if (input.firstResponseAt !== null) {
        // First response already landed — no further breach risk on response.
        responseHoursRemaining = null;
      } else {
        const elapsedHours = (now - createdMs) / HOUR_MS;
        responseHoursRemaining = +(responseHours - elapsedHours).toFixed(2);
        responseBreached = responseHoursRemaining < 0;
      }
    }

    let resolutionBreached = false;
    let resolutionHoursRemaining: number | null = null;
    if (resolutionHours !== null) {
      if (input.resolvedAt !== null) {
        resolutionHoursRemaining = null;
      } else {
        const elapsedHours = (now - createdMs) / HOUR_MS;
        resolutionHoursRemaining = +(resolutionHours - elapsedHours).toFixed(2);
        resolutionBreached = resolutionHoursRemaining < 0;
      }
    }

    return {
      policyId,
      responseHours,
      resolutionHours,
      responseBreached,
      resolutionBreached,
      responseHoursRemaining,
      resolutionHoursRemaining,
    };
  }
}
