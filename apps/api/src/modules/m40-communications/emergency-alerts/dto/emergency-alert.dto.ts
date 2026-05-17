import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'URGENT', 'EMERGENCY'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_CHANNELS = ['PUSH', 'SMS', 'EMAIL', 'APP'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const ALERT_STATUSES = ['ACTIVE', 'RESOLVED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const DELIVERY_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'FAILED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export class AlertTypeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty({ enum: ALERT_SEVERITIES }) severity!: AlertSeverity;
  @ApiProperty({ type: [String] }) defaultChannels!: AlertChannel[];
  @ApiProperty() requiresAcknowledgement!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateAlertTypeDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: ALERT_SEVERITIES })
  @IsIn(ALERT_SEVERITIES as unknown as string[])
  severity!: AlertSeverity;

  @ApiProperty({ type: [String], enum: ALERT_CHANNELS })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ALERT_CHANNELS as unknown as string[], { each: true })
  defaultChannels!: AlertChannel[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresAcknowledgement?: boolean;
}

export class UpdateAlertTypeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: ALERT_SEVERITIES })
  @IsOptional()
  @IsIn(ALERT_SEVERITIES as unknown as string[])
  severity?: AlertSeverity;

  @ApiPropertyOptional({ type: [String], enum: ALERT_CHANNELS })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ALERT_CHANNELS as unknown as string[], { each: true })
  defaultChannels?: AlertChannel[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresAcknowledgement?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class EmergencyAlertDeliveryDto {
  @ApiProperty() id!: string;
  @ApiProperty() alertId!: string;
  @ApiProperty() recipientId!: string;
  @ApiPropertyOptional() recipientName?: string | null;
  @ApiProperty({ enum: ALERT_CHANNELS }) channel!: AlertChannel;
  @ApiProperty({ enum: DELIVERY_STATUSES }) status!: DeliveryStatus;
  @ApiPropertyOptional() sentAt?: string | null;
  @ApiPropertyOptional() acknowledgedAt?: string | null;
  @ApiPropertyOptional() failureReason?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class EmergencyAlertResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() alertTypeId!: string;
  @ApiPropertyOptional() alertTypeName?: string | null;
  @ApiProperty({ enum: ALERT_SEVERITIES }) alertSeverity!: AlertSeverity;
  @ApiProperty() requiresAcknowledgement!: boolean;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty() issuedBy!: string;
  @ApiPropertyOptional() issuedByName?: string | null;
  @ApiPropertyOptional() incidentId?: string | null;
  @ApiProperty() issuedAt!: string;
  @ApiProperty({ enum: ALERT_STATUSES }) status!: AlertStatus;
  @ApiPropertyOptional() resolvedAt?: string | null;
  @ApiPropertyOptional() resolvedBy?: string | null;
  @ApiPropertyOptional() resolvedByName?: string | null;
  @ApiPropertyOptional({ type: [EmergencyAlertDeliveryDto] })
  deliveries?: EmergencyAlertDeliveryDto[];
  @ApiPropertyOptional()
  myDelivery?: EmergencyAlertDeliveryDto | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class IssueEmergencyAlertDto {
  @ApiProperty()
  @IsUUID()
  alertTypeId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @ApiPropertyOptional({ description: 'Soft ref to a future inc_incidents row' })
  @IsOptional()
  @IsUUID()
  incidentId?: string;

  @ApiPropertyOptional({ description: 'Override default channels for this issue' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ALERT_CHANNELS as unknown as string[], { each: true })
  channels?: AlertChannel[];
}

export class ListEmergencyAlertsQueryDto {
  @ApiPropertyOptional({ enum: ALERT_STATUSES })
  @IsOptional()
  @IsIn(ALERT_STATUSES as unknown as string[])
  status?: AlertStatus;
}

export class EmergencyAlertStatusDto {
  @ApiProperty() alertId!: string;
  @ApiProperty() totalDeliveries!: number;
  @ApiProperty() sentCount!: number;
  @ApiProperty() deliveredCount!: number;
  @ApiProperty() acknowledgedCount!: number;
  @ApiProperty() failedCount!: number;
  @ApiProperty() pendingCount!: number;
}
