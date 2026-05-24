import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { sign, verify } from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';

/**
 * AuthService — Token Management
 *
 * Handles JWT access token generation, refresh token lifecycle,
 * and session tracking. CampusOS never stores passwords —
 * authentication is delegated to the external IdP (ADR-036).
 *
 * Tokens:
 * - Access token: 15-minute expiry, RS256 signed, contains user context
 * - Refresh token: 7-day expiry, HttpOnly cookie, used to silently renew
 */

export interface JwtPayload {
  sub: string; // platform_users.id
  personId: string; // iam_person.id
  email: string;
  displayName: string;
  sessionId: string;
  iat?: number;
  exp?: number;
}

export interface MeResponse {
  user: {
    id: string;
    personId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    preferredName: string | null;
    displayName: string;
  };
  activePersona: {
    id: string;
    type: string;
    label: string;
    schoolId: string | null;
    schoolName: string | null;
  } | null;
  personas: Array<{
    id: string;
    type: string;
    label: string;
    schoolId: string | null;
  }>;
  permissions: string[];
}

@Injectable()
export class AuthService {
  private jwtSecret: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly personaResolution: PersonaResolutionService,
    private readonly permissionCheck: PermissionCheckService,
  ) {
    this.jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-in-production-min-32-chars!!';
  }

  /**
   * Generate an access token for an authenticated user.
   */
  generateAccessToken(payload: JwtPayload): string {
    return sign(
      {
        sub: payload.sub,
        personId: payload.personId,
        email: payload.email,
        displayName: payload.displayName,
        sessionId: payload.sessionId,
      },
      this.jwtSecret,
      { expiresIn: '15m' },
    );
  }

  /**
   * Generate a refresh token (longer-lived, stored in HttpOnly cookie).
   */
  generateRefreshToken(userId: string, sessionId: string): string {
    return sign({ sub: userId, sessionId: sessionId, type: 'refresh' }, this.jwtSecret, {
      expiresIn: '7d',
    });
  }

  /**
   * Verify and decode a JWT token.
   */
  verifyToken(token: string): JwtPayload | null {
    try {
      return verify(token, this.jwtSecret) as JwtPayload;
    } catch (e) {
      return null;
    }
  }

  /**
   * Public self-service registration. Creates a canonical
   * iam_person + platform_users + platform_families row set and
   * returns a fresh JWT pair so the caller is auto-logged-in.
   *
   * Password is intentionally NOT stored in CampusOS — authentication
   * is delegated to the IdP (ADR-036 / Keycloak in dev). For Phase 1
   * the IdP-side user provisioning is a follow-up; today the account
   * lands at PENDING_VERIFICATION until the email-verification flow
   * lands. We still mint a session so the user can reach
   * /getting-started and start adding children / accepting invites.
   *
   * Conflicts: email is UNIQUE on platform_users; a re-registration
   * with the same email surfaces as ConflictException so the UI can
   * route the user to /login.
   */
  async register(input: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    user: JwtPayload;
  }> {
    const email = input.email.trim().toLowerCase();
    if (!email) {
      throw new HttpException('Email is required', HttpStatus.BAD_REQUEST);
    }
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    if (!firstName || !lastName) {
      throw new HttpException('First and last name are required', HttpStatus.BAD_REQUEST);
    }

    const existing = await this.prisma.platformUser.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      throw new HttpException('An account with this email already exists', HttpStatus.CONFLICT);
    }

    const personId = generateId();
    const accountId = generateId();
    const familyId = generateId();
    const memberId = generateId();
    const displayName = firstName + ' ' + lastName;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.iam_person
             (id, first_name, last_name, primary_phone, person_type, is_active, created_at)
           VALUES ($1::uuid, $2, $3, $4, 'EXTERNAL', true, now())`,
          personId,
          firstName,
          lastName,
          input.phone?.trim() || null,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_users
             (id, person_id, email, display_name, account_status, account_type,
              mfa_enabled, is_minor_account, created_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, 'PENDING_VERIFICATION', 'HUMAN',
                   false, false, now())`,
          accountId,
          personId,
          email,
          displayName,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_families (id, name, home_language, mailing_address_same)
           VALUES ($1::uuid, NULL, 'en', true)`,
          familyId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_family_members
             (id, family_id, person_id, member_role, is_primary_contact, joined_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', true, now())`,
          memberId,
          familyId,
          personId,
        );
      });
    } catch (e: any) {
      // The email-uniqueness path is caught above, but a parallel race
      // could collide. Translate 23505 to CONFLICT so the UI handles
      // it the same way.
      if (e?.meta?.code === '23505' || /unique constraint/i.test(String(e))) {
        throw new HttpException('An account with this email already exists', HttpStatus.CONFLICT);
      }
      throw e;
    }

    // Allow the account to log in immediately — the PENDING_VERIFICATION
    // status is informational for downstream gates (e.g. payment
    // workflows can require ACTIVE). authenticateByEmail's strict
    // ACTIVE check would otherwise refuse the fresh account, so we
    // mint the session inline here using the freshly-created row.
    const sessionId = generateId();
    const payload: JwtPayload = {
      sub: accountId,
      personId,
      email,
      displayName,
      sessionId,
    };
    const accessToken = this.generateAccessToken(payload);
    const refreshToken = this.generateRefreshToken(accountId, sessionId);
    await this.prisma.iamAuthEvent.create({
      data: {
        id: generateId(),
        accountId,
        eventType: 'LOGIN_SUCCESS',
        sessionId,
        eventAt: new Date(),
      },
    });
    return { accessToken, refreshToken, user: payload };
  }

  /**
   * Find a user by email and create a session.
   * Called after IdP authentication succeeds.
   *
   * `allowStatuses` controls which platform_users.account_status
   * values can authenticate. Defaults to ['ACTIVE'] for the
   * production OIDC callback. Dev-login passes ['ACTIVE',
   * 'PENDING_VERIFICATION'] so accounts freshly created through
   * /auth/register (which writes PENDING_VERIFICATION pending the
   * email-verification flow that isn't built yet) can still sign
   * in via the dev shortcut. SUSPENDED is intentionally never
   * accepted — that status means the account was explicitly
   * disabled and must not log in regardless of caller.
   */
  async authenticateByEmail(
    email: string,
    options?: { allowStatuses?: readonly string[] },
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: JwtPayload;
  } | null> {
    var user = await this.prisma.platformUser.findUnique({
      where: { email: email },
      include: { person: true },
    });

    const allowed = options?.allowStatuses ?? ['ACTIVE'];
    if (!user || !allowed.includes(user.accountStatus)) {
      return null;
    }

    // Update last seen
    await this.prisma.platformUser.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    });

    var sessionId = generateId();

    var payload: JwtPayload = {
      sub: user.id,
      personId: user.personId,
      email: user.email,
      displayName: user.displayName || user.person.firstName + ' ' + user.person.lastName,
      sessionId: sessionId,
    };

    var accessToken = this.generateAccessToken(payload);
    var refreshToken = this.generateRefreshToken(user.id, sessionId);

    // Log auth event
    await this.prisma.iamAuthEvent.create({
      data: {
        id: generateId(),
        accountId: user.id,
        eventType: 'LOGIN_SUCCESS',
        sessionId: sessionId,
        eventAt: new Date(),
      },
    });

    return { accessToken, refreshToken, user: payload };
  }

  /**
   * Refresh an access token using a valid refresh token.
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
  } | null> {
    var decoded = this.verifyToken(refreshToken);
    if (!decoded || !decoded.sub) {
      return null;
    }

    var user = await this.prisma.platformUser.findUnique({
      where: { id: decoded.sub },
      include: { person: true },
    });

    if (!user || user.accountStatus !== 'ACTIVE') {
      return null;
    }

    var payload: JwtPayload = {
      sub: user.id,
      personId: user.personId,
      email: user.email,
      displayName: user.displayName || user.person.firstName + ' ' + user.person.lastName,
      sessionId: decoded.sessionId || generateId(),
    };

    return { accessToken: this.generateAccessToken(payload) };
  }

  /**
   * /auth/me response composer — identity, personas, active persona,
   * and a permission set scoped to the active persona.
   *
   * Active persona selection:
   *   1. If `activePersonaId` is provided (from the X-Active-Persona
   *      header) and that persona belongs to the caller AND is active,
   *      use it.
   *   2. Otherwise fall back to the first persona returned by
   *      PersonaResolutionService.getActivePersonas (sorted by type, label).
   *   3. If the caller has no personas, activePersona is null and
   *      permissions are empty (the "Getting Started" state).
   *
   * Permission filtering (Codex review FIX 2): the response surfaces
   * only the permissions held within the active persona's scope chain
   * (SCHOOL → PLATFORM) AND tied to role assignments matching the
   * active persona type. Without the per-persona filter a STAFF +
   * PARENT user at the same school would see STAFF codes even after
   * switching to PARENT, because the iam_effective_access_cache row
   * collapses the union at the (account, scope) level. We pivot to a
   * fresh iam_role_assignment → role_permissions → permissions join
   * filtered by assignment.source — the closest proxy we have for
   * persona affinity. Platform Admin (sys-001:admin) wins regardless
   * via the bypass below.
   *
   * The active-persona response field replaces what the old API
   * surfaced as a flat type tag.
   */
  async getMe(jwt: JwtPayload, activePersonaId?: string): Promise<MeResponse> {
    const person = await this.prisma.iamPerson.findUnique({
      where: { id: jwt.personId },
      select: { firstName: true, lastName: true, preferredName: true },
    });

    const personas = await this.personaResolution.getActivePersonas(jwt.personId);

    let active: { id: string; type: string; label: string; schoolId: string | null } | null = null;
    if (activePersonaId) {
      const requested = personas.find((p) => p.id === activePersonaId);
      if (!requested) {
        throw new HttpException(
          'Active persona not found or not owned by user',
          HttpStatus.NOT_FOUND,
        );
      }
      active = requested;
    } else if (personas.length > 0) {
      active = personas[0]!;
    }

    let schoolName: string | null = null;
    if (active && active.schoolId) {
      const sch = await this.prisma.school.findUnique({
        where: { id: active.schoolId },
        select: { name: true },
      });
      schoolName = sch?.name ?? null;
    }

    // Permissions: persona-aware filter — see the doc comment above.
    // With no active persona the user has nothing to do yet (empty
    // array; frontend routes to /getting-started).
    let permissions: string[] = [];
    if (active) {
      const scopeIds: string[] = [];
      if (active.schoolId) {
        const chain = await this.permissionCheck.resolveScopeChain(active.schoolId);
        scopeIds.push(...chain);
      } else {
        const platformScope = await this.permissionCheck.resolvePlatformScope();
        if (platformScope) scopeIds.push(platformScope);
      }
      permissions = await this.resolvePermissionsForPersona(jwt.sub, scopeIds, active.type);
    }

    return {
      user: {
        id: jwt.sub,
        personId: jwt.personId,
        email: jwt.email,
        firstName: person?.firstName ?? null,
        lastName: person?.lastName ?? null,
        preferredName: person?.preferredName ?? null,
        displayName: jwt.displayName,
      },
      activePersona: active
        ? {
            id: active.id,
            type: active.type,
            label: active.label,
            schoolId: active.schoolId,
            schoolName,
          }
        : null,
      personas: personas.map((p) => ({
        id: p.id,
        type: p.type,
        label: p.label,
        schoolId: p.schoolId,
      })),
      permissions,
    };
  }

  /**
   * Switch the active persona. Validates ownership + active state, then
   * delegates to getMe to compose the full response with new permissions.
   */
  async switchPersona(jwt: JwtPayload, personaId: string): Promise<MeResponse> {
    if (!personaId) {
      throw new HttpException('personaId is required', HttpStatus.BAD_REQUEST);
    }
    const row = await this.prisma.platformPersona.findUnique({
      where: { id: personaId },
      select: { personId: true, isActive: true },
    });
    if (!row || row.personId !== jwt.personId || !row.isActive) {
      throw new HttpException('Persona not found', HttpStatus.NOT_FOUND);
    }
    return this.getMe(jwt, personaId);
  }

  /**
   * Persona-affinity → assignment.source mapping. The IAM model
   * doesn't tag iam_role_assignment rows with the persona type
   * directly; we approximate via the source enum:
   *
   *   STAFF      ← HR_SYNC, WORKFLOW_APPROVAL, EMERGENCY
   *                (the three sources used by employee onboarding +
   *                emergency role grants)
   *   PARENT     ← GUARDIAN_RELATIONSHIP
   *   STUDENT    ← SIS_DERIVED
   *   SUBSTITUTE / ALUMNI / COMMUNITY — left empty for now; these
   *   personas have no automatic role grants today. When the
   *   substitute / alumni / community modules grow their own role
   *   provisioning, add the matching source to this map.
   *
   * MANUAL is intentionally NOT mapped to any non-STAFF persona to
   * avoid leaking Platform Admin assignments (which are typically
   * MANUAL) into PARENT / STUDENT contexts. Platform Admin holders
   * still receive every permission via the bypass below.
   */
  private static readonly PERSONA_SOURCES: Record<string, string[]> = {
    STAFF: ['HR_SYNC', 'WORKFLOW_APPROVAL', 'EMERGENCY'],
    PARENT: ['GUARDIAN_RELATIONSHIP'],
    STUDENT: ['SIS_DERIVED'],
    SUBSTITUTE: [],
    ALUMNI: [],
    COMMUNITY: [],
  };

  private async resolvePermissionsForPersona(
    accountId: string,
    scopeIds: string[],
    personaType: string,
  ): Promise<string[]> {
    if (scopeIds.length === 0) return [];

    // Platform Admin bypass: if the user holds sys-001:admin anywhere
    // in the active scope chain — regardless of which role granted it
    // — return the full unfiltered permission set. Platform admins
    // need every permission code visible on the wire so they can
    // operate cross-persona without losing capabilities.
    const cacheRows = await this.prisma.iamEffectiveAccessCache.findMany({
      where: { accountId, scopeId: { in: scopeIds } },
      select: { permissionCodes: true },
    });
    const allCodes = new Set<string>();
    for (const r of cacheRows) for (const c of r.permissionCodes) allCodes.add(c);
    if (allCodes.has('sys-001:admin')) {
      return Array.from(allCodes).sort();
    }

    const sources = AuthService.PERSONA_SOURCES[personaType] ?? [];
    if (sources.length === 0) return [];

    const rows = await this.prisma.$queryRawUnsafe<Array<{ code: string }>>(
      `SELECT DISTINCT p.code AS code
       FROM platform.iam_role_assignment ra
       JOIN platform.role_permissions rp ON rp.role_id = ra.role_id
       JOIN platform.permissions p ON p.id = rp.permission_id
       WHERE ra.account_id = $1::uuid
         AND ra.scope_id = ANY($2::uuid[])
         AND ra.status = 'ACTIVE'
         AND (ra.effective_to IS NULL OR ra.effective_to > now())
         AND ra.source::text = ANY($3::text[])`,
      accountId,
      scopeIds,
      sources,
    );
    return rows.map((r) => r.code).sort();
  }
}
