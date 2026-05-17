import {
  Body,
  Controller,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { StudentOwned } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { RecruitingService } from './recruiting.service';
import {
  CreateRecruitingInterestDto,
  CreateRecruitingProfileDto,
  RecruitingInterestResponseDto,
  RecruitingProfileResponseDto,
  UpdateRecruitingInterestDto,
  UpdateRecruitingProfileDto,
} from './dto/athletics-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics Advanced — Recruiting Profiles')
@ApiBearerAuth()
@Controller('athletics')
export class RecruitingController {
  constructor(
    private readonly recruiting: RecruitingService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Profiles ────────────────────────────────────────────────────

  @Get('recruiting')
  @RequirePermission('ath-001:read')
  @ApiOperation({
    summary:
      'List recruiting profiles. Admin/coach see all; students see own only; guardians see linked children only; everyone else sees published profiles only.',
  })
  async listProfiles(
    @Req() req: AuthedRequest,
    @Query('graduationYear', new ParseIntPipe({ optional: true })) graduationYear?: number,
    @Query('sport') sport?: string,
    @Query('isPublished', new ParseBoolPipe({ optional: true })) isPublished?: boolean,
  ): Promise<RecruitingProfileResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recruiting.listProfiles({ graduationYear, sport, isPublished }, actor);
  }

  @Get('recruiting/:id')
  @RequirePermission('ath-001:read')
  async getProfile(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RecruitingProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recruiting.getProfileById(id, actor);
  }

  @Get('students/:studentId/recruiting')
  @RequirePermission('ath-001:read')
  async getProfileByStudent(
    @Req() req: AuthedRequest,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<RecruitingProfileResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recruiting.getProfileByStudent(studentId, actor);
  }

  @Post('recruiting')
  @RequirePermission('ath-001:read')
  @StudentOwned({
    studentIdBody: 'studentId',
    allowAdminOverride: true,
    allowCoachDelegation: true,
  })
  @ApiOperation({
    summary:
      'STUDENT-OWNED (ath_recruiting_profiles) — only the owning student or a coach/admin can create one. Coach delegation honoured per IMP-11.',
  })
  async createProfile(
    @Req() req: AuthedRequest,
    @Body() body: CreateRecruitingProfileDto,
  ): Promise<RecruitingProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recruiting.createProfile(body, actor);
  }

  @Patch('recruiting/:id')
  @RequirePermission('ath-001:read')
  @StudentOwned({ allowAdminOverride: true, allowCoachDelegation: true })
  @ApiOperation({
    summary:
      'STUDENT-OWNED (ath_recruiting_profiles) — students edit own; coaches edit and add the recommendation. Publishing snapshots GPA from rpt_student_academic_summary.',
  })
  async updateProfile(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRecruitingProfileDto,
  ): Promise<RecruitingProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recruiting.updateProfile(id, body, actor);
  }

  // ── Interests ───────────────────────────────────────────────────

  @Get('recruiting/:id/interests')
  @RequirePermission('ath-001:read')
  async listInterests(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RecruitingInterestResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recruiting.listInterestsForProfile(id, actor);
  }

  @Post('recruiting/:id/interests')
  @RequirePermission('ath-001:read')
  async createInterest(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateRecruitingInterestDto,
  ): Promise<RecruitingInterestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recruiting.createInterest(id, body, actor);
  }

  @Patch('recruiting-interests/:id')
  @RequirePermission('ath-001:read')
  async updateInterest(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRecruitingInterestDto,
  ): Promise<RecruitingInterestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recruiting.updateInterest(id, body, actor);
  }
}
