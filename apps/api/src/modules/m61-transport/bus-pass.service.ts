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
  BusPassResponseDto,
  CreateBusPassDto,
  PassType,
  UpdateBusPassDto,
} from './dto/transport.dto';
import { randomBytes } from 'crypto';

interface PassRow {
  id: string;
  student_id: string;
  student_name: string | null;
  pass_type: string;
  qr_code_token: string;
  is_active: boolean;
  valid_from: Date;
  valid_to: Date;
  issued_at: Date;
}

const SELECT_PASS_BASE =
  'SELECT p.id::text AS id, p.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_students ps ON ps.person_id = ip.id ' +
  '  JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = p.student_id) AS student_name, ' +
  'p.pass_type, p.qr_code_token, p.is_active, p.valid_from, p.valid_to, p.issued_at ' +
  'FROM trn_bus_passes p ';

function rowToDto(r: PassRow): BusPassResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    passType: r.pass_type as PassType,
    qrCodeToken: r.qr_code_token,
    isActive: r.is_active,
    validFrom: r.valid_from.toISOString().slice(0, 10),
    validTo: r.valid_to.toISOString().slice(0, 10),
    issuedAt: r.issued_at.toISOString(),
  };
}

@Injectable()
export class BusPassService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException('Only school admins or staff can manage bus passes');
  }

  async list(actor: ResolvedActor): Promise<BusPassResponseDto[]> {
    this.assertCanManage(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PASS_BASE + 'WHERE p.is_active = true ORDER BY p.issued_at DESC LIMIT 200',
      );
    })) as PassRow[];
    return rows.map(rowToDto);
  }

  async getById(passId: string): Promise<BusPassResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_PASS_BASE + 'WHERE p.id = $1::uuid LIMIT 1', passId);
    })) as PassRow[];
    if (rows.length === 0) throw new NotFoundException('Bus pass not found');
    return rowToDto(rows[0]!);
  }

  async myPass(actor: ResolvedActor): Promise<BusPassResponseDto[]> {
    if (actor.personType === 'STUDENT') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          SELECT_PASS_BASE +
            'WHERE p.is_active = true AND p.student_id IN (' +
            '  SELECT s.id FROM sis_students s ' +
            '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            '  WHERE ps.person_id = $1::uuid' +
            ') ORDER BY p.issued_at DESC',
          actor.personId,
        );
      })) as PassRow[];
      return rows.map(rowToDto);
    }
    if (actor.personType === 'GUARDIAN') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          SELECT_PASS_BASE +
            'WHERE p.is_active = true AND p.student_id IN (' +
            '  SELECT sg.student_id FROM sis_student_guardians sg ' +
            '  JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            '  WHERE g.person_id = $1::uuid' +
            ') ORDER BY p.issued_at DESC',
          actor.personId,
        );
      })) as PassRow[];
      return rows.map(rowToDto);
    }
    return [];
  }

  async create(input: CreateBusPassDto, actor: ResolvedActor): Promise<BusPassResponseDto> {
    this.assertCanManage(actor);
    const studentCheck = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      );
    })) as Array<{ ok: number }>;
    if (studentCheck.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }

    const id = generateId();
    const token = 'BPS-' + randomBytes(12).toString('hex').toUpperCase();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_bus_passes (id, student_id, academic_year_id, pass_type, qr_code_token, is_active, valid_from, valid_to, issued_by, issued_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, true, $6::date, $7::date, $8::uuid, now())',
        id,
        input.studentId,
        input.academicYearId ?? null,
        input.passType,
        token,
        input.validFrom,
        input.validTo,
        actor.accountId,
      );
    });
    return this.getById(id);
  }

  async patch(
    passId: string,
    input: UpdateBusPassDto,
    actor: ResolvedActor,
  ): Promise<BusPassResponseDto> {
    this.assertCanManage(actor);
    if (input.isActive === undefined) return this.getById(passId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE trn_bus_passes SET is_active = $1 WHERE id = $2::uuid',
        input.isActive,
        passId,
      );
    });
    return this.getById(passId);
  }

  /**
   * Resolve a QR token to its pass + student, validating active +
   * within the valid date window. Used by RidershipService.scan.
   */
  async resolveToken(token: string): Promise<{
    passId: string;
    studentId: string;
    isValid: boolean;
    reason?: string;
  }> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, student_id::text AS student_id, is_active, valid_from, valid_to ' +
          'FROM trn_bus_passes WHERE qr_code_token = $1 LIMIT 1',
        token,
      );
    })) as Array<{
      id: string;
      student_id: string;
      is_active: boolean;
      valid_from: Date;
      valid_to: Date;
    }>;
    if (rows.length === 0) {
      return { passId: '', studentId: '', isValid: false, reason: 'Unknown QR code' };
    }
    const r = rows[0]!;
    if (!r.is_active) {
      return {
        passId: r.id,
        studentId: r.student_id,
        isValid: false,
        reason: 'Pass is inactive',
      };
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (today < r.valid_from || today > r.valid_to) {
      return {
        passId: r.id,
        studentId: r.student_id,
        isValid: false,
        reason: 'Pass is outside its valid date range',
      };
    }
    return { passId: r.id, studentId: r.student_id, isValid: true };
  }
}
