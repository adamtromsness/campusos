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
      'Barcode lookup — circulation desk scans a spine and the service resolves the copy + parent catalogue item + pending hold count in one round-trip. **Active-checkout patron identity (checkoutId, patronId, patronName, dates) is included only for librarians and admins** per REVIEW-CYCLE12 BLOCKING 3; catalogue-only readers (students / parents / general staff) see `activeCheckout: null` regardless of whether the copy is on loan. Use `isCheckedOut` to know whether the copy is currently out without leaking the patron identity. The Step 6 CheckoutService.checkout reads this same shape on every scan to validate availability before flipping the copy state.',
  })
  async lookupByBarcode(
    @Param('barcode') barcode: string,
    @Req() req: AuthedRequest,
  ): Promise<BarcodeLookupResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.copies.lookupByBarcode(barcode, actor);
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
