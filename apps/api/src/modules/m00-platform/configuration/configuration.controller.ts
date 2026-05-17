import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RequirePermission } from '@shared/auth';
import {
  AcademicTreeResponseDto,
  AcademicTreeService,
  BulkImportResponseDto,
  BulkImportService,
  ConfigurationService,
  ConnectionsSummaryResponseDto,
  ConnectionsSummaryService,
  FacilityTreeResponseDto,
  FacilityTreeService,
  GradeBandDefinitionEntry,
  GradeBandDefinitions,
  ImportStaffRow,
  ImportStudentRow,
  PositionTreeResponseDto,
  PositionTreeService,
  SetupStatusResponseDto,
  SetupWizardProgressResponseDto,
  SetupWizardService,
} from './configuration.service';

// ─── Step 2 DTOs (rooms import) ──────────────────────────────────

class ImportRoomRowDto {
  @IsString()
  @MaxLength(200)
  buildingName!: string;

  @IsString()
  @MaxLength(200)
  roomName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  floor?: string | null;

  @IsString()
  @MaxLength(40)
  spaceType!: string;

  @IsOptional()
  @IsNumber()
  areaSqft?: number | null;
}

class ImportRoomsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportRoomRowDto)
  rows!: ImportRoomRowDto[];
}

// ─── Step 3 DTOs (grade bands) ───────────────────────────────────

class GradeBandEntryDto implements GradeBandDefinitionEntry {
  @IsString()
  @MaxLength(60)
  key!: string;

  @IsString()
  @MaxLength(120)
  label!: string;

  @IsArray()
  @IsString({ each: true })
  grades!: string[];
}

class UpdateGradeBandsDto implements GradeBandDefinitions {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GradeBandEntryDto)
  bands!: GradeBandEntryDto[];
}

// ─── Step 6 DTOs (setup wizard) ──────────────────────────────────

class PatchWizardProgressDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  currentStep?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  markStepComplete?: number;
}

// ─── Step 7 DTOs (staff + students bulk imports) ─────────────────

class ImportStaffRowDto implements ImportStaffRow {
  @IsString()
  @MaxLength(120)
  firstName!: string;

  @IsString()
  @MaxLength(120)
  lastName!: string;

  @IsEmail()
  @MaxLength(200)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  positionTitle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  departmentName?: string | null;
}

class ImportStaffDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportStaffRowDto)
  rows!: ImportStaffRowDto[];
}

class ImportStudentRowDto implements ImportStudentRow {
  @IsString()
  @MaxLength(120)
  firstName!: string;

  @IsString()
  @MaxLength(120)
  lastName!: string;

  @IsString()
  @MaxLength(60)
  studentNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  gradeLevel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  guardianFirstName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  guardianLastName?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  guardianEmail?: string | null;
}

class ImportStudentsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportStudentRowDto)
  rows!: ImportStudentRowDto[];
}

/**
 * School Configuration Admin (per docs/campusos-school-configuration-admin.html).
 *
 * Per-tenant — every endpoint resolves under the calling tenant's
 * schema. NOT @PlatformScoped() (that would be wrong here — schools
 * configure their OWN data; this is not a cross-tenant ops surface
 * like the platform-admin module).
 *
 * Gated on sys-001:admin which both the Platform Admin and School
 * Admin roles hold (per the seed-iam.ts everyFunction grant on
 * School Admin).
 */
@ApiTags('Configuration Admin')
@Controller('admin/configuration')
export class ConfigurationController {
  constructor(
    private readonly svc: ConfigurationService,
    private readonly facilityTree: FacilityTreeService,
    private readonly academicTree: AcademicTreeService,
    private readonly positionTree: PositionTreeService,
    private readonly connections: ConnectionsSummaryService,
    private readonly setupWizard: SetupWizardService,
    private readonly bulkImport: BulkImportService,
  ) {}

  // ─── Step 1 — Setup status ─────────────────────────────────────

  @Get('setup-status')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Setup-completeness checklist computed live from existing tenant data. ' +
      'Returns the 7-item checklist (buildings, rooms, academic year, classes, ' +
      'positions, staff assigned, classes in rooms) with DONE / PARTIAL / ' +
      'NOT_STARTED status per item.',
  })
  setupStatus(): Promise<SetupStatusResponseDto> {
    return this.svc.getSetupStatus();
  }

  // ─── Step 2 — Facility Structure Manager ───────────────────────

  @Get('facility-tree')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Full facility hierarchy: school → buildings → floors → spaces. Includes ' +
      'sch_room cross-link + scheduled-class count per space. Single response ' +
      'is what the tree-view UI needs to render the entire physical plant ' +
      'without N+1 calls.',
  })
  facilityTreeView(): Promise<FacilityTreeResponseDto> {
    return this.facilityTree.getTree();
  }

  @Delete('buildings/:id')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Delete a building, refusing if any spaces still reference it. Operator ' +
      'must remove all spaces first OR archive the building (PATCH ' +
      '/facilities/buildings/:id with isActive=false). Friendly 409 returned ' +
      'on dependency conflict.',
  })
  deleteBuilding(@Param('id') id: string) {
    return this.facilityTree.deleteBuildingWithDependencyCheck(id);
  }

  @Delete('spaces/:id')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Delete a space, refusing if its sch_room is still scheduled in active ' +
      'timetable slots. Operator must reschedule or remove those classes first. ' +
      'Friendly 409 on dependency conflict.',
  })
  deleteSpace(@Param('id') id: string) {
    return this.facilityTree.deleteSpaceWithDependencyCheck(id);
  }

  @Post('import/rooms')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Bulk-import rooms via parsed CSV rows: { buildingName, roomName, floor, ' +
      'spaceType, areaSqft }. Validates every row up-front; if any row fails, ' +
      'rejects the whole batch with structured rowErrors so the operator can ' +
      'fix and re-upload. Successful imports run inside one tenant transaction.',
  })
  importRooms(@Body() body: ImportRoomsDto) {
    if (!body || !Array.isArray(body.rows)) {
      throw new BadRequestException('Body must include `rows: ImportRoomRowDto[]`.');
    }
    const normalized = body.rows.map((r) => ({
      buildingName: r.buildingName,
      roomName: r.roomName,
      floor: r.floor ?? null,
      spaceType: r.spaceType,
      areaSqft: r.areaSqft ?? null,
    }));
    return this.facilityTree.bulkImportRooms(normalized);
  }

  // ─── Step 3 — Academic Structure Manager ───────────────────────

  @Get('academic-tree')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Full academic hierarchy: selected academic year + terms + grade bands ' +
      '(from school_config.grade_band_definitions) + grade levels with classes ' +
      '(joined to courses, teachers, enrollments, room). Defaults to the ' +
      'is_current=true year when academicYearId is omitted.',
  })
  academicTreeView(
    @Query('academicYearId') academicYearId?: string,
  ): Promise<AcademicTreeResponseDto> {
    return this.academicTree.getTree(academicYearId);
  }

  @Patch('grade-bands')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Replaces the grade-band definitions wholesale. Stored on the tenant ' +
      'school_config table under config_key=grade_band_definitions. Refuses ' +
      'duplicate band keys + refuses any grade appearing in two bands.',
  })
  updateGradeBands(@Body() body: UpdateGradeBandsDto): Promise<GradeBandDefinitions> {
    return this.academicTree.saveBandDefinitions(body);
  }

  // ─── Step 4 — Position Structure Manager ───────────────────────

  @Get('position-tree')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Position hierarchy as a forest rooted at every position with ' +
      'reports_to IS NULL. Each node carries department + filling employee ' +
      '(or null for vacant). Used by the org-chart and the vacancy dashboard.',
  })
  positionTreeView(): Promise<PositionTreeResponseDto> {
    return this.positionTree.getTree();
  }

  // ─── Step 5 — Connections summary ──────────────────────────────

  @Get('connections-summary')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Cross-structure assignment summary: building-school links, position-' +
      'school links, person-position links (with vacancies), class-room links ' +
      '(with unassigned classes). Used by /admin/configuration/connections.',
  })
  connectionsSummary(): Promise<ConnectionsSummaryResponseDto> {
    return this.connections.getSummary();
  }

  // ─── Step 6 — Setup wizard progress ────────────────────────────

  @Get('wizard-progress')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Returns the resumable setup wizard progress (current step + completed ' +
      'steps), plus the live setup-status checklist so the wizard can render ' +
      'per-step DONE/PARTIAL chips without a second round trip.',
  })
  getWizardProgress(): Promise<SetupWizardProgressResponseDto> {
    return this.setupWizard.getProgress();
  }

  @Patch('wizard-progress')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Updates the wizard progress: currentStep moves the user to a step, ' +
      'markStepComplete adds a step to the completedSteps array (idempotent).',
  })
  patchWizardProgress(
    @Body() body: PatchWizardProgressDto,
  ): Promise<SetupWizardProgressResponseDto> {
    return this.setupWizard.patchProgress(body);
  }

  // ─── Step 7 — Bulk imports ─────────────────────────────────────

  @Post('import/staff')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Bulk-import staff: { firstName, lastName, email, positionTitle?, ' +
      'departmentName? }. Skips emails that already exist (returns skipped ' +
      'count). Runs in one tenant transaction.',
  })
  importStaff(@Body() body: ImportStaffDto): Promise<BulkImportResponseDto> {
    return this.bulkImport.bulkImportStaff(body.rows);
  }

  @Post('import/students')
  @RequirePermission('sys-001:admin')
  @ApiOperation({
    summary:
      'Bulk-import students: { firstName, lastName, studentNumber, ' +
      'gradeLevel?, guardianFirstName?, guardianLastName?, guardianEmail? }. ' +
      'Skips student_numbers that already exist. Reuses an existing guardian ' +
      'when guardianEmail matches. Runs in one tenant transaction.',
  })
  importStudents(@Body() body: ImportStudentsDto): Promise<BulkImportResponseDto> {
    return this.bulkImport.bulkImportStudents(body.rows);
  }
}
