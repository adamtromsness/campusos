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
   * Find a user by email and create a session.
   * Called after IdP authentication succeeds.
   */
  async authenticateByEmail(email: string): Promise<{
    accessToken: string;
    refreshToken: string;
    user: JwtPayload;
  } | null> {
    var user = await this.prisma.platformUser.findUnique({
      where: { email: email },
      include: { person: true },
    });

    if (!user || user.accountStatus !== 'ACTIVE') {
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
   * Permission filtering: the response surfaces only the permissions held
   * within the active persona's scope chain (SCHOOL → PLATFORM). A
   * Platform Admin still receives every permission because the
   * PLATFORM-scope cache row carries them all.
   *
   * personType is intentionally absent from the response. activePersona.type
   * is the canonical replacement — same vocabulary the persona switcher
   * uses.
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

    // Permissions: union of cache codes across the active persona's
    // scope chain. With no active persona the user has nothing to do
    // yet — empty array, frontend routes to /getting-started.
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
      const cacheRows = await this.prisma.iamEffectiveAccessCache.findMany({
        where: { accountId: jwt.sub, scopeId: { in: scopeIds } },
        select: { permissionCodes: true },
      });
      const seen = new Set<string>();
      for (const row of cacheRows) {
        for (const code of row.permissionCodes) seen.add(code);
      }
      permissions = Array.from(seen).sort();
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
}
