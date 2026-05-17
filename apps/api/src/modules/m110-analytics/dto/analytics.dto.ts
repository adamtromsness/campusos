import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** ─── Worker control ───────────────────────────────────────────────── */

export class RunWorkersDto {
  @ApiPropertyOptional({
    description:
      'When supplied, run only the named worker. Otherwise the chained nightly pipeline runs.',
    enum: ['sis', 'classroom', 'at-risk', 'school-summary', 'district', 'wellbeing', 'finance-ar'],
  })
  @IsOptional()
  @IsIn(['sis', 'classroom', 'at-risk', 'school-summary', 'district', 'wellbeing', 'finance-ar'])
  worker?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD. Defaults to today.' })
  @IsOptional()
  @IsDateString()
  asOfDate?: string;
}

export interface WorkerStatusDto {
  consumerGroup: string;
  topic: string;
  partition: number;
  committedOffset: number;
  logEndOffset: number | null;
  lag: number | null;
  recordedAt: string;
}

export interface WorkerRunSummaryDto {
  worker: string;
  status: 'OK' | 'FAILED' | 'SKIPPED';
  rowsWritten: number;
  durationMs: number;
  errorMessage?: string | null;
}

/** ─── At-risk configuration ────────────────────────────────────────── */

export class CreateAtRiskConfigDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    description:
      'JSONB rule set. All populated thresholds AND together. Optional fields: attendance_threshold (0-1), grade_threshold (0-5), missed_assignments_threshold (int), behaviour_incident_threshold (int).',
  })
  @IsObject()
  triggerConditions!: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String], description: 'platform_users.id values to notify.' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  alertRecipients?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateAtRiskConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  triggerConditions?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  alertRecipients?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export interface AtRiskConfigDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  triggerConditions: Record<string, unknown>;
  alertRecipients: string[];
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AtRiskStudentDto {
  studentId: string;
  studentName: string | null;
  gradeLevel: string | null;
  academicYearId: string;
  currentGpa: number | null;
  attendanceRate: number | null;
  totalAssignments: number;
  completedAssignments: number;
  atRiskFlags: Record<string, unknown>;
  flaggedConfigs: string[];
}

/** ─── Read-model output DTOs ──────────────────────────────────────── */

export interface DailyAttendanceSummaryDto {
  id: string;
  schoolId: string;
  classId: string;
  className: string | null;
  summaryDate: string;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  totalEnrolled: number;
  attendanceRate: number | null;
  generatedAt: string;
}

export interface StudentAcademicSummaryDto {
  id: string;
  studentId: string;
  studentName: string | null;
  gradeLevel: string | null;
  academicYearId: string;
  schoolId: string;
  currentGpa: number | null;
  creditsEarned: number;
  creditsAttempted: number;
  attendanceRate: number | null;
  totalAssignments: number;
  completedAssignments: number;
  atRiskFlags: Record<string, unknown>;
  generatedAt: string;
}

export interface ClassPerformanceSummaryDto {
  id: string;
  classId: string;
  className: string | null;
  termId: string;
  schoolId: string;
  avgGrade: number | null;
  medianGrade: number | null;
  gradeDistribution: Record<string, number>;
  assignmentCompletionRate: number | null;
  studentCount: number;
  generatedAt: string;
}

export interface StaffSummaryDto {
  id: string;
  employeeId: string;
  employeeName: string | null;
  academicYearId: string;
  schoolId: string;
  classesTaught: number;
  totalStudents: number;
  leaveDaysTaken: number;
  avgClassPerformance: number | null;
  generatedAt: string;
}

export interface SchoolSummaryDto {
  id: string;
  schoolId: string;
  schoolName: string | null;
  academicYearId: string;
  totalEnrolled: number;
  totalStaff: number;
  avgAttendanceRate: number | null;
  avgGpa: number | null;
  atRiskCount: number;
  incidentCount: number;
  generatedAt: string;
}

export interface DistrictSummaryDto {
  id: string;
  organisationId: string;
  academicYearId: string;
  schoolCount: number;
  totalEnrolled: number;
  totalStaff: number;
  avgAttendanceRate: number | null;
  avgGpa: number | null;
  totalAtRisk: number;
  totalIncidents: number;
  generatedAt: string;
}

export interface DistrictSchoolComparisonDto {
  id: string;
  organisationId: string;
  academicYearId: string;
  schoolId: string;
  schoolName: string | null;
  rankByAttendance: number | null;
  rankByPerformance: number | null;
  metrics: Record<string, unknown>;
  generatedAt: string;
}

export interface WellbeingTrendsDto {
  id: string;
  schoolId: string;
  gradeLevel: string;
  periodStart: string;
  periodEnd: string;
  avgWellbeingScore: number | null;
  responseCount: number;
  wantsToTalkCount: number;
  flaggedCount: number;
  generatedAt: string;
}

export interface AgedDebtorDto {
  id: string;
  schoolId: string;
  familyAccountId: string;
  accountHolderName: string | null;
  totalOutstanding: number;
  currentBucket: number;
  days30: number;
  days60: number;
  days90Plus: number;
  lastPaymentDate: string | null;
  generatedAt: string;
}

/** ─── Report engine ───────────────────────────────────────────────── */

export class CreateReportDefinitionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    description: 'Free-form report category (ATTENDANCE, FINANCE, ACADEMIC, COMPLIANCE, CUSTOM).',
  })
  @IsString()
  @IsNotEmpty()
  reportType!: string;

  @ApiProperty({ description: 'Template config: data_source, filters, columns, grouping.' })
  @IsObject()
  templateConfig!: Record<string, unknown>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateReportDefinitionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reportType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  templateConfig?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class RunReportDto {
  @ApiPropertyOptional({ enum: ['CSV', 'PDF', 'XLSX'], default: 'CSV' })
  @IsOptional()
  @IsIn(['CSV', 'PDF', 'XLSX'])
  outputFormat?: 'CSV' | 'PDF' | 'XLSX';
}

export interface ReportDefinitionDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  reportType: string;
  templateConfig: Record<string, unknown>;
  isStateReport: boolean;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRunDto {
  id: string;
  reportDefinitionId: string;
  reportName: string | null;
  runBy: string | null;
  runByName: string | null;
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  outputFormat: 'CSV' | 'PDF' | 'XLSX';
  outputS3Key: string | null;
  rowCount: number | null;
  errorMessage: string | null;
  startedAt: string;
  generatedAt: string | null;
}

export class CreateScheduledReportDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  reportName!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  templateName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  reportParams?: Record<string, unknown>;

  @ApiProperty({ description: 'Standard 5-field cron expression.' })
  @IsString()
  @IsNotEmpty()
  scheduleCron!: string;

  @ApiPropertyOptional({ default: 'UTC' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ enum: ['EMAIL', 'IN_APP', 'BOTH'], default: 'EMAIL' })
  @IsOptional()
  @IsIn(['EMAIL', 'IN_APP', 'BOTH'])
  deliveryChannel?: 'EMAIL' | 'IN_APP' | 'BOTH';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  recipientIds?: string[];

  @ApiPropertyOptional({ enum: ['CSV', 'PDF', 'XLSX'], default: 'CSV' })
  @IsOptional()
  @IsIn(['CSV', 'PDF', 'XLSX'])
  outputFormat?: 'CSV' | 'PDF' | 'XLSX';

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateScheduledReportDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reportName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  templateName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  reportParams?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  scheduleCron?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ enum: ['EMAIL', 'IN_APP', 'BOTH'] })
  @IsOptional()
  @IsIn(['EMAIL', 'IN_APP', 'BOTH'])
  deliveryChannel?: 'EMAIL' | 'IN_APP' | 'BOTH';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  recipientIds?: string[];

  @ApiPropertyOptional({ enum: ['CSV', 'PDF', 'XLSX'] })
  @IsOptional()
  @IsIn(['CSV', 'PDF', 'XLSX'])
  outputFormat?: 'CSV' | 'PDF' | 'XLSX';

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export interface ScheduledReportDto {
  id: string;
  schoolId: string;
  reportName: string;
  templateName: string;
  reportParams: Record<string, unknown>;
  scheduleCron: string;
  timezone: string;
  deliveryChannel: 'EMAIL' | 'IN_APP' | 'BOTH';
  recipientIds: string[];
  outputFormat: 'CSV' | 'PDF' | 'XLSX';
  isActive: boolean;
  lastRunAt: string | null;
  lastRunStatus: 'SUCCESS' | 'FAILED' | null;
  nextRunAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StateReportTemplateDto {
  id: string;
  stateCode: string;
  reportType: string;
  schemaVersion: string;
  templateConfig: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** ─── Pagination + filter args ────────────────────────────────────── */

export class ListAttendanceArgs {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  classId?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class ListAcademicArgs {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gradeLevel?: string;

  @ApiPropertyOptional({ description: 'true to include only at-risk students' })
  @IsOptional()
  @IsBoolean()
  atRiskOnly?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
