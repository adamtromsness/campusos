import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { FrameworkService, StandardService } from './frameworks.service';
import { CurriculumMapService, UnitService } from './maps.service';
import { DeliveryGapService, ResourceLinkService } from './gaps.service';
import {
  AdoptionDto,
  AlignStandardDto,
  CreateAdoptionDto,
  CreateCurriculumMapDto,
  CreateCustomFrameworkDto,
  CreateResourceDto,
  CreateStandardDto,
  CreateUnitDto,
  CurriculumMapDto,
  CurriculumMapStatus,
  DeliveryGapDto,
  FrameworkDetailDto,
  FrameworkDto,
  GapType,
  LinkLessonDto,
  ReorderUnitsDto,
  ResourceDto,
  StandardDto,
  UnitDetailDto,
  UnitDto,
  UnitLessonDto,
  UnitStandardDto,
  UpdateCurriculumMapDto,
  UpdateCustomFrameworkDto,
  UpdateResourceDto,
  UpdateStandardDto,
  UpdateUnitDto,
} from './dto/curriculum.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Curriculum & Standards')
@Controller()
export class CurriculumController {
  constructor(
    private readonly frameworks: FrameworkService,
    private readonly standards: StandardService,
    private readonly maps: CurriculumMapService,
    private readonly units: UnitService,
    private readonly gaps: DeliveryGapService,
    private readonly resources: ResourceLinkService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached Curriculum controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ── Frameworks ──

  @Get('curriculum/frameworks')
  @RequirePermission('tch-008:read')
  @ApiOperation({
    summary:
      'List frameworks (DUAL RESOLUTION) — returns both school-adopted platform frameworks (CCSS, NGSS) and school-custom frameworks tagged with source=PLATFORM or source=SCHOOL. ?includeUnadopted=true also returns unadopted platform frameworks for the adoption picker.',
  })
  async listFrameworks(
    @Query('includeUnadopted') includeUnadopted?: string,
  ): Promise<FrameworkDto[]> {
    return this.frameworks.list(includeUnadopted === 'true');
  }

  @Get('curriculum/frameworks/:id')
  @RequirePermission('tch-008:read')
  async getFramework(@Param('id') id: string): Promise<FrameworkDetailDto> {
    return this.frameworks.getById(id);
  }

  @Post('curriculum/frameworks')
  @RequirePermission('tch-008:write')
  async createCustomFramework(
    @Body() dto: CreateCustomFrameworkDto,
    @Req() req: AuthedRequest,
  ): Promise<FrameworkDetailDto> {
    return this.frameworks.createCustom(dto, await this.resolveActor(req));
  }

  @Patch('curriculum/frameworks/:id')
  @RequirePermission('tch-008:write')
  async patchCustomFramework(
    @Param('id') id: string,
    @Body() dto: UpdateCustomFrameworkDto,
    @Req() req: AuthedRequest,
  ): Promise<FrameworkDetailDto> {
    return this.frameworks.patchCustom(id, dto, await this.resolveActor(req));
  }

  @Get('curriculum/framework-adoptions')
  @RequirePermission('tch-008:read')
  async listAdoptions(): Promise<AdoptionDto[]> {
    return this.frameworks.listAdoptions();
  }

  @Post('curriculum/framework-adoptions')
  @RequirePermission('tch-008:write')
  async createAdoption(
    @Body() dto: CreateAdoptionDto,
    @Req() req: AuthedRequest,
  ): Promise<AdoptionDto> {
    return this.frameworks.createAdoption(dto, await this.resolveActor(req));
  }

  // ── Standards ──

  @Get('curriculum/standards')
  @RequirePermission('tch-008:read')
  @ApiOperation({
    summary:
      'GIN-INDEXED SEARCH KEYSTONE — ?q=narrative searches across BOTH platform and school-custom standards. Filters: frameworkId, gradeBand, domain. Returns unified results with source=PLATFORM or source=SCHOOL.',
  })
  async searchStandards(
    @Query('q') q?: string,
    @Query('frameworkId') frameworkId?: string,
    @Query('gradeBand') gradeBand?: string,
    @Query('domain') domain?: string,
    @Query('limit') limit?: string,
  ): Promise<StandardDto[]> {
    return this.standards.search({
      q,
      frameworkId,
      gradeBand,
      domain,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('curriculum/standards')
  @RequirePermission('tch-008:write')
  async createCustomStandard(
    @Body() dto: CreateStandardDto,
    @Req() req: AuthedRequest,
  ): Promise<StandardDto> {
    return this.standards.createCustom(dto, await this.resolveActor(req));
  }

  @Patch('curriculum/standards/:id')
  @RequirePermission('tch-008:write')
  async patchCustomStandard(
    @Param('id') id: string,
    @Body() dto: UpdateStandardDto,
    @Req() req: AuthedRequest,
  ): Promise<StandardDto> {
    return this.standards.patchCustom(id, dto, await this.resolveActor(req));
  }

  // ── Curriculum Maps ──

  @Get('curriculum/maps')
  @RequirePermission('tch-008:read')
  async listMaps(
    @Req() req: AuthedRequest,
    @Query('subject') subject?: string,
    @Query('gradeLevel') gradeLevel?: string,
    @Query('academicYearId') academicYearId?: string,
    @Query('status') status?: CurriculumMapStatus,
  ): Promise<CurriculumMapDto[]> {
    return this.maps.list(await this.resolveActor(req), {
      subject,
      gradeLevel,
      academicYearId,
      status,
    });
  }

  @Get('curriculum/maps/:id')
  @RequirePermission('tch-008:read')
  async getMap(@Param('id') id: string, @Req() req: AuthedRequest): Promise<CurriculumMapDto> {
    return this.maps.getById(id, await this.resolveActor(req));
  }

  @Post('curriculum/maps')
  @RequirePermission('tch-008:write')
  async createMap(
    @Body() dto: CreateCurriculumMapDto,
    @Req() req: AuthedRequest,
  ): Promise<CurriculumMapDto> {
    return this.maps.create(dto, await this.resolveActor(req));
  }

  @Patch('curriculum/maps/:id')
  @RequirePermission('tch-008:write')
  async patchMap(
    @Param('id') id: string,
    @Body() dto: UpdateCurriculumMapDto,
    @Req() req: AuthedRequest,
  ): Promise<CurriculumMapDto> {
    return this.maps.patch(id, dto, await this.resolveActor(req));
  }

  // ── Units ──

  @Get('curriculum/maps/:id/units')
  @RequirePermission('tch-008:read')
  @ApiOperation({
    summary:
      'List units in a curriculum map — propagates parent map visibility (REVIEW-CYCLE23 BLOCKING 2). Read-only personas only see units under PUBLISHED maps.',
  })
  async listUnitsForMap(@Param('id') id: string, @Req() req: AuthedRequest): Promise<UnitDto[]> {
    return this.units.listForMap(id, await this.resolveActor(req));
  }

  @Get('curriculum/units/:id')
  @RequirePermission('tch-008:read')
  @ApiOperation({
    summary:
      'Unit detail — actor-aware (REVIEW-CYCLE23 BLOCKING 1+2). Filters teacher-only resources for non-staff actors and 404s on units under non-PUBLISHED maps for read-only personas.',
  })
  async getUnit(@Param('id') id: string, @Req() req: AuthedRequest): Promise<UnitDetailDto> {
    return this.units.getById(id, await this.resolveActor(req));
  }

  @Post('curriculum/maps/:id/units')
  @RequirePermission('tch-008:write')
  async createUnit(
    @Param('id') mapId: string,
    @Body() dto: CreateUnitDto,
    @Req() req: AuthedRequest,
  ): Promise<UnitDto> {
    return this.units.create(mapId, dto, await this.resolveActor(req));
  }

  @Patch('curriculum/units/:id')
  @RequirePermission('tch-008:write')
  async patchUnit(
    @Param('id') id: string,
    @Body() dto: UpdateUnitDto,
    @Req() req: AuthedRequest,
  ): Promise<UnitDetailDto> {
    return this.units.patch(id, dto, await this.resolveActor(req));
  }

  @Patch('curriculum/maps/:id/units/reorder')
  @RequirePermission('tch-008:write')
  async reorderUnits(
    @Param('id') mapId: string,
    @Body() dto: ReorderUnitsDto,
    @Req() req: AuthedRequest,
  ): Promise<UnitDto[]> {
    return this.units.reorder(mapId, dto, await this.resolveActor(req));
  }

  @Post('curriculum/units/:id/standards')
  @RequirePermission('tch-008:write')
  @ApiOperation({
    summary:
      'Align a standard to a unit — DUAL RESOLUTION, accepts standardId from either platform.cur_standards_platform or tenant cur_standards.',
  })
  async alignStandard(
    @Param('id') unitId: string,
    @Body() dto: AlignStandardDto,
    @Req() req: AuthedRequest,
  ): Promise<UnitStandardDto> {
    return this.units.alignStandard(unitId, dto, await this.resolveActor(req));
  }

  @Delete('curriculum/unit-standards/:id')
  @RequirePermission('tch-008:write')
  async unalignStandard(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.units.unalignStandard(id, await this.resolveActor(req));
  }

  @Post('curriculum/units/:id/lessons')
  @RequirePermission('tch-008:write')
  @ApiOperation({
    summary:
      'Link a Cycle 2 cls_lesson to this unit — CROSS-CYCLE READ-BACK KEYSTONE. Validates clsLessonId exists in this school before INSERT.',
  })
  async linkLesson(
    @Param('id') unitId: string,
    @Body() dto: LinkLessonDto,
    @Req() req: AuthedRequest,
  ): Promise<UnitLessonDto> {
    return this.units.linkLesson(unitId, dto, await this.resolveActor(req));
  }

  @Delete('curriculum/unit-lessons/:id')
  @RequirePermission('tch-008:write')
  async unlinkLesson(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.units.unlinkLesson(id, await this.resolveActor(req));
  }

  // ── Delivery Gaps ──

  @Get('curriculum/delivery-gaps')
  @RequirePermission('tch-008:write')
  @ApiOperation({
    summary:
      'Delivery gap analytics — STAFF/ADMIN only (REVIEW-CYCLE23 BLOCKING 3). Read-only personas (parents/students) cannot enumerate internal coverage analytics. Restricted to tch-008:write so only teachers / curriculum coordinators / school admins can read.',
  })
  async listGaps(
    @Req() req: AuthedRequest,
    @Query('curriculumMapId') curriculumMapId?: string,
    @Query('unitId') unitId?: string,
    @Query('gapType') gapType?: GapType,
  ): Promise<DeliveryGapDto[]> {
    return this.gaps.list({ curriculumMapId, unitId, gapType }, await this.resolveActor(req));
  }

  @Get('curriculum/units/:id/gaps')
  @RequirePermission('tch-008:write')
  @ApiOperation({
    summary: 'Per-unit delivery gaps — STAFF/ADMIN only (REVIEW-CYCLE23 BLOCKING 3).',
  })
  async listGapsForUnit(
    @Param('id') unitId: string,
    @Req() req: AuthedRequest,
  ): Promise<DeliveryGapDto[]> {
    return this.gaps.list({ unitId }, await this.resolveActor(req));
  }

  @Post('curriculum/delivery-gaps/refresh')
  @RequirePermission('tch-008:admin')
  @ApiOperation({
    summary:
      'Manual re-materialisation of cur_delivery_gaps for the calling tenant. Walks every PUBLISHED curriculum map, computes per-(unit, standard) gap state from cur_unit_lessons + cls_lessons, and emits cur.delivery_gap.detected for new NOT_STARTED/PARTIAL gaps.',
  })
  async refreshGaps(
    @Req() req: AuthedRequest,
  ): Promise<{ unitsScanned: number; gapsWritten: number }> {
    return this.gaps.refreshTenant(await this.resolveActor(req));
  }

  // ── Resources ──

  @Get('curriculum/units/:id/resources')
  @RequirePermission('tch-008:read')
  @ApiOperation({
    summary:
      'List resources for a unit — non-staff actors never see is_teacher_only=true rows. Teachers + admins see all.',
  })
  async listResources(
    @Param('id') unitId: string,
    @Req() req: AuthedRequest,
  ): Promise<ResourceDto[]> {
    return this.resources.listForUnit(unitId, await this.resolveActor(req));
  }

  @Post('curriculum/units/:id/resources')
  @RequirePermission('tch-008:write')
  async createResource(
    @Param('id') unitId: string,
    @Body() dto: CreateResourceDto,
    @Req() req: AuthedRequest,
  ): Promise<ResourceDto> {
    return this.resources.create(unitId, dto, await this.resolveActor(req));
  }

  @Patch('curriculum/resources/:id')
  @RequirePermission('tch-008:write')
  async patchResource(
    @Param('id') id: string,
    @Body() dto: UpdateResourceDto,
    @Req() req: AuthedRequest,
  ): Promise<ResourceDto> {
    return this.resources.patch(id, dto, await this.resolveActor(req));
  }

  @Delete('curriculum/resources/:id')
  @RequirePermission('tch-008:write')
  async removeResource(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    return this.resources.remove(id, await this.resolveActor(req));
  }
}
