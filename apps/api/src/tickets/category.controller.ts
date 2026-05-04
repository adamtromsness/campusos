import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CategoryService } from './category.service';
import {
  CategoryResponseDto,
  CreateCategoryDto,
  CreateSubcategoryDto,
  SubcategoryResponseDto,
  UpdateCategoryDto,
  UpdateSubcategoryDto,
} from './dto/ticket.dto';

class ListCategoriesQuery {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

@ApiTags('Ticket Categories')
@ApiBearerAuth()
@Controller()
export class CategoryController {
  constructor(private readonly categories: CategoryService) {}

  @Get('ticket-categories')
  @RequirePermission('it-001:read')
  @ApiOperation({ summary: 'Tree of ticket categories with subcategories inlined.' })
  list(@Query() query: ListCategoriesQuery): Promise<CategoryResponseDto[]> {
    return this.categories.list(!!query.includeInactive);
  }

  @Post('ticket-categories')
  @RequirePermission('it-001:admin')
  @ApiOperation({ summary: 'Create a top-level or nested category. Admin-only.' })
  createCategory(@Body() body: CreateCategoryDto): Promise<CategoryResponseDto> {
    return this.categories.createCategory(body);
  }

  @Patch('ticket-categories/:id')
  @RequirePermission('it-001:admin')
  @ApiOperation({ summary: 'Edit a category. Admin-only. Supports soft-deactivate via isActive.' })
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    return this.categories.updateCategory(id, body);
  }

  @Post('ticket-subcategories')
  @RequirePermission('it-001:admin')
  @ApiOperation({ summary: 'Create a subcategory leaf with optional auto-assignment hint.' })
  createSubcategory(@Body() body: CreateSubcategoryDto): Promise<SubcategoryResponseDto> {
    return this.categories.createSubcategory(body);
  }

  @Patch('ticket-subcategories/:id')
  @RequirePermission('it-001:admin')
  @ApiOperation({ summary: 'Edit a subcategory leaf. Admin-only.' })
  updateSubcategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSubcategoryDto,
  ): Promise<SubcategoryResponseDto> {
    return this.categories.updateSubcategory(id, body);
  }
}
