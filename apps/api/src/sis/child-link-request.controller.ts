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
import { ChildLinkRequestService } from './child-link-request.service';
import {
  ChildSearchQueryDto,
  ListLinkRequestsQueryDto,
  ReviewLinkRequestDto,
  SubmitAddNewChildDto,
  SubmitLinkExistingDto,
} from './dto/child-link-request.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Children')
@ApiBearerAuth()
@Controller('children')
export class ChildLinkRequestController {
  constructor(
    private readonly service: ChildLinkRequestService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('search')
  @RequirePermission('stu-001:read')
  @ApiOperation({
    summary:
      'Search for an existing student by first name + last name + date of birth in this tenant.',
  })
  async search(@Query() q: ChildSearchQueryDto, @Req() req: AuthedRequest) {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.searchExistingStudents(q.firstName, q.lastName, q.dateOfBirth, actor);
  }

  @Post('link-request')
  @RequirePermission('stu-001:read')
  @ApiOperation({
    summary: 'Guardian: submit a request to link an existing student to my account.',
  })
  async submitLinkExisting(@Body() body: SubmitLinkExistingDto, @Req() req: AuthedRequest) {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.submitLinkExisting(body.existingStudentId, actor);
  }

  @Post('add-request')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'Guardian: submit a request to add a new child to my account.' })
  async submitAddNew(@Body() body: SubmitAddNewChildDto, @Req() req: AuthedRequest) {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.submitAddNew(body, actor);
  }

  @Get('link-requests')
  @RequirePermission('stu-001:read')
  @ApiOperation({
    summary: 'List link/add requests. Parents see own; admins see all.',
  })
  async list(@Query() q: ListLinkRequestsQueryDto, @Req() req: AuthedRequest) {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.list({ status: q.status }, actor);
  }

  @Get('link-requests/:id')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'Get a single link request by id (own only for non-admin).' })
  async getById(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.getById(id, actor);
  }

  @Patch('link-requests/:id/approve')
  @RequirePermission('stu-001:admin')
  @ApiOperation({ summary: 'Admin: approve a PENDING link request.' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewLinkRequestDto,
    @Req() req: AuthedRequest,
  ) {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.approve(id, body.reviewerNotes, actor);
  }

  @Patch('link-requests/:id/reject')
  @RequirePermission('stu-001:admin')
  @ApiOperation({ summary: 'Admin: reject a PENDING link request.' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewLinkRequestDto,
    @Req() req: AuthedRequest,
  ) {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.reject(id, body.reviewerNotes, actor);
  }
}
