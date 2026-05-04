import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActionTypeService } from './action-type.service';
import { CategoryService } from './category.service';
import {
  ActionTypeResponseDto,
  CategoryResponseDto,
  CreateActionTypeDto,
  CreateCategoryDto,
  UpdateActionTypeDto,
  UpdateCategoryDto,
} from './dto/discipline.dto';

class ListQuery {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

@ApiTags('Discipline Catalogue')
@ApiBearerAuth()
@Controller()
export class CategoryController {
  constructor(
    private readonly categories: CategoryService,
    private readonly actionTypes: ActionTypeService,
  ) {}

  // ─── Categories ───────────────────────────────────────────────

  @Get('discipline/categories')
  @RequirePermission('beh-001:read')
  @ApiOperation({ summary: 'List discipline categories. Active-only by default.' })
  listCategories(@Query() query: ListQuery): Promise<CategoryResponseDto[]> {
    return this.categories.list(!!query.includeInactive);
  }

  @Get('discipline/categories/:id')
  @RequirePermission('beh-001:read')
  getCategory(@Param('id', ParseUUIDPipe) id: string): Promise<CategoryResponseDto> {
    return this.categories.getById(id);
  }

  @Post('discipline/categories')
  @RequirePermission('beh-001:admin')
  @ApiOperation({ summary: 'Create a discipline category. Admin-only.' })
  createCategory(@Body() body: CreateCategoryDto): Promise<CategoryResponseDto> {
    return this.categories.create(body);
  }

  @Patch('discipline/categories/:id')
  @RequirePermission('beh-001:admin')
  @ApiOperation({ summary: 'Update a discipline category. Admin-only.' })
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    return this.categories.update(id, body);
  }

  // ─── Action Types ─────────────────────────────────────────────

  @Get('discipline/action-types')
  @RequirePermission('beh-001:read')
  @ApiOperation({
    summary:
      'List disciplinary action types. requiresParentNotification flags actions that fire the parent-notification fan-out on assignment.',
  })
  listActionTypes(@Query() query: ListQuery): Promise<ActionTypeResponseDto[]> {
    return this.actionTypes.list(!!query.includeInactive);
  }

  @Post('discipline/action-types')
  @RequirePermission('beh-001:admin')
  @ApiOperation({ summary: 'Create a disciplinary action type. Admin-only.' })
  createActionType(@Body() body: CreateActionTypeDto): Promise<ActionTypeResponseDto> {
    return this.actionTypes.create(body);
  }

  @Patch('discipline/action-types/:id')
  @RequirePermission('beh-001:admin')
  @ApiOperation({ summary: 'Update a disciplinary action type. Admin-only.' })
  updateActionType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateActionTypeDto,
  ): Promise<ActionTypeResponseDto> {
    return this.actionTypes.update(id, body);
  }
}
