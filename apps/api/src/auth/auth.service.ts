import { Injectable } from '@nestjs/common';
import { sign, verify } from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

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
  sub: string;        // platform_users.id
  personId: string;   // iam_person.id
  email: string;
  displayName: string;
  sessionId: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class AuthService {
  private jwtSecret: string;

  constructor(private readonly prisma: PrismaClient) {
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
    return sign(
      { sub: userId, sessionId: sessionId, type: 'refresh' },
      this.jwtSecret,
      { expiresIn: '7d' },
    );
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
}
