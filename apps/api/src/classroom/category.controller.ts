import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { CategoryService } from './category.service';
import { AssignmentCategoryDto, UpsertCategoriesDto } from './dto/category.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom — Categories')
@ApiBearerAuth()
@Controller('classes')
export class CategoryController {
  constructor(
    private readonly categories: CategoryService,
    private readonly actors: ActorContextService,
  ) {}

  @Get(':classId/categories')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'List per-class assignment categories with weights. Visible to teachers, admins, and ' +
      'enrolled students / linked parents (transparency on grading weights).',
  })
  async list(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentCategoryDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.categories.list(classId, actor);
  }

  @Put(':classId/categories')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Replace the per-class category list. Weights MUST sum to 100. Returns 409 if a ' +
      'removed category is still referenced by an assignment.',
  })
  async upsert(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Body() body: UpsertCategoriesDto,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentCategoryDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.categories.upsert(classId, body, actor);
  }
}
