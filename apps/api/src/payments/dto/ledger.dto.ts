import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export var ENTRY_TYPES = ['CHARGE', 'PAYMENT', 'REFUND', 'CREDIT', 'ADJUSTMENT'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export class LedgerEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() familyAccountId!: string;
  @ApiProperty({ enum: ENTRY_TYPES }) entryType!: EntryType;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional({ nullable: true }) referenceId!: string | null;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) createdBy!: string | null;
  @ApiProperty() createdAt!: string;
}

export class LedgerBalanceDto {
  @ApiProperty() familyAccountId!: string;
  @ApiProperty() balance!: number;
  @ApiProperty({ description: 'Cache hit (true) or computed (false).' }) cached!: boolean;
}

export class ListLedgerQueryDto {
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Keyset cursor — keep paging older.' })
  @IsOptional()
  before?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() referenceId?: string;
}
