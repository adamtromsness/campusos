import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export const FAMILY_CHILD_STATUSES = ['PLACEHOLDER', 'PENDING_LINK', 'LINKED'] as const;
export type FamilyChildStatus = (typeof FAMILY_CHILD_STATUSES)[number];

export class FamilyChildDto {
  @ApiProperty() id!: string;
  @ApiProperty() familyId!: string;
  @ApiPropertyOptional() personId!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional() dateOfBirth!: string | null;
  @ApiPropertyOptional() gender!: string | null;
  @ApiProperty({ enum: FAMILY_CHILD_STATUSES }) status!: FamilyChildStatus;
  @ApiPropertyOptional() inviteCode!: string | null;
  @ApiPropertyOptional() inviteEmail!: string | null;
  @ApiPropertyOptional() inviteSentAt!: string | null;
  @ApiPropertyOptional() linkedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreateFamilyChildDto {
  @ApiProperty() @IsString() @MaxLength(100) firstName!: string;
  @ApiProperty() @IsString() @MaxLength(100) lastName!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string;
}

export class UpdateFamilyChildDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string;
}

export class CreateChildAccountDto {
  // Optional — under-13 accounts are parent-managed and don't need
  // their own email. Older minors get a Keycloak account stub.
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
}

export class SendChildLinkDto {
  @ApiProperty() @IsEmail() email!: string;
}

export class AcceptFamilyLinkDto {
  // 8-char alphanumeric code — case-insensitive on lookup but stored
  // uppercase. Length 8 keeps the design doc's "ABCD-1234" shape.
  @ApiProperty() @IsString() @Length(8, 8) code!: string;
}

export const INVITATION_TYPES = ['EMPLOYEE', 'CHILD_LINK', 'PARENT_LINK', 'SUBSTITUTE'] as const;
export type InvitationType = (typeof INVITATION_TYPES)[number];

export class InvitationSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: INVITATION_TYPES }) type!: InvitationType;
  @ApiProperty() inviterName!: string;
  @ApiPropertyOptional() schoolId!: string | null;
  @ApiPropertyOptional() schoolName!: string | null;
  @ApiPropertyOptional() jobTitle!: string | null;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() status!: string;
}

export class MyInvitationDto extends InvitationSummaryDto {
  @ApiProperty() token!: string;
}

export class AcceptInvitationResultDto {
  @ApiProperty() invitationId!: string;
  @ApiProperty({ enum: INVITATION_TYPES }) type!: InvitationType;
  @ApiPropertyOptional() personaType!: string | null;
  @ApiPropertyOptional() personaId!: string | null;
  @ApiPropertyOptional() schoolId!: string | null;
}
