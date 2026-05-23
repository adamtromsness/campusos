import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) firstName!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) lastName!: string;
  @ApiProperty() @IsEmail() @MaxLength(200) email!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string;
  // password is collected by the UI but currently ignored by the API
  // — auth lives in Keycloak (ADR-036). Keeping the field on the DTO
  // is intentional so the client can keep posting it without
  // forbidNonWhitelisted rejections; Keycloak provisioning lands when
  // the verification flow is wired.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) password?: string;
}
