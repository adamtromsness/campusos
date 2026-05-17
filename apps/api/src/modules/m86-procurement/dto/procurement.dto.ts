import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── Enums (kept in sync with the SQL CHECK constraints) ───

export type ReqUrgency = 'ROUTINE' | 'URGENT' | 'EMERGENCY';
export type ReqStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'DEPT_APPROVED'
  | 'ADMIN_APPROVED'
  | 'DISTRICT_APPROVED'
  | 'ORDERED'
  | 'RECEIVED'
  | 'DISTRIBUTED'
  | 'CLOSED'
  | 'REJECTED';
export type DestinationModule =
  | 'tech'
  | 'trn'
  | 'fds'
  | 'lib'
  | 'ath'
  | 'ext'
  | 'fac'
  | 'str'
  | 'general';
export type DistDestinationModule = Exclude<DestinationModule, 'general'>;
export type POStatus =
  | 'DRAFT'
  | 'ISSUED'
  | 'ACKNOWLEDGED'
  | 'SHIPPED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED';
export type InspectionOutcome = 'ACCEPTED' | 'ACCEPTED_WITH_DISCREPANCY' | 'REJECTED';
export type ReceiptCondition = 'GOOD' | 'DAMAGED' | 'DEFECTIVE';
export type CommitmentStatus = 'COMMITTED' | 'PARTIALLY_RELEASED' | 'RELEASED';
export type ReturnType = 'DAMAGED' | 'DEFECTIVE' | 'WARRANTY_CLAIM';
export type ReturnStatus = 'INITIATED' | 'SHIPPED_TO_VENDOR' | 'RESOLVED' | 'CANCELLED';
export type ReturnResolution = 'REPLACED' | 'REFUNDED' | 'CREDITED';

const REQ_URGENCIES: ReqUrgency[] = ['ROUTINE', 'URGENT', 'EMERGENCY'];
const DEST_MODULES: DestinationModule[] = [
  'tech',
  'trn',
  'fds',
  'lib',
  'ath',
  'ext',
  'fac',
  'str',
  'general',
];
const DIST_DEST_MODULES: DistDestinationModule[] = [
  'tech',
  'trn',
  'fds',
  'lib',
  'ath',
  'ext',
  'fac',
  'str',
];
const RETURN_TYPES: ReturnType[] = ['DAMAGED', 'DEFECTIVE', 'WARRANTY_CLAIM'];
const RETURN_STATUSES: ReturnStatus[] = ['INITIATED', 'SHIPPED_TO_VENDOR', 'RESOLVED', 'CANCELLED'];
const RETURN_RESOLUTIONS: ReturnResolution[] = ['REPLACED', 'REFUNDED', 'CREDITED'];
const RECEIPT_CONDITIONS: ReceiptCondition[] = ['GOOD', 'DAMAGED', 'DEFECTIVE'];
const INSPECTION_OUTCOMES: InspectionOutcome[] = [
  'ACCEPTED',
  'ACCEPTED_WITH_DISCREPANCY',
  'REJECTED',
];

// ─── Requisition DTOs ───

export class RequisitionLineDto {
  @ApiProperty() id!: string;
  @ApiProperty() requisitionId!: string;
  @ApiProperty() itemDescription!: string;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional({ nullable: true }) unit!: string | null;
  @ApiPropertyOptional({ nullable: true }) estimatedUnitCost!: number | null;
  @ApiPropertyOptional({ nullable: true }) specifications!: string | null;
  @ApiPropertyOptional({ nullable: true }) preferredVendorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) preferredVendorName!: string | null;
  @ApiProperty({ enum: DEST_MODULES }) destinationModule!: DestinationModule;
  @ApiProperty() lineOrder!: number;
}

export class RequisitionDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() requestingPersonId!: string;
  @ApiPropertyOptional({ nullable: true }) requestingPersonName!: string | null;
  @ApiPropertyOptional({ nullable: true }) requestingDepartment!: string | null;
  @ApiProperty({ enum: REQ_URGENCIES }) urgency!: ReqUrgency;
  @ApiProperty() status!: ReqStatus;
  @ApiPropertyOptional({ nullable: true }) approvalRequestId!: string | null;
  @ApiProperty() totalEstimatedCost!: number;
  @ApiPropertyOptional({ nullable: true }) budgetLineId!: string | null;
  @ApiPropertyOptional({ nullable: true }) budgetAccountCode!: string | null;
  @ApiProperty() justification!: string;
  @ApiPropertyOptional({ nullable: true }) submittedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedByName!: string | null;
  @ApiPropertyOptional({ nullable: true }) rejectionReason!: string | null;
  @ApiProperty() lines!: RequisitionLineDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateRequisitionLineDto {
  @IsString() @MaxLength(500) itemDescription!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsString() @MaxLength(50) unit?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) estimatedUnitCost?: number;
  @IsOptional() @IsString() @MaxLength(2000) specifications?: string;
  @IsOptional() @IsUUID() preferredVendorId?: string;
  @IsIn(DEST_MODULES) destinationModule!: DestinationModule;
}

export class CreateRequisitionDto {
  @IsOptional() @IsString() @MaxLength(100) requestingDepartment?: string;
  @IsOptional() @IsIn(REQ_URGENCIES) urgency?: ReqUrgency;
  @IsOptional() @IsUUID() budgetLineId?: string;
  @IsString() @MaxLength(2000) justification!: string;
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateRequisitionLineDto)
  lines!: CreateRequisitionLineDto[];
}

export class ApproveRequisitionDto {
  @IsIn(['DEPT_APPROVED', 'ADMIN_APPROVED', 'DISTRICT_APPROVED'])
  toStatus!: 'DEPT_APPROVED' | 'ADMIN_APPROVED' | 'DISTRICT_APPROVED';
}

export class RejectRequisitionDto {
  @IsString() @MaxLength(2000) reason!: string;
}

// ─── Purchase Order DTOs ───

export class PurchaseOrderLineDto {
  @ApiProperty() id!: string;
  @ApiProperty() purchaseOrderId!: string;
  @ApiPropertyOptional({ nullable: true }) requisitionLineId!: string | null;
  @ApiProperty() itemDescription!: string;
  @ApiProperty() quantityOrdered!: number;
  @ApiProperty() quantityReceived!: number;
  @ApiProperty() unitCost!: number;
  @ApiProperty() lineTotal!: number;
  @ApiPropertyOptional({ nullable: true }) glAccountId!: string | null;
  @ApiPropertyOptional({ nullable: true }) glAccountCode!: string | null;
  @ApiProperty({ enum: DEST_MODULES }) destinationModule!: DestinationModule;
  @ApiProperty() lineOrder!: number;
}

export class PurchaseOrderDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() poNumber!: string;
  @ApiProperty() vendorId!: string;
  @ApiPropertyOptional({ nullable: true }) vendorName!: string | null;
  @ApiPropertyOptional({ nullable: true }) requisitionId!: string | null;
  @ApiProperty() deliveryAddress!: string;
  @ApiPropertyOptional({ nullable: true }) expectedDeliveryDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) paymentTerms!: string | null;
  @ApiProperty() status!: POStatus;
  @ApiProperty() totalAmount!: number;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiPropertyOptional({ nullable: true }) issuedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) issuedByName!: string | null;
  @ApiPropertyOptional({ nullable: true }) issuedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) cancelledAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) cancelReason!: string | null;
  @ApiProperty() lines!: PurchaseOrderLineDto[];
  @ApiProperty() commitments!: BudgetCommitmentDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreatePOLineDto {
  @IsOptional() @IsUUID() requisitionLineId?: string;
  @IsString() @MaxLength(500) itemDescription!: string;
  @IsInt() @Min(1) quantityOrdered!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unitCost!: number;
  @IsOptional() @IsUUID() glAccountId?: string;
  @IsIn(DEST_MODULES) destinationModule!: DestinationModule;
}

export class CreatePurchaseOrderDto {
  @IsUUID() vendorId!: string;
  @IsOptional() @IsUUID() requisitionId?: string;
  @IsString() @MaxLength(500) deliveryAddress!: string;
  @IsOptional() @IsDateString() expectedDeliveryDate?: string;
  @IsOptional() @IsString() @MaxLength(50) paymentTerms?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsUUID() budgetLineId?: string;
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreatePOLineDto)
  lines!: CreatePOLineDto[];
}

export class POTransitionDto {
  @IsIn(['ISSUE', 'ACKNOWLEDGE', 'SHIP', 'CLOSE', 'CANCEL']) action!:
    | 'ISSUE'
    | 'ACKNOWLEDGE'
    | 'SHIP'
    | 'CLOSE'
    | 'CANCEL';
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

// ─── Goods Receipt DTOs ───

export class ReceiptLineDto {
  @ApiProperty() id!: string;
  @ApiProperty() receiptId!: string;
  @ApiProperty() poLineId!: string;
  @ApiProperty() poItemDescription!: string;
  @ApiProperty() quantityReceived!: number;
  @ApiProperty() quantityAccepted!: number;
  @ApiProperty() quantityRejected!: number;
  @ApiProperty({ enum: RECEIPT_CONDITIONS }) condition!: ReceiptCondition;
  @ApiPropertyOptional({ nullable: true }) discrepancyNotes!: string | null;
}

export class GoodsReceiptDto {
  @ApiProperty() id!: string;
  @ApiProperty() purchaseOrderId!: string;
  @ApiProperty() poNumber!: string;
  @ApiProperty() receivedBy!: string;
  @ApiPropertyOptional({ nullable: true }) receivedByName!: string | null;
  @ApiProperty() receivedAt!: string;
  @ApiProperty({ enum: INSPECTION_OUTCOMES }) inspectionOutcome!: InspectionOutcome;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() lines!: ReceiptLineDto[];
}

export class CreateReceiptLineDto {
  @IsUUID() poLineId!: string;
  @IsInt() @Min(1) quantityReceived!: number;
  @IsInt() @Min(0) quantityAccepted!: number;
  @IsInt() @Min(0) quantityRejected!: number;
  @IsIn(RECEIPT_CONDITIONS) condition!: ReceiptCondition;
  @IsOptional() @IsString() @MaxLength(2000) discrepancyNotes?: string;
}

export class CreateGoodsReceiptDto {
  @IsIn(INSPECTION_OUTCOMES) inspectionOutcome!: InspectionOutcome;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateReceiptLineDto)
  lines!: CreateReceiptLineDto[];
}

// ─── Budget Commitments ───

export class BudgetCommitmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() purchaseOrderId!: string;
  @ApiProperty() budgetLineId!: string;
  @ApiPropertyOptional({ nullable: true }) budgetAccountCode!: string | null;
  @ApiProperty() committedAmount!: number;
  @ApiProperty() releasedAmount!: number;
  @ApiProperty() status!: CommitmentStatus;
  @ApiPropertyOptional({ nullable: true }) releasedAt!: string | null;
}

// ─── Distribution DTOs ───

export class DistributionLineDto {
  @ApiProperty() id!: string;
  @ApiProperty() distributionId!: string;
  @ApiProperty() receiptLineId!: string;
  @ApiProperty() quantityDistributed!: number;
  @ApiProperty() itemDescription!: string;
  @ApiPropertyOptional({ nullable: true }) unitCost!: number | null;
}

export class DistributionDto {
  @ApiProperty() id!: string;
  @ApiProperty() receiptId!: string;
  @ApiProperty() distributedBy!: string;
  @ApiPropertyOptional({ nullable: true }) distributedByName!: string | null;
  @ApiProperty() distributedAt!: string;
  @ApiProperty({ enum: DIST_DEST_MODULES }) destinationModule!: DistDestinationModule;
  @ApiPropertyOptional({ nullable: true }) destinationDepartment!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() lines!: DistributionLineDto[];
}

export class CreateDistributionLineDto {
  @IsUUID() receiptLineId!: string;
  @IsInt() @Min(1) quantityDistributed!: number;
  @IsString() @MaxLength(500) itemDescription!: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unitCost?: number;
}

export class CreateDistributionDto {
  @IsIn(DIST_DEST_MODULES) destinationModule!: DistDestinationModule;
  @IsOptional() @IsString() @MaxLength(100) destinationDepartment?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateDistributionLineDto)
  lines!: CreateDistributionLineDto[];
}

// ─── Returns ───

export class ReturnDto {
  @ApiProperty() id!: string;
  @ApiProperty() receiptLineId!: string;
  @ApiProperty({ enum: RETURN_TYPES }) returnType!: ReturnType;
  @ApiProperty() quantityReturned!: number;
  @ApiPropertyOptional({ nullable: true }) returnReference!: string | null;
  @ApiPropertyOptional({ nullable: true }) vendorRmaNumber!: string | null;
  @ApiProperty({ enum: RETURN_STATUSES }) status!: ReturnStatus;
  @ApiPropertyOptional({ nullable: true, enum: RETURN_RESOLUTIONS })
  resolution!: ReturnResolution | null;
  @ApiPropertyOptional({ nullable: true }) resolutionNotes!: string | null;
  @ApiProperty() initiatedBy!: string;
  @ApiPropertyOptional({ nullable: true }) initiatedByName!: string | null;
  @ApiProperty() initiatedAt!: string;
  @ApiPropertyOptional({ nullable: true }) resolvedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) resolvedBy!: string | null;
}

export class CreateReturnDto {
  @IsIn(RETURN_TYPES) returnType!: ReturnType;
  @IsInt() @Min(1) quantityReturned!: number;
  @IsOptional() @IsString() @MaxLength(100) returnReference?: string;
  @IsOptional() @IsString() @MaxLength(100) vendorRmaNumber?: string;
}

export class UpdateReturnDto {
  @IsIn(['SHIP', 'RESOLVE', 'CANCEL']) action!: 'SHIP' | 'RESOLVE' | 'CANCEL';
  @IsOptional() @IsIn(RETURN_RESOLUTIONS) resolution?: ReturnResolution;
  @IsOptional() @IsString() @MaxLength(2000) resolutionNotes?: string;
}

// ─── Vendor Performance ───

export class VendorPerformanceDto {
  @ApiProperty() id!: string;
  @ApiProperty() vendorId!: string;
  @ApiPropertyOptional({ nullable: true }) vendorName!: string | null;
  @ApiProperty() schoolId!: string;
  @ApiProperty() totalOrders!: number;
  @ApiProperty() onTimeDeliveries!: number;
  @ApiProperty() lateDeliveries!: number;
  @ApiProperty() acceptedCount!: number;
  @ApiProperty() rejectedCount!: number;
  @ApiPropertyOptional({ nullable: true }) averageQualityScore!: number | null;
  @ApiPropertyOptional({ nullable: true }) averageDeliveryScore!: number | null;
  @ApiProperty() lastUpdatedAt!: string;
}

// ─── Procurement Settings ───

export class ProcurementSettingsDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional({ nullable: true }) autoPoThreshold!: number | null;
  @ApiProperty() defaultPaymentTerms!: string;
  @ApiProperty() poNumberPrefix!: string;
  @ApiProperty() poNumberNextSeq!: number;
  @ApiPropertyOptional({ nullable: true }) requireThreeQuotesAbove!: number | null;
}

export class UpdateProcurementSettingsDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) autoPoThreshold?: number;
  @IsOptional() @IsString() @MaxLength(50) defaultPaymentTerms?: string;
  @IsOptional() @IsString() @MaxLength(20) poNumberPrefix?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) requireThreeQuotesAbove?: number;
}
