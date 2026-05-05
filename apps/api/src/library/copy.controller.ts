import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { CopyService } from './copy.service';
import {
  BarcodeLookupResponseDto,
  CopyResponseDto,
  CreateCopyDto,
  UpdateCopyDto,
} from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Copies')
@ApiBearerAuth()
@Controller()
export class CopyController {
  constructor(
    private readonly copies: CopyService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('library/copies/barcode/:barcode')
  @RequirePermission('lib-001:read')
  @ApiOperation({
    summary:
      'Barcode lookup keystone — the circulation desk scans a spine and the service resolves the copy + parent catalogue item + active checkout (if any) + pending hold count in one round-trip. The Step 6 CheckoutService.checkout reads this same shape on every scan to validate availability before flipping the copy state. Patron name is joined through platform.iam_person.',
  })
  async lookupByBarcode(@Param('barcode') barcode: string): Promise<BarcodeLookupResponseDto> {
    return this.copies.lookupByBarcode(barcode);
  }

  @Post('library/catalogue/:itemId/copies')
  @RequirePermission('lib-001:write')
  @ApiOperation({
    summary:
      'Librarian or admin adds a copy under a catalogue item. UNIQUE(barcode) catch surfaces duplicate-barcode collisions as a friendly 400. FK rejection on locationId returns 400 with a clear message.',
  })
  async create(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: CreateCopyDto,
    @Req() req: AuthedRequest,
  ): Promise<CopyResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.copies.create(itemId, body, actor);
  }

  @Patch('library/copies/:id')
  @RequirePermission('lib-001:write')
  @ApiOperation({
    summary:
      'Librarian or admin updates copy condition, location, availability, or replacement value. Locks the row inside one tenant tx. The Step 6 CheckoutService is the canonical writer of is_available + location_status during the checkout / return / hold-fulfil lifecycle — direct PATCH from the librarian is the manual-override path.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCopyDto,
    @Req() req: AuthedRequest,
  ): Promise<CopyResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.copies.patch(id, body, actor);
  }
}
