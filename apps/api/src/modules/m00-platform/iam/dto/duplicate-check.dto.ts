import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Account Creation spec, Step 3 — request for the privacy-safe
 * duplicate check. A "strong match" needs EITHER an exact email OR the
 * full (firstName + lastName + dateOfBirth) triple; partial name alone
 * never matches (that would enable account enumeration). All fields are
 * optional at the DTO layer so the caller can probe on email-blur (email
 * only) or after the identity fields are filled — the service decides
 * whether enough was supplied to evaluate a strong match.
 */
export class CheckDuplicateDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateOfBirth?: string;
}

/**
 * Deliberately MINIMAL response. On a strong match we surface only what
 * the creator needs to recognise the person and decide whether to link —
 * never their email, DOB, phone, medical, or any other PII. `displayName`
 * is given-name + last initial only ("Alivia T."); `context` is a coarse
 * role/affiliation label, never a precise record.
 */
export class CheckDuplicateResultDto {
  @ApiProperty() exists!: boolean;
  // Present only when exists === true.
  @ApiPropertyOptional() displayName?: string;
  // Coarse role label ("Parent", "Student", "Staff member", …). No school
  // name (that would require a cross-tenant lookup AND leak affiliation).
  @ApiPropertyOptional() context?: string;
  // True when the matched account is already managed by the caller (e.g. a
  // minor they created). Drives the UI's "link directly" vs "send a
  // claim request" branch — only the managed-by-me case links without the
  // other owner's consent.
  @ApiPropertyOptional() alreadyManagedByCurrentUser?: boolean;
}
