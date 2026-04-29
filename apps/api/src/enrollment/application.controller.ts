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
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ApplicationService } from './application.service';
import {
  ApplicationNoteDto,
  ApplicationResponseDto,
  CreateApplicationDto,
  CreateApplicationNoteDto,
  ListApplicationsQueryDto,
  UpdateApplicationStatusDto,
} from './dto/application.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrollment Applications')
@ApiBearerAuth()
@Controller('applications')
export class ApplicationController {
  constructor(
    private readonly applications: ApplicationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('stu-003:read')
  @ApiOperation({
    summary: 'List applications. Admins see all; parents see only their own.',
  })
  async list(
    @Query() query: ListApplicationsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.applications.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'Get an application (with screening, documents, notes)' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.applications.getById(id, actor);
  }

  @Post()
  @RequirePermission('stu-003:write')
  @ApiOperation({ summary: 'Submit a new application (parent or admin)' })
  async create(
    @Body() body: CreateApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.applications.create(body, actor);
  }

  @Patch(':id/status')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Admin status transition (locks row inside the tx)' })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateApplicationStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.applications.updateStatus(id, body, actor);
  }

  @Post(':id/notes')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Add an admin note to the application timeline' })
  async addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateApplicationNoteDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationNoteDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.applications.addNote(id, body, actor);
  }
}
