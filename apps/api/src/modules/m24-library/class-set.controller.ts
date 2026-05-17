import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ClassSetService } from './class-set.service';
import {
  ClassSetCheckoutResponseDto,
  CreateClassSetCheckoutDto,
  ListClassSetsArgsDto,
  ReturnClassSetCopiesDto,
} from './dto/library-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library Advanced — Class Sets')
@ApiBearerAuth()
@Controller()
export class ClassSetController {
  constructor(
    private readonly classSets: ClassSetService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('library/class-sets')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'List class set checkouts. Filters by status (ACTIVE / PARTIALLY_RETURNED / RETURNED / OVERDUE) and teacherPatronId.',
  })
  async list(@Query() args: ListClassSetsArgsDto): Promise<ClassSetCheckoutResponseDto[]> {
    return this.classSets.list(args);
  }

  @Get('library/class-sets/:id')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'Fetch a class set checkout with item + teacher details joined inline. Use GET /library/checkouts?classSetCheckoutId= to list the individual lib_checkouts under this class set.',
  })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<ClassSetCheckoutResponseDto> {
    return this.classSets.getById(id);
  }

  @Post('library/class-sets')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'KEYSTONE — Librarian creates a class set checkout. The service runs the full INSERT chain in one tenant tx — validate copy_count <= available copies, lock the copies with FOR UPDATE, INSERT the parent row, INSERT copy_count individual lib_checkouts linked via class_set_checkout_id, flip each copy to is_available=false/CHECKED_OUT. Validates the teacherPatronId resolves to an hr_employees row in this tenant. Returns 400 on insufficient available copies, on bogus teacherPatronId, on copy_count<1, or on dueDate < checkoutDate.',
  })
  async create(
    @Body() body: CreateClassSetCheckoutDto,
    @Req() req: AuthedRequest,
  ): Promise<ClassSetCheckoutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.classSets.create(body, actor);
  }

  @Post('library/class-sets/:id/return')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'Return N copies of a class set. Walks the state machine: 0 < returned_count < copy_count → PARTIALLY_RETURNED, returned_count = copy_count → RETURNED. Optionally accepts specific barcodes; otherwise the service picks the oldest still-ACTIVE rows under this class set. All flips run inside one tenant tx.',
  })
  async returnCopies(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReturnClassSetCopiesDto,
    @Req() req: AuthedRequest,
  ): Promise<ClassSetCheckoutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.classSets.returnCopies(id, body, actor);
  }
}
