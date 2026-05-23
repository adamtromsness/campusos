import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '@shared/auth';
import { InvitationService } from './invitation.service';
import {
  AcceptInvitationResultDto,
  InvitationSummaryDto,
  MyInvitationDto,
} from '@modules/m00-platform/households/dto/family-child.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * /invitations — generic acceptance surface for platform_invitations.
 *
 * GET /:token is `@Public()` because the token IS the auth — landing
 * the invitation acceptance page must work before the user has
 * registered or logged in. Every other endpoint requires
 * authentication; the JWT identifies the accepter so the type-specific
 * write (hr_employees / sis_student_guardians / etc.) can be stamped
 * with the right person/account id.
 */
@ApiTags('Invitations')
@Controller('invitations')
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  // GET /mine MUST be declared before GET /:token — NestJS / Express
  // match routes in declaration order, and `mine` as a :token param
  // would otherwise try to look up an invitation with the literal
  // token value "mine" (Codex review FIX 5).
  @ApiBearerAuth()
  @Get('mine')
  @ApiOperation({ summary: 'List the caller’s pending invitations' })
  async mine(@Req() req: AuthedRequest): Promise<MyInvitationDto[]> {
    const u = req.user!;
    return this.invitations.listMine({ personId: u.personId, email: u.email });
  }

  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'Public landing page details for an invitation token' })
  async get(@Param('token') token: string): Promise<InvitationSummaryDto> {
    return this.invitations.getByToken(token);
  }

  @ApiBearerAuth()
  @Post(':token/accept')
  @ApiOperation({ summary: 'Accept an invitation (type-dispatched)' })
  async accept(
    @Req() req: AuthedRequest,
    @Param('token') token: string,
  ): Promise<AcceptInvitationResultDto> {
    const u = req.user!;
    return this.invitations.accept(token, {
      personId: u.personId,
      accountId: u.sub,
      email: u.email,
    });
  }

  @ApiBearerAuth()
  @Post(':token/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Decline an invitation (marks status=EXPIRED)' })
  async decline(@Req() req: AuthedRequest, @Param('token') token: string): Promise<void> {
    const u = req.user!;
    await this.invitations.decline(token, { personId: u.personId });
  }
}
