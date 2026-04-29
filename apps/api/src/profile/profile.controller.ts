import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
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

  @Get('profile/me')
  @RequirePermission('usr-001:read')
  @ApiOperation({ summary: 'Read the calling user’s own profile' })
  async getMyProfile(@Req() req: AuthedRequest): Promise<ProfileResponseDto> {
    return this.profile.getProfile(req.user!.personId);
  }

  @Patch('profile/me')
  @RequirePermission('usr-001:write')
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
