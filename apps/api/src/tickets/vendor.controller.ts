import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { VendorService } from './vendor.service';
import { CreateVendorDto, UpdateVendorDto, VendorResponseDto } from './dto/ticket.dto';

class ListVendorsQuery {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

@ApiTags('Ticket Vendors')
@ApiBearerAuth()
@Controller('ticket-vendors')
export class VendorController {
  constructor(private readonly vendors: VendorService) {}

  @Get()
  @RequirePermission('it-001:read')
  @ApiOperation({
    summary: 'List vendors. Preferred vendors first, then alphabetical.',
  })
  list(@Query() query: ListVendorsQuery): Promise<VendorResponseDto[]> {
    return this.vendors.list(!!query.includeInactive);
  }

  @Post()
  @RequirePermission('it-001:admin')
  @ApiOperation({ summary: 'Register a new external vendor. Admin-only.' })
  create(@Body() body: CreateVendorDto): Promise<VendorResponseDto> {
    return this.vendors.create(body);
  }

  @Patch(':id')
  @RequirePermission('it-001:admin')
  @ApiOperation({
    summary: 'Edit a vendor record. Admin-only. Supports soft-deactivate via isActive.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateVendorDto,
  ): Promise<VendorResponseDto> {
    return this.vendors.update(id, body);
  }
}
