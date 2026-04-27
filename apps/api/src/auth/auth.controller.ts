import { Controller, Get, Post, Body, Res, Req, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Response, Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

/**
 * Auth Controller
 *
 * Handles authentication flows:
 * - /auth/login → redirects to IdP (Keycloak) for OIDC auth
 * - /auth/callback → handles IdP callback, issues tokens
 * - /auth/refresh → silently refreshes access token via refresh cookie
 * - /auth/logout → revokes session
 * - /auth/dev-login → direct email login for local development only
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaClient,
  ) {}

  /**
   * Redirect to Keycloak for OIDC authentication.
   */
  @Public()
  @Get('login')
  @ApiOperation({ summary: 'Redirect to IdP for authentication' })
  login(@Res() res: Response) {
    var issuer = process.env.OIDC_ISSUER || 'http://localhost:8080/realms/campusos';
    var clientId = process.env.OIDC_CLIENT_ID || 'campusos-api';
    var redirectUri = encodeURIComponent(
      (process.env.API_BASE_URL || 'http://localhost:4000') + '/api/v1/auth/callback',
    );

    var authUrl =
      issuer +
      '/protocol/openid-connect/auth' +
      '?client_id=' +
      clientId +
      '&response_type=code' +
      '&scope=openid%20email%20profile' +
      '&redirect_uri=' +
      redirectUri;

    res.redirect(authUrl);
  }

  /**
   * Handle OIDC callback from Keycloak.
   * Exchanges auth code for tokens, then issues CampusOS JWT.
   */
  @Public()
  @Get('callback')
  @ApiOperation({ summary: 'OIDC callback — exchanges code for tokens' })
  async callback(@Req() req: Request, @Res() res: Response) {
    var code = req.query.code as string;

    if (!code) {
      throw new HttpException('No authorization code provided', HttpStatus.BAD_REQUEST);
    }

    // Exchange code for tokens with Keycloak
    var issuer = process.env.OIDC_ISSUER || 'http://localhost:8080/realms/campusos';
    var tokenUrl = issuer + '/protocol/openid-connect/token';

    var tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: process.env.OIDC_CLIENT_ID || 'campusos-api',
        client_secret: process.env.OIDC_CLIENT_SECRET || 'campusos-dev-secret',
        redirect_uri:
          (process.env.API_BASE_URL || 'http://localhost:4000') + '/api/v1/auth/callback',
      }).toString(),
    });

    if (!tokenResponse.ok) {
      throw new HttpException('Failed to exchange authorization code', HttpStatus.UNAUTHORIZED);
    }

    var tokenData = (await tokenResponse.json()) as any;

    // Get user info from Keycloak
    var userInfoResponse = await fetch(issuer + '/protocol/openid-connect/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token },
    });

    if (!userInfoResponse.ok) {
      throw new HttpException('Failed to get user info from IdP', HttpStatus.UNAUTHORIZED);
    }

    var userInfo = (await userInfoResponse.json()) as any;
    var email = userInfo.email as string;

    if (!email) {
      throw new HttpException('No email in IdP response', HttpStatus.UNAUTHORIZED);
    }

    // Authenticate in CampusOS
    var result = await this.authService.authenticateByEmail(email);

    if (!result) {
      throw new HttpException('User not found or account inactive: ' + email, HttpStatus.FORBIDDEN);
    }

    // Set refresh token as HttpOnly cookie
    res.cookie('campusos_refresh', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/api/v1/auth',
    });

    // Redirect to frontend with access token
    var frontendUrl = process.env.CORS_ORIGIN || 'http://localhost:3000';
    res.redirect(frontendUrl + '?token=' + result.accessToken);
  }

  /**
   * Refresh access token using the HttpOnly refresh cookie.
   */
  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(@Req() req: Request) {
    var refreshToken = req.cookies?.campusos_refresh;

    if (!refreshToken) {
      throw new HttpException('No refresh token', HttpStatus.UNAUTHORIZED);
    }

    var result = await this.authService.refreshAccessToken(refreshToken);

    if (!result) {
      throw new HttpException('Invalid or expired refresh token', HttpStatus.UNAUTHORIZED);
    }

    return { accessToken: result.accessToken };
  }

  /**
   * Logout — clears the refresh cookie.
   */
  @Public()
  @Post('logout')
  @ApiOperation({ summary: 'Logout and clear session' })
  async logout(@Res() res: Response) {
    res.clearCookie('campusos_refresh', { path: '/api/v1/auth' });
    res.json({ message: 'Logged out' });
  }

  /**
   * Dev-only: direct login by email.
   * Skips IdP entirely — for API testing with curl/Postman.
   * DISABLED in production.
   */
  @Public()
  @Post('dev-login')
  @ApiOperation({ summary: 'Dev-only direct login by email (no IdP)' })
  async devLogin(@Body() body: { email: string }, @Res() res: Response) {
    if (process.env.NODE_ENV === 'production') {
      throw new HttpException('Dev login is not available in production', HttpStatus.FORBIDDEN);
    }

    if (!body.email) {
      throw new HttpException('Email is required', HttpStatus.BAD_REQUEST);
    }

    var result = await this.authService.authenticateByEmail(body.email);

    if (!result) {
      throw new HttpException('User not found: ' + body.email, HttpStatus.NOT_FOUND);
    }

    // Set refresh cookie
    res.cookie('campusos_refresh', result.refreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/v1/auth',
    });

    res.json({
      accessToken: result.accessToken,
      user: {
        id: result.user.sub,
        personId: result.user.personId,
        email: result.user.email,
        displayName: result.user.displayName,
      },
    });
  }

  /**
   * Get current authenticated user — identity, persona, and permission codes.
   *
   * personType drives persona-aware UI (teacher dashboard vs parent dashboard).
   * permissions is the union of permission codes across the user's scope cache
   * rows; the web client uses it for menu gating only — the backend guards
   * remain the authoritative access check on every protected request.
   */
  @Get('me')
  @ApiOperation({ summary: 'Get current authenticated user' })
  async me(@Req() req: Request) {
    var user = (req as any).user;

    var person = await this.prisma.iamPerson.findUnique({
      where: { id: user.personId },
      select: { personType: true, firstName: true, lastName: true, preferredName: true },
    });

    var caches = await this.prisma.iamEffectiveAccessCache.findMany({
      where: { accountId: user.sub },
      select: { permissionCodes: true },
    });

    var permSet = new Set<string>();
    for (var i = 0; i < caches.length; i++) {
      var codes = caches[i]!.permissionCodes;
      for (var j = 0; j < codes.length; j++) {
        permSet.add(codes[j] as string);
      }
    }

    return {
      id: user.sub,
      personId: user.personId,
      email: user.email,
      displayName: user.displayName,
      personType: person?.personType ?? null,
      firstName: person?.firstName ?? null,
      lastName: person?.lastName ?? null,
      preferredName: person?.preferredName ?? null,
      permissions: Array.from(permSet).sort(),
    };
  }
}
