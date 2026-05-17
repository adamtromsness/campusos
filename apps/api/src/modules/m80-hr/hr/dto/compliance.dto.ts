import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ComplianceRowDto {
  @ApiProperty() requirementId!: string;
  @ApiProperty() requirementName!: string;
  @ApiPropertyOptional({ nullable: true }) certificationType!: string | null;
  @ApiProperty() frequency!: string;
  @ApiProperty() isCompliant!: boolean;
  @ApiPropertyOptional({ nullable: true }) lastCompletedDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) nextDueDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) linkedCertificationId!: string | null;
  @ApiPropertyOptional({ nullable: true }) daysUntilDue!: number | null;
  @ApiProperty({
    description:
      'Derived urgency tier from days_until_due. green = compliant, amber = expiring within 90, red = overdue / non-compliant.',
  })
  urgency!: 'green' | 'amber' | 'red';
}

export class EmployeeComplianceDto {
  @ApiProperty() employeeId!: string;
  @ApiProperty() employeeName!: string;
  @ApiPropertyOptional({ nullable: true }) primaryPositionTitle!: string | null;
  @ApiProperty({ type: [ComplianceRowDto] }) rows!: ComplianceRowDto[];
  @ApiProperty() totalRequirements!: number;
  @ApiProperty() compliantCount!: number;
  @ApiProperty() amberCount!: number;
  @ApiProperty() redCount!: number;
}

export class ComplianceDashboardDto {
  @ApiProperty({ type: [EmployeeComplianceDto] }) employees!: EmployeeComplianceDto[];
  @ApiProperty() totalEmployees!: number;
  @ApiProperty() employeesWithGaps!: number;
}
