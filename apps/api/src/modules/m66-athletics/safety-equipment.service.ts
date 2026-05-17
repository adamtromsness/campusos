import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  CreateSafetyEquipmentDto,
  SafetyEquipmentResponseDto,
  SafetyEquipmentType,
  UpdateSafetyEquipmentDto,
} from './dto/athletics-advanced.dto';

interface SafetyEquipmentRow {
  id: string;
  roster_member_id: string;
  student_name: string | null;
  equipment_type: string;
  issued: boolean;
  meets_safety_standard: boolean;
  certification_date: string | null;
  certification_expiry: string | null;
  recall_status: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SAFETY =
  'SELECT s.id::text AS id, s.roster_member_id::text AS roster_member_id, ' +
  "(p.first_name || ' ' || p.last_name) AS student_name, " +
  's.equipment_type, s.issued, s.meets_safety_standard, ' +
  "TO_CHAR(s.certification_date, 'YYYY-MM-DD') AS certification_date, " +
  "TO_CHAR(s.certification_expiry, 'YYYY-MM-DD') AS certification_expiry, " +
  's.recall_status, s.notes, ' +
  'TO_CHAR(s.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(s.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_safety_equipment s ' +
  'LEFT JOIN ath_roster_members rm ON rm.id = s.roster_member_id ' +
  'LEFT JOIN sis_students st ON st.id = rm.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = st.platform_student_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = ps.person_id ';

function complianceState(r: SafetyEquipmentRow): SafetyEquipmentResponseDto['complianceState'] {
  if (!r.issued) return 'NEUTRAL';
  if (!r.meets_safety_standard || r.recall_status) return 'ROSE';
  if (r.certification_expiry) {
    const today = new Date();
    const expiry = new Date(r.certification_expiry);
    const diffDays = (expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 0) return 'ROSE';
    if (diffDays <= 30) return 'AMBER';
  }
  return 'GREEN';
}

function rowToDto(r: SafetyEquipmentRow): SafetyEquipmentResponseDto {
  return {
    id: r.id,
    rosterMemberId: r.roster_member_id,
    studentName: r.student_name,
    equipmentType: r.equipment_type as SafetyEquipmentType,
    issued: r.issued,
    meetsSafetyStandard: r.meets_safety_standard,
    certificationDate: r.certification_date,
    certificationExpiry: r.certification_expiry,
    recallStatus: r.recall_status,
    notes: r.notes,
    complianceState: complianceState(r),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class SafetyEquipmentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async hasSafetyScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ath-004:write',
    ]);
  }

  /**
   * Verify the roster member resolves to a roster in the calling school.
   * Returns the underlying roster_id for downstream use.
   */
  private async assertMemberInTenant(memberId: string): Promise<string> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<Array<{ roster_id: string }>>(
        'SELECT m.roster_id::text AS roster_id FROM ath_roster_members m ' +
          'JOIN ath_rosters r ON r.id = m.roster_id ' +
          'JOIN ath_seasons s ON s.id = r.season_id ' +
          'JOIN ath_programmes p ON p.id = s.programme_id ' +
          'WHERE m.id = $1::uuid AND p.school_id = $2::uuid',
        memberId,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) {
      throw new BadRequestException('rosterMemberId does not match a member in this school');
    }
    return rows[0]!.roster_id;
  }

  async listForRoster(rosterId: string): Promise<SafetyEquipmentResponseDto[]> {
    const tenant = getCurrentTenant();
    // Verify roster belongs to this school
    const r = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT r.id FROM ath_rosters r JOIN ath_seasons s ON s.id = r.season_id JOIN ath_programmes p ON p.id = s.programme_id WHERE r.id = $1::uuid AND p.school_id = $2::uuid',
        rosterId,
        tenant.schoolId,
      ),
    );
    if (r.length === 0) throw new NotFoundException('Roster not found');
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<SafetyEquipmentRow[]>(
        SELECT_SAFETY +
          'WHERE rm.roster_id = $1::uuid ORDER BY p.last_name, s.equipment_type LIMIT 500',
        rosterId,
      ),
    );
    return rows.map(rowToDto);
  }

  async listExpired(): Promise<SafetyEquipmentResponseDto[]> {
    const tenant = getCurrentTenant();
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<SafetyEquipmentRow[]>(
        SELECT_SAFETY +
          'JOIN ath_rosters r ON r.id = rm.roster_id ' +
          'JOIN ath_seasons sea ON sea.id = r.season_id ' +
          'JOIN ath_programmes pr ON pr.id = sea.programme_id ' +
          'WHERE pr.school_id = $1::uuid AND s.certification_expiry IS NOT NULL AND s.certification_expiry < $2::date ' +
          'ORDER BY s.certification_expiry ASC LIMIT 200',
        tenant.schoolId,
        today,
      ),
    );
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<SafetyEquipmentResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<SafetyEquipmentRow[]>(
        SELECT_SAFETY +
          'JOIN ath_rosters r ON r.id = rm.roster_id ' +
          'JOIN ath_seasons sea ON sea.id = r.season_id ' +
          'JOIN ath_programmes pr ON pr.id = sea.programme_id ' +
          'WHERE s.id = $1::uuid AND pr.school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Safety equipment row not found');
    return rowToDto(rows[0]!);
  }

  async create(
    input: CreateSafetyEquipmentDto,
    actor: ResolvedActor,
  ): Promise<SafetyEquipmentResponseDto> {
    if (!(await this.hasSafetyScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can manage safety equipment');
    }
    await this.assertMemberInTenant(input.rosterMemberId);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext((client) =>
        client.$executeRawUnsafe(
          'INSERT INTO ath_safety_equipment (id, roster_member_id, equipment_type, issued, meets_safety_standard, certification_date, certification_expiry, recall_status, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, $8, $9)',
          id,
          input.rosterMemberId,
          input.equipmentType,
          input.issued ?? false,
          input.meetsSafetyStandard ?? true,
          input.certificationDate ?? null,
          input.certificationExpiry ?? null,
          input.recallStatus ?? false,
          input.notes ?? null,
        ),
      );
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (err?.code === '23505' || err?.meta?.code === '23505') {
        throw new BadRequestException(
          'Safety equipment row already exists for this (member, equipment_type). Use PATCH to update.',
        );
      }
      throw e;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateSafetyEquipmentDto,
    actor: ResolvedActor,
  ): Promise<SafetyEquipmentResponseDto> {
    if (!(await this.hasSafetyScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can manage safety equipment');
    }
    // Verify this row exists in this school
    await this.getById(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.issued !== undefined) {
      params.push(input.issued);
      sets.push('issued = $' + params.length);
    }
    if (input.meetsSafetyStandard !== undefined) {
      params.push(input.meetsSafetyStandard);
      sets.push('meets_safety_standard = $' + params.length);
    }
    if (input.certificationDate !== undefined) {
      params.push(input.certificationDate);
      sets.push('certification_date = $' + params.length + '::date');
    }
    if (input.certificationExpiry !== undefined) {
      params.push(input.certificationExpiry);
      sets.push('certification_expiry = $' + params.length + '::date');
    }
    if (input.recallStatus !== undefined) {
      params.push(input.recallStatus);
      sets.push('recall_status = $' + params.length);
    }
    if (input.notes !== undefined) {
      params.push(input.notes);
      sets.push('notes = $' + params.length);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    const sql =
      'UPDATE ath_safety_equipment SET ' +
      sets.join(', ') +
      ' WHERE id = $' +
      params.length +
      '::uuid';
    await this.tenantPrisma.executeInTenantContext((client) =>
      client.$executeRawUnsafe(sql, ...params),
    );
    return this.getById(id);
  }
}
