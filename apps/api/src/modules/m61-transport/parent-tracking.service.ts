import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreateParentTrackingTokenDto,
  ETAConfidence,
  ParentTrackingTokenResponseDto,
  ParentTrackingViewDto,
} from './dto/gps-fleet.dto';

interface TokenRow {
  id: string;
  student_id: string;
  route_id: string;
  school_id: string;
  guardian_account_id: string | null;
  token: string;
  expires_at: Date;
  is_active: boolean;
  revoked_at: Date | null;
  revoked_by: string | null;
  created_at: Date;
}

function tokenRowToDto(r: TokenRow): ParentTrackingTokenResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    routeId: r.route_id,
    token: r.token,
    expiresAt: r.expires_at.toISOString(),
    isActive: r.is_active,
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * ParentTrackingService — unauthenticated bus-tracking view.
 *
 * The token GET path is the only unauthenticated read in the entire
 * transport module. It is scoped to a single (student, route) pair —
 * the parent sees the bus position + ETA for THEIR child's stop and
 * nothing else. No student PII leaks past the route name and the
 * stop the child boards at.
 *
 * The partial UNIQUE on (student, route) WHERE is_active=true caps
 * active tokens at one per pair. Revoking flips is_active=false +
 * stamps revoked_at — the partial WHERE releases so a fresh token
 * can land for the same pair.
 *
 * Token shape: 64-hex (32 random bytes). High entropy, URL-safe,
 * matches the Cycle 24 portfolio share token pattern.
 *
 * REVIEW-P2C11 ROUND 1 BLOCKING 4 — every token mutation and read
 * carries the school_id predicate. Migration 139 added the column
 * to trn_parent_tracking_tokens. Revoke / list / viewByToken all
 * validate that the token belongs to the calling tenant's school
 * before disclosing any data. The unauthenticated viewByToken path
 * is the only ambient-tenant lookup and the school predicate is its
 * primary defence (the public route still resolves the tenant via
 * the X-Tenant-Subdomain header in the request pipeline, so the
 * "current tenant context" is well-defined even on @Public routes).
 */
@Injectable()
export class ParentTrackingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * REVIEW-P2C11 ROUND 1 BLOCKING 6 — explicit TRN-001:write check.
   */
  private async assertCanIssue(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'trn-001:write',
      'trn-001:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only school admins or transportation staff with trn-001:write can issue parent tracking tokens',
      );
    }
  }

  /**
   * Generate a fresh token. If an active token exists for the same
   * (student, route) pair, it is revoked first so the partial UNIQUE
   * releases.
   */
  async createToken(
    input: CreateParentTrackingTokenDto,
    actor: ResolvedActor,
  ): Promise<ParentTrackingTokenResponseDto> {
    await this.assertCanIssue(actor);
    const tenant = getCurrentTenant();

    // Verify the student belongs to this school + the route belongs to this school
    const checks = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT ' +
          '(SELECT 1 FROM sis_students WHERE id = $1::uuid AND school_id = $3::uuid LIMIT 1) AS s_ok, ' +
          '(SELECT 1 FROM trn_routes WHERE id = $2::uuid AND school_id = $3::uuid LIMIT 1) AS r_ok',
        input.studentId,
        input.routeId,
        tenant.schoolId,
      );
    })) as Array<{ s_ok: number | null; r_ok: number | null }>;
    if (!checks[0]?.s_ok) {
      throw new BadRequestException('studentId does not match a student in this school');
    }
    if (!checks[0]?.r_ok) {
      throw new BadRequestException('routeId does not match a route in this school');
    }

    const expiresInDays = Math.max(1, Math.min(input.expiresInDays ?? 30, 365));
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const token = randomBytes(32).toString('hex');
    const id = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C11 BLOCKING 4 — revoke + INSERT both school-scoped.
      // The school predicate defends the partial UNIQUE release path.
      await tx.$executeRawUnsafe(
        'UPDATE trn_parent_tracking_tokens SET is_active = false, revoked_at = now(), revoked_by = $1::uuid ' +
          'WHERE school_id = $2::uuid AND student_id = $3::uuid AND route_id = $4::uuid AND is_active = true',
        actor.accountId,
        tenant.schoolId,
        input.studentId,
        input.routeId,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO trn_parent_tracking_tokens (id, school_id, student_id, route_id, guardian_account_id, token, expires_at, is_active) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::timestamptz, true)',
        id,
        tenant.schoolId,
        input.studentId,
        input.routeId,
        actor.accountId,
        token,
        expiresAt.toISOString(),
      );
    });

    return {
      id,
      studentId: input.studentId,
      routeId: input.routeId,
      token,
      expiresAt: expiresAt.toISOString(),
      isActive: true,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Revoke a token. Flips is_active=false + stamps revoked_at so the
   * multi-column revoked_chk lockstep is satisfied. The partial
   * UNIQUE on (student, route) WHERE is_active=true releases.
   *
   * REVIEW-P2C11 ROUND 1 BLOCKING 4 — UPDATE carries the school
   * predicate so a leaked token id from another school cannot be
   * revoked through this tenant's API.
   */
  async revokeToken(
    tokenId: string,
    actor: ResolvedActor,
  ): Promise<ParentTrackingTokenResponseDto> {
    await this.assertCanIssue(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE trn_parent_tracking_tokens SET is_active = false, revoked_at = now(), revoked_by = $1::uuid ' +
          'WHERE school_id = $2::uuid AND id = $3::uuid AND is_active = true',
        actor.accountId,
        tenant.schoolId,
        tokenId,
      );
      if (result === 0) {
        // Either no such token, already revoked, or cross-school — all 404.
        throw new NotFoundException('Active token not found');
      }
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, student_id::text AS student_id, ' +
          'route_id::text AS route_id, guardian_account_id::text AS guardian_account_id, ' +
          'token, expires_at, is_active, revoked_at, revoked_by::text AS revoked_by, created_at ' +
          'FROM trn_parent_tracking_tokens WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        tokenId,
      );
    })) as TokenRow[];
    if (rows.length === 0) throw new NotFoundException('Token not found');
    return tokenRowToDto(rows[0]!);
  }

  /**
   * REVIEW-P2C11 ROUND 1 BLOCKING 4 — list filters on school_id so a
   * leaked student id from another school cannot return that school's
   * tokens. The student-school validation that opens the method is
   * defence in depth; the WHERE clause carries school_id too.
   */
  async listForStudent(studentId: string): Promise<ParentTrackingTokenResponseDto[]> {
    const tenant = getCurrentTenant();
    // Verify the student belongs to this school
    const ok = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (ok.length === 0) {
      throw new NotFoundException('Student not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, student_id::text AS student_id, ' +
          'route_id::text AS route_id, guardian_account_id::text AS guardian_account_id, ' +
          'token, expires_at, is_active, revoked_at, revoked_by::text AS revoked_by, created_at ' +
          'FROM trn_parent_tracking_tokens ' +
          'WHERE school_id = $1::uuid AND student_id = $2::uuid ORDER BY created_at DESC',
        tenant.schoolId,
        studentId,
      );
    })) as TokenRow[];
    return rows.map(tokenRowToDto);
  }

  /**
   * UNAUTHENTICATED — token-scoped read. Surfaces the bus position +
   * ETA for the child's stop and nothing else. Refuses revoked or
   * expired tokens with 403.
   *
   * REVIEW-P2C11 ROUND 1 BLOCKING 4 — the lookup filters on
   * `school_id = tenant.schoolId` so a token from a different school
   * cannot resolve through this tenant's public endpoint, even though
   * the route is @Public. The tenant resolver middleware sets the
   * current tenant from the X-Tenant-Subdomain header before this
   * service runs, so the school predicate is well-defined on every
   * call. Cross-tenant attacks return 404 don't-leak-existence.
   */
  async viewByToken(token: string): Promise<ParentTrackingViewDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT t.student_id::text AS student_id, t.route_id::text AS route_id, ' +
          't.expires_at, t.is_active, t.school_id::text AS school_id, ' +
          'r.name AS route_name, r.direction AS route_direction, ' +
          'r.vehicle_id::text AS vehicle_id, v.registration AS vehicle_registration ' +
          'FROM trn_parent_tracking_tokens t ' +
          'LEFT JOIN trn_routes r ON r.id = t.route_id AND r.school_id = t.school_id ' +
          'LEFT JOIN trn_vehicles v ON v.id = r.vehicle_id AND v.school_id = t.school_id ' +
          'WHERE t.token = $1 AND t.school_id = $2::uuid LIMIT 1',
        token,
        tenant.schoolId,
      );
    })) as Array<{
      student_id: string;
      route_id: string;
      expires_at: Date;
      is_active: boolean;
      school_id: string;
      route_name: string | null;
      route_direction: string | null;
      vehicle_id: string | null;
      vehicle_registration: string | null;
    }>;
    if (rows.length === 0) {
      throw new NotFoundException('Tracking token not found');
    }
    const row = rows[0]!;
    if (!row.is_active) {
      throw new ForbiddenException('Tracking token has been revoked');
    }
    if (row.expires_at.getTime() < Date.now()) {
      throw new ForbiddenException('Tracking token has expired');
    }

    // Resolve latest position for the route's vehicle (if assigned).
    // REVIEW-P2C11 BLOCKING 4 — vehicle position lookup joins through
    // trn_vehicles so the school predicate defends the read.
    let vehicle: ParentTrackingViewDto['vehicle'] = null;
    if (row.vehicle_id && row.vehicle_registration) {
      const posRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT p.latitude::text AS lat, p.longitude::text AS lng, ' +
            'p.speed_kmh::text AS speed_kmh, p.heading::text AS heading, p.recorded_at ' +
            'FROM trn_vehicle_positions p ' +
            'JOIN trn_vehicles vv ON vv.id = p.vehicle_id ' +
            'WHERE p.vehicle_id = $1::uuid AND vv.school_id = $2::uuid ' +
            'ORDER BY p.recorded_at DESC LIMIT 1',
          row.vehicle_id,
          tenant.schoolId,
        );
      })) as Array<{
        lat: string;
        lng: string;
        speed_kmh: string | null;
        heading: string | null;
        recorded_at: Date;
      }>;
      vehicle = {
        id: row.vehicle_id,
        registration: row.vehicle_registration,
        latitude: posRows.length > 0 ? Number(posRows[0]!.lat) : null,
        longitude: posRows.length > 0 ? Number(posRows[0]!.lng) : null,
        speedKmh:
          posRows.length > 0 && posRows[0]!.speed_kmh !== null
            ? Number(posRows[0]!.speed_kmh)
            : null,
        heading:
          posRows.length > 0 && posRows[0]!.heading !== null ? Number(posRows[0]!.heading) : null,
        lastUpdatedAt: posRows.length > 0 ? posRows[0]!.recorded_at.toISOString() : null,
      };
    }

    // Resolve the stop assigned to this student on this route. The
    // join carries the route school_id so a stale assignment across
    // schools cannot leak into the parent view.
    const stopRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS stop_id, s.name AS stop_name, e.eta, e.confidence ' +
          'FROM trn_student_assignments a ' +
          'JOIN trn_stops s ON s.id = a.stop_id ' +
          'JOIN trn_routes rt ON rt.id = a.route_id ' +
          'LEFT JOIN trn_vehicle_eta e ON e.stop_id = s.id AND e.vehicle_id = $3::uuid ' +
          'WHERE a.student_id = $1::uuid AND a.route_id = $2::uuid AND rt.school_id = $4::uuid ' +
          'ORDER BY a.effective_from DESC LIMIT 1',
        row.student_id,
        row.route_id,
        row.vehicle_id ?? null,
        tenant.schoolId,
      );
    })) as Array<{
      stop_id: string;
      stop_name: string;
      eta: Date | null;
      confidence: string | null;
    }>;
    let stopEta: ParentTrackingViewDto['stopEta'] = null;
    if (stopRows.length > 0 && stopRows[0]!.stop_id) {
      const s = stopRows[0]!;
      if (s.eta) {
        const minutesUntil = Math.max(0, Math.round((s.eta.getTime() - Date.now()) / 60000));
        stopEta = {
          stopId: s.stop_id,
          stopName: s.stop_name,
          eta: s.eta.toISOString(),
          confidence: (s.confidence as ETAConfidence) ?? 'LOW',
          minutesUntilEta: minutesUntil,
        };
      } else {
        stopEta = {
          stopId: s.stop_id,
          stopName: s.stop_name,
          eta: '',
          confidence: 'LOW',
          minutesUntilEta: -1,
        };
      }
    }

    return {
      routeId: row.route_id,
      routeName: row.route_name ?? '',
      routeDirection: row.route_direction ?? '',
      vehicle,
      stopEta,
      expiresAt: row.expires_at.toISOString(),
    };
  }
}
