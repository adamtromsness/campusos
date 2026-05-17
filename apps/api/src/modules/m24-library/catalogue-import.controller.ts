import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { CatalogueImportService } from './catalogue-import.service';
import {
  CatalogueImportJobResponseDto,
  CreateCatalogueImportJobDto,
} from './dto/library-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library Advanced — Catalogue Import')
@ApiBearerAuth()
@Controller()
export class CatalogueImportController {
  constructor(
    private readonly imports: CatalogueImportService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('library/imports')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'List catalogue import jobs newest first. The Step 6 admin UI surfaces a progress tracker per job (imported / skipped / failed counters + status pill).',
  })
  async list(): Promise<CatalogueImportJobResponseDto[]> {
    return this.imports.list();
  }

  @Get('library/imports/:id')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'Fetch a single import job with status + counters + error_log_s3_key. The Step 6 UI exposes the error log download link when records_failed > 0.',
  })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<CatalogueImportJobResponseDto> {
    return this.imports.getById(id);
  }

  @Post('library/imports')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'Librarian or admin queues a catalogue import job. ISBN_BATCH carries an inline isbns array; MARC_IMPORT / CSV_UPLOAD require sourceFileS3Key referencing an uploaded file. The CatalogueImportWorker picks up QUEUED jobs every minute and processes them asynchronously. ISBN dedup is the contract — duplicate ISBNs count as records_skipped, not records_failed.',
  })
  async create(
    @Body() body: CreateCatalogueImportJobDto,
    @Req() req: AuthedRequest,
  ): Promise<CatalogueImportJobResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.imports.create(body, actor);
  }
}
