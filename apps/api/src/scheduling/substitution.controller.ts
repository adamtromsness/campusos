import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/require-permission.decorator';
import { SubstitutionService } from './substitution.service';
import { ListSubstitutionsQueryDto, SubstitutionResponseDto } from './dto/coverage.dto';

@ApiTags('Substitutions')
@ApiBearerAuth()
@Controller('substitutions')
export class SubstitutionController {
  constructor(private readonly subs: SubstitutionService) {}

  @Get()
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'List substitution timetable rows in a date range' })
  async list(@Query() query: ListSubstitutionsQueryDto): Promise<SubstitutionResponseDto[]> {
    return this.subs.list(query);
  }

  @Get('teacher/:employeeId')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: "A substitute teacher's assignments in a date range" })
  async forTeacher(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: ListSubstitutionsQueryDto,
  ): Promise<SubstitutionResponseDto[]> {
    return this.subs.listForTeacher(employeeId, query);
  }
}
