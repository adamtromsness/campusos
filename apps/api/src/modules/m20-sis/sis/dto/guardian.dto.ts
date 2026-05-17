import { ApiProperty } from '@nestjs/swagger';

export class GuardianResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() personId!: string;
  @ApiProperty({ nullable: true }) accountId!: string | null;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() relationship!: string;
  @ApiProperty() preferredContactMethod!: string;
  @ApiProperty({ nullable: true }) familyId!: string | null;
}

export class StudentGuardianDto extends GuardianResponseDto {
  @ApiProperty() hasCustody!: boolean;
  @ApiProperty() isEmergencyContact!: boolean;
  @ApiProperty() receivesReports!: boolean;
  @ApiProperty() portalAccess!: boolean;
  @ApiProperty() portalAccessScope!: string;
}
