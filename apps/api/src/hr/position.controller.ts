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
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { PositionService } from './position.service';
import {
  CreatePositionDto,
  PositionResponseDto,
  UpdatePositionDto,
} from './dto/position.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

class ListPositionsQueryDto {
  @ApiPropertyOptional({ description: 'Include inactive positions in the response.' })
  @IsOptional()
  @Transform(function (params: { value: unknown }) {
    if (typeof params.value === 'boolean') return params.value;
    if (typeof params.value === 'string') return params.value === 'true';
    return false;
  })
  @IsBoolean()
  includeInactive?: boolean;
}

@ApiTags('Positions')
@ApiBearerAuth()
@Controller('positions')
export class PositionController {
  constructor(
    private readonly positions: PositionService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('hr-001:read')
  @ApiOperation({ summary: 'List positions in the current tenant' })
  async list(@Query() query: ListPositionsQueryDto): Promise<PositionResponseDto[]> {
    return this.positions.list(query.includeInactive === true);
  }

  @Get(':id')
  @RequirePermission('hr-001:read')
  @ApiOperation({ summary: 'Get a position by id' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<PositionResponseDto> {
    return this.positions.getById(id);
  }

  @Post()
  @RequirePermission('hr-001:admin')
  @ApiOperation({ summary: 'Create a position (admin only)' })
  async create(
    @Body() body: CreatePositionDto,
    @Req() req: AuthedRequest,
  ): Promise<PositionResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.positions.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('hr-001:admin')
  @ApiOperation({ summary: 'Update a position (admin only)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePositionDto,
    @Req() req: AuthedRequest,
  ): Promise<PositionResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.positions.update(id, body, actor);
  }
}
