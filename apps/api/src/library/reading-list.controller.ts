import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ReadingListService } from './reading-list.service';
import {
  CreateReadingListDto,
  CreateReadingListItemDto,
  ReadingListItemResponseDto,
  ReadingListResponseDto,
  UpdateReadingListDto,
  UpdateReadingListItemDto,
} from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Reading Lists')
@ApiBearerAuth()
@Controller()
export class ReadingListController {
  constructor(
    private readonly lists: ReadingListService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('library/reading-lists')
  @RequirePermission('lib-003:read')
  @ApiOperation({
    summary:
      'List reading lists. Published lists are visible to everyone with lib-003:read; unpublished lists (drafts) are visible only to writers (librarian / teacher / admin) when ?includeUnpublished=true is supplied.',
  })
  async list(
    @Query('includeUnpublished') includeUnpublishedRaw: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ReadingListResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const includeUnpublished = includeUnpublishedRaw === 'true';
    return this.lists.list(actor, { includeUnpublished });
  }

  @Get('library/reading-lists/:id')
  @RequirePermission('lib-003:read')
  @ApiOperation({
    summary:
      'Fetch a reading list with items inlined (joined to lib_catalogue_items for title / author / cover_image_url). Unpublished lists 404 for non-writer readers.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReadingListResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lists.getById(id, actor);
  }

  @Post('library/reading-lists')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Librarian, teacher, or admin creates a reading list. Defaults to is_published=false (draft). UNIQUE(school_id, name, COALESCE(academic_year_id, sentinel)) catches name collisions per (school, year) — including the no-year sentinel case — and surfaces a friendly 400.',
  })
  async create(
    @Body() body: CreateReadingListDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadingListResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lists.create(body, actor);
  }

  @Patch('library/reading-lists/:id')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Update list metadata. The is_published flag is the canonical publish path: when it flips, the multi-column published_chk keystone requires published_at to be in lockstep — the service stamps both atomically (set on publish, clear on unpublish).',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReadingListDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadingListResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lists.patch(id, body, actor);
  }

  @Post('library/reading-lists/:id/items')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Add a catalogue item to a reading list. UNIQUE(reading_list_id, catalogue_item_id) refuses duplicates with a friendly 400. The added_by FK is stamped from actor.employeeId.',
  })
  async addItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateReadingListItemDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadingListItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lists.addItem(id, body, actor);
  }

  @Patch('library/reading-list-items/:id')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary: 'Update a reading list item — item_type / sort_order / notes.',
  })
  async patchItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReadingListItemDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadingListItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lists.patchItem(id, body, actor);
  }

  @Delete('library/reading-list-items/:id')
  @HttpCode(204)
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Remove an item from a reading list. Hard-delete is safe — the lib_reading_list_items row carries no audit value beyond the parent list, and the parent CASCADE handles full-list cleanup.',
  })
  async removeItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lists.removeItem(id, actor);
  }
}
