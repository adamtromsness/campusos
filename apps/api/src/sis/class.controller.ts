import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ClassService } from './class.service';
import { ClassResponseDto, ListClassesQueryDto, RosterEntryDto } from './dto/class.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classes')
@ApiBearerAuth()
@Controller('classes')
export class ClassController {
  constructor(
    private readonly classes: ClassService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('my')
  @RequirePermission('stu-001:read', 'att-001:read')
  @ApiOperation({ summary: 'List classes taught by the authenticated user' })
  async my(@Req() req: AuthedRequest): Promise<ClassResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    if (!actor.employeeId) return [];
    return this.classes.listForTeacherEmployee(actor.employeeId);
  }

  @Get()
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'List classes in the current school (filterable)' })
  async list(@Query() query: ListClassesQueryDto): Promise<ClassResponseDto[]> {
    return this.classes.list(query);
  }

  @Get(':id')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'Get a single class by id' })
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<ClassResponseDto> {
    return this.classes.getById(id);
  }

  @Get(':id/roster')
  @RequirePermission('stu-001:read', 'att-001:read')
  @ApiOperation({ summary: 'Active student enrollments for a class — used by the attendance UI' })
  async roster(@Param('id', ParseUUIDPipe) id: string): Promise<RosterEntryDto[]> {
    return this.classes.getRoster(id);
  }
}
