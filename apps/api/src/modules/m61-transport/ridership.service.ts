import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { BusPassService } from './bus-pass.service';
import {
  RidershipResponseDto,
  ScanDirection,
  ScanMethod,
  ScanRidershipDto,
} from './dto/transport.dto';

interface RidershipRow {
  id: string;
  student_id: string;
  student_name: string | null;
  route_id: string;
  stop_id: string;
  stop_name: string | null;
  scan_direction: string;
  scanned_at: Date;
  scan_method: string;
}

const SELECT_RIDERSHIP_BASE =
  'SELECT r.id::text AS id, r.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_students ps ON ps.person_id = ip.id ' +
  '  JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = r.student_id) AS student_name, ' +
  'r.route_id::text AS route_id, r.stop_id::text AS stop_id, ' +
  '(SELECT name FROM trn_stops WHERE id = r.stop_id) AS stop_name, ' +
  'r.scan_direction, r.scanned_at, r.scan_method ' +
  'FROM trn_ridership_records r ';

function rowToDto(r: RidershipRow): RidershipResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    routeId: r.route_id,
    stopId: r.stop_id,
    stopName: r.stop_name,
    scanDirection: r.scan_direction as ScanDirection,
    scannedAt: r.scanned_at.toISOString(),
    scanMethod: r.scan_method as ScanMethod,
  };
}

@Injectable()
export class RidershipService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly passes: BusPassService,
  ) {}

  /**
   * QR SCAN KEYSTONE. Resolves the bus pass via the unique token,
   * validates active + within valid range, then writes a
   * trn_ridership_records row in one tenant tx.
   */
  async scan(input: ScanRidershipDto, actor: ResolvedActor): Promise<RidershipResponseDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only drivers and transportation staff can scan passes');
    }

    const resolution = await this.passes.resolveToken(input.qrCodeToken);
    if (!resolution.isValid) {
      throw new BadRequestException(resolution.reason ?? 'Invalid QR code');
    }

    // Resolve the route from the stop
    const stopRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT route_id::text AS route_id FROM trn_stops WHERE id = $1::uuid LIMIT 1',
        input.stopId,
      );
    })) as Array<{ route_id: string }>;
    if (stopRows.length === 0) {
      throw new BadRequestException('Stop not found');
    }
    const routeId = stopRows[0]!.route_id;

    // REVIEW-CYCLE19 BLOCKING 2 — verify the resolved student is
    // actually expected on this (route, stop) for today. Accepts a
    // permanent assignment OR an `is_override = true` row from an
    // approved route-change request. The assignment direction must
    // match the scan direction or be `BOTH`. Excludes students with
    // an APPROVED `NO_BUS` change request for today (those students
    // are not on the bus by parent request — a scan is operator
    // error).
    const today = new Date().toISOString().slice(0, 10);
    const assigned = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.is_override, a.direction ' +
          'FROM trn_student_assignments a ' +
          'WHERE a.student_id = $1::uuid ' +
          '  AND a.route_id = $2::uuid ' +
          '  AND a.stop_id = $3::uuid ' +
          '  AND a.effective_from <= $4::date ' +
          '  AND (a.effective_to IS NULL OR a.effective_to >= $4::date) ' +
          '  AND NOT EXISTS (' +
          '    SELECT 1 FROM trn_route_change_requests rcr ' +
          '    WHERE rcr.student_id = a.student_id ' +
          '      AND rcr.change_date = $4::date ' +
          "      AND rcr.status = 'APPROVED' " +
          "      AND rcr.change_type = 'NO_BUS'" +
          '  ) ' +
          'ORDER BY a.is_override DESC ' +
          'LIMIT 1',
        resolution.studentId,
        routeId,
        input.stopId,
        today,
      );
    })) as Array<{ id: string; is_override: boolean; direction: string }>;
    if (assigned.length === 0) {
      throw new BadRequestException(
        'Scanned student is not assigned to this stop for today. Verify the bus pass + stop, or submit a route-change request.',
      );
    }
    const assignmentDirection = assigned[0]!.direction;
    if (assignmentDirection !== 'BOTH') {
      const wantsBoarding = input.scanDirection === 'BOARDING';
      const isAm = assignmentDirection === 'AM';
      // AM routes board in the morning + alight at school. PM routes
      // are reversed. Mismatched scan direction is operator error.
      if ((isAm && !wantsBoarding) || (!isAm && wantsBoarding)) {
        throw new BadRequestException(
          'Scan direction does not match the assignment direction (' + assignmentDirection + ').',
        );
      }
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_ridership_records (id, student_id, route_id, stop_id, scan_direction, scanned_at, scanned_by, scan_method, bus_pass_id) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now(), $6::uuid, 'QR_CODE', $7::uuid)",
        id,
        resolution.studentId,
        routeId,
        input.stopId,
        input.scanDirection,
        actor.accountId,
        resolution.passId,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_RIDERSHIP_BASE + 'WHERE r.id = $1::uuid LIMIT 1', id);
    })) as RidershipRow[];
    return rowToDto(rows[0]!);
  }

  async listForRoute(
    routeId: string,
    args: { date?: string },
    actor: ResolvedActor,
  ): Promise<RidershipResponseDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only admins or staff can read ridership reports');
    }
    const where: string[] = ['r.route_id = $1::uuid'];
    const params: unknown[] = [routeId];
    if (args.date) {
      where.push('r.scanned_at::date = $' + (params.length + 1) + '::date');
      params.push(args.date);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_RIDERSHIP_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY r.scanned_at DESC LIMIT 500',
        ...params,
      );
    })) as RidershipRow[];
    return rows.map(rowToDto);
  }

  async myRidership(actor: ResolvedActor): Promise<RidershipResponseDto[]> {
    if (actor.personType === 'STUDENT') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          SELECT_RIDERSHIP_BASE +
            'WHERE r.student_id IN (' +
            '  SELECT s.id FROM sis_students s ' +
            '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            '  WHERE ps.person_id = $1::uuid' +
            ') ORDER BY r.scanned_at DESC LIMIT 60',
          actor.personId,
        );
      })) as RidershipRow[];
      return rows.map(rowToDto);
    }
    if (actor.personType === 'GUARDIAN') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          SELECT_RIDERSHIP_BASE +
            'WHERE r.student_id IN (' +
            '  SELECT sg.student_id FROM sis_student_guardians sg ' +
            '  JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            '  WHERE g.person_id = $1::uuid' +
            ') ORDER BY r.scanned_at DESC LIMIT 60',
          actor.personId,
        );
      })) as RidershipRow[];
      return rows.map(rowToDto);
    }
    return [];
  }

  /**
   * Used by NoShowWorker to check whether a given (student, route,
   * date, direction) has a BOARDING scan recorded already today.
   */
  async hasBoardingScan(studentId: string, routeId: string, dateIso: string): Promise<boolean> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT 1 AS ok FROM trn_ridership_records WHERE student_id = $1::uuid AND route_id = $2::uuid AND scan_direction = 'BOARDING' AND scanned_at::date = $3::date LIMIT 1",
        studentId,
        routeId,
        dateIso,
      );
    })) as Array<{ ok: number }>;
    return rows.length > 0;
  }
}
