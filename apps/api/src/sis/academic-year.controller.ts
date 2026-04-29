import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/require-permission.decorator';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';

interface AcademicYearRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
}

export class AcademicYearDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiProperty() isCurrent!: boolean;
}

@ApiTags('Academic Years')
@ApiBearerAuth()
@Controller('academic-years')
export class AcademicYearController {
  constructor(private readonly tenant: TenantPrismaService) {}

  @Get()
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'List academic years for the current school' })
  async list(): Promise<AcademicYearDto[]> {
    return this.tenant.executeInTenantContext(async (tx) => {
      const rows = await tx.$queryRawUnsafe<AcademicYearRow[]>(
        'SELECT id, name, start_date::text AS start_date, end_date::text AS end_date, is_current ' +
          'FROM sis_academic_years ORDER BY start_date DESC',
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        startDate: r.start_date,
        endDate: r.end_date,
        isCurrent: r.is_current,
      }));
    });
  }
}
