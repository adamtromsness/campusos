import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ProfileService } from './profile.service';
import {
  AddPersonPhoneDto,
  AdultMedicalInfoDto,
  PersonPhoneDto,
  ProfileResponseDto,
  UpdateAdminProfileDto,
  UpdateAdultMedicalInfoDto,
  UpdateMyProfileDto,
  UpdatePersonPhoneDto,
} from './dto/profile.dto';

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

  // Adult medical info — /profile/me/medical. MUST appear before any
  // /profile/:personId-style route because Nest matches in registration
  // order and would otherwise consume 'me' as a UUID param (and the
  // /me-prefixed routes above already follow the same pattern).
  @Get('profile/me/medical')
  @ApiOperation({ summary: 'Read the calling user’s adult medical info' })
  async getMyMedical(@Req() req: AuthedRequest): Promise<AdultMedicalInfoDto> {
    return this.profile.getMyMedical(req.user!.personId);
  }

  @Patch('profile/me/medical')
  @ApiOperation({ summary: 'Update the calling user’s adult medical info' })
  async updateMyMedical(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateAdultMedicalInfoDto,
  ): Promise<AdultMedicalInfoDto> {
    return this.profile.updateMyMedical(req.user!.personId, dto);
  }

  // Multi-phone list — /profile/me/phones. Declared before
  // /profile/:personId-style routes so Nest's in-registration-order
  // matching doesn't swallow 'me' as a UUID param.
  @Get('profile/me/phones')
  @ApiOperation({ summary: 'List the calling user’s phones, primary first' })
  async listMyPhones(@Req() req: AuthedRequest): Promise<PersonPhoneDto[]> {
    return this.profile.listMyPhones(req.user!.personId);
  }

  @Post('profile/me/phones')
  @ApiOperation({
    summary:
      'Add a phone. First phone auto-becomes primary; setting isPrimary demotes the existing primary in the same tx.',
  })
  async addMyPhone(
    @Req() req: AuthedRequest,
    @Body() dto: AddPersonPhoneDto,
  ): Promise<PersonPhoneDto> {
    return this.profile.addMyPhone(req.user!.personId, dto);
  }

  @Patch('profile/me/phones/:phoneId')
  @ApiOperation({ summary: 'Update a phone (number / type / textsAllowed / isPrimary)' })
  async updateMyPhone(
    @Req() req: AuthedRequest,
    @Param('phoneId', ParseUUIDPipe) phoneId: string,
    @Body() dto: UpdatePersonPhoneDto,
  ): Promise<PersonPhoneDto> {
    return this.profile.updateMyPhone(req.user!.personId, phoneId, dto);
  }

  @Delete('profile/me/phones/:phoneId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a phone. If it was primary, the next-oldest phone is promoted automatically.',
  })
  async deleteMyPhone(
    @Req() req: AuthedRequest,
    @Param('phoneId', ParseUUIDPipe) phoneId: string,
  ): Promise<void> {
    await this.profile.deleteMyPhone(req.user!.personId, phoneId);
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
