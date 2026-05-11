import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
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
 */
@Injectable()
export class ParentTrackingService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanIssue(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can issue parent tracking tokens',
    );
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
    this.assertCanIssue(actor);
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
      // Revoke any prior active token for this (student, route) pair
      await tx.$executeRawUnsafe(
        'UPDATE trn_parent_tracking_tokens SET is_active = false, revoked_at = now(), revoked_by = $1::uuid ' +
          'WHERE student_id = $2::uuid AND route_id = $3::uuid AND is_active = true',
        actor.accountId,
        input.studentId,
        input.routeId,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO trn_parent_tracking_tokens (id, student_id, route_id, guardian_account_id, token, expires_at, is_active) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, true)',
        id,
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
   */
  async revokeToken(
    tokenId: string,
    actor: ResolvedActor,
  ): Promise<ParentTrackingTokenResponseDto> {
    this.assertCanIssue(actor);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE trn_parent_tracking_tokens SET is_active = false, revoked_at = now(), revoked_by = $1::uuid ' +
          'WHERE id = $2::uuid AND is_active = true',
        actor.accountId,
        tokenId,
      );
      if (result === 0) {
        // Either no such token or already revoked — treat as 404
        throw new NotFoundException('Active token not found');
      }
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, student_id::text AS student_id, route_id::text AS route_id, ' +
          'guardian_account_id::text AS guardian_account_id, token, expires_at, is_active, ' +
          'revoked_at, revoked_by::text AS revoked_by, created_at ' +
          'FROM trn_parent_tracking_tokens WHERE id = $1::uuid',
        tokenId,
      );
    })) as TokenRow[];
    if (rows.length === 0) throw new NotFoundException('Token not found');
    return tokenRowToDto(rows[0]!);
  }

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
        'SELECT id::text AS id, student_id::text AS student_id, route_id::text AS route_id, ' +
          'guardian_account_id::text AS guardian_account_id, token, expires_at, is_active, ' +
          'revoked_at, revoked_by::text AS revoked_by, created_at ' +
          'FROM trn_parent_tracking_tokens WHERE student_id = $1::uuid ORDER BY created_at DESC',
        studentId,
      );
    })) as TokenRow[];
    return rows.map(tokenRowToDto);
  }

  /**
   * UNAUTHENTICATED — token-scoped read. Surfaces the bus position +
   * ETA for the child's stop and nothing else. Refuses revoked or
   * expired tokens with 410 Gone.
   */
  async viewByToken(token: string): Promise<ParentTrackingViewDto> {
    // The unauthenticated path runs at the platform level — we don't
    // have a tenant context. Resolve the tenant by walking the token
    // across every tenant schema, but the canonical approach is to
    // require a tenant subdomain header on the request and run the
    // lookup inside that tenant. For simplicity here we use the
    // tenant context that is already set on the request via the
    // tenant resolver middleware.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT t.student_id::text AS student_id, t.route_id::text AS route_id, ' +
          't.expires_at, t.is_active, ' +
          'r.name AS route_name, r.direction AS route_direction, ' +
          'r.vehicle_id::text AS vehicle_id, v.registration AS vehicle_registration ' +
          'FROM trn_parent_tracking_tokens t ' +
          'LEFT JOIN trn_routes r ON r.id = t.route_id ' +
          'LEFT JOIN trn_vehicles v ON v.id = r.vehicle_id ' +
          'WHERE t.token = $1 LIMIT 1',
        token,
      );
    })) as Array<{
      student_id: string;
      route_id: string;
      expires_at: Date;
      is_active: boolean;
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

    // Resolve latest position for the route's vehicle (if assigned)
    let vehicle: ParentTrackingViewDto['vehicle'] = null;
    if (row.vehicle_id && row.vehicle_registration) {
      const posRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT latitude::text AS lat, longitude::text AS lng, ' +
            'speed_kmh::text AS speed_kmh, heading::text AS heading, recorded_at ' +
            'FROM trn_vehicle_positions WHERE vehicle_id = $1::uuid ORDER BY recorded_at DESC LIMIT 1',
          row.vehicle_id,
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

    // Resolve the stop assigned to this student on this route
    const stopRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS stop_id, s.name AS stop_name, e.eta, e.confidence ' +
          'FROM trn_student_assignments a ' +
          'JOIN trn_stops s ON s.id = a.stop_id ' +
          'LEFT JOIN trn_vehicle_eta e ON e.stop_id = s.id AND e.vehicle_id = $3::uuid ' +
          'WHERE a.student_id = $1::uuid AND a.route_id = $2::uuid ' +
          'ORDER BY a.effective_from DESC LIMIT 1',
        row.student_id,
        row.route_id,
        row.vehicle_id ?? null,
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
