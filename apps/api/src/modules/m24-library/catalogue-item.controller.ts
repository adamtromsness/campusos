import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { CatalogueItemService } from './catalogue-item.service';
import {
  CatalogueItemResponseDto,
  CatalogueItemSearchHitDto,
  CopyResponseDto,
  CreateCatalogueItemDto,
  UpdateCatalogueItemDto,
} from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Catalogue')
@ApiBearerAuth()
@Controller('library/catalogue')
export class CatalogueItemController {
  constructor(
    private readonly catalogue: CatalogueItemService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('lib-001:read')
  @ApiOperation({
    summary:
      'Public catalogue search. Optional ?q= drives the GIN full-text index keystone via plainto_tsquery + ts_rank ordering. Optional ?category= and ?author= filters narrow the result set. Without ?q= returns the alphabetical-by-title browse window. limit defaults to 50, max 200.',
  })
  async search(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('author') author?: string,
    @Query('limit') limit?: string,
  ): Promise<CatalogueItemSearchHitDto[]> {
    const parsedLimit =
      limit !== undefined && limit !== '' && !Number.isNaN(Number(limit))
        ? Number(limit)
        : undefined;
    return this.catalogue.search({ q, category, author, limit: parsedLimit });
  }

  @Get(':id')
  @RequirePermission('lib-001:read')
  @ApiOperation({
    summary:
      'Fetch a single catalogue item with copies inlined and the rollups (totalCopies / availableCopies / activeHoldsCount / averageRating / reviewCount) computed by sub-selects against the live circulation + reviews state.',
  })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<CatalogueItemResponseDto> {
    return this.catalogue.getById(id, true);
  }

  @Get(':id/copies')
  @RequirePermission('lib-001:read')
  @ApiOperation({
    summary:
      'List copies for a catalogue item. Each row carries the location name (joined via lib_locations) so the librarian can find a copy on the shelf without a second lookup.',
  })
  async listCopies(@Param('id', ParseUUIDPipe) id: string): Promise<CopyResponseDto[]> {
    return this.catalogue.listCopies(id);
  }

  @Post()
  @RequirePermission('lib-001:write')
  @ApiOperation({
    summary:
      'Librarian or admin creates a catalogue item. Title is required; author + ISBN + publisher + publish_year + category + dewey_decimal + description + cover_image_url are all optional. The GIN INDEX on (title || author) is updated automatically by Postgres.',
  })
  async create(
    @Body() body: CreateCatalogueItemDto,
    @Req() req: AuthedRequest,
  ): Promise<CatalogueItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.catalogue.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('lib-001:write')
  @ApiOperation({
    summary:
      'Librarian or admin updates catalogue item metadata. Locks the row inside one tenant transaction. The GIN INDEX is updated automatically by Postgres on every UPDATE that touches title or author.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCatalogueItemDto,
    @Req() req: AuthedRequest,
  ): Promise<CatalogueItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.catalogue.patch(id, body, actor);
  }
}
