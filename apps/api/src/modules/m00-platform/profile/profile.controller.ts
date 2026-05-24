import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ProfileService } from './profile.service';
import { ProfileResponseDto, UpdateAdminProfileDto, UpdateMyProfileDto } from './dto/profile.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Profile')
@ApiBearerAuth()
@Controller()
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  // /profile/me is intentionally NOT gated on a permission code. Every
  // authenticated user — including 0-persona freshly-registered
  // accounts that hold no codes — must be able to read and edit their
  // own iam_person row. Cross-user access is impossible because the
  // service is invoked with req.user.personId; the JWT identifies the
  // caller and the row is always their own. The admin paths below
  // remain gated on usr-001:admin and add a per-tenant target check.
  @Get('profile/me')
  @ApiOperation({ summary: 'Read the calling user’s own profile' })
  async getMyProfile(@Req() req: AuthedRequest): Promise<ProfileResponseDto> {
    return this.profile.getProfile(req.user!.personId);
  }

  @Patch('profile/me')
  @ApiOperation({ summary: 'Update editable fields on the calling user’s own profile' })
  async updateMyProfile(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateMyProfileDto,
  ): Promise<ProfileResponseDto> {
    return this.profile.updateMyProfile(req.user!.personId, dto);
  }

  @Get('profile/:personId')
  @RequirePermission('usr-001:admin')
  @ApiOperation({ summary: 'Admin — read any person’s profile (tenant-scoped)' })
  async getProfile(
    @Param('personId', ParseUUIDPipe) personId: string,
  ): Promise<ProfileResponseDto> {
    return this.profile.getAdminProfile(personId);
  }

  @Patch('profile/:personId')
  @RequirePermission('usr-001:admin')
  @ApiOperation({ summary: 'Admin — update any person’s profile (incl. identity fields)' })
  async updateProfile(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Body() dto: UpdateAdminProfileDto,
  ): Promise<ProfileResponseDto> {
    return this.profile.updateAdminProfile(personId, dto);
  }
}
