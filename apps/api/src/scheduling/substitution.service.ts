import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { ListSubstitutionsQueryDto, SubstitutionResponseDto } from './dto/coverage.dto';

interface SubRow {
  id: string;
  school_id: string;
  original_slot_id: string;
  class_section_code: string;
  course_name: string;
  period_name: string;
  effective_date: string;
  substitute_id: string;
  sub_first_name: string;
  sub_last_name: string;
  room_id: string;
  room_name: string;
  coverage_request_id: string | null;
  absent_teacher_first_name: string | null;
  absent_teacher_last_name: string | null;
  notes: string | null;
}

function rowToDto(row: SubRow): SubstitutionResponseDto {
  var absentName: string | null = null;
  if (row.absent_teacher_first_name && row.absent_teacher_last_name) {
    absentName = row.absent_teacher_first_name + ' ' + row.absent_teacher_last_name;
  }
  return {
    id: row.id,
    schoolId: row.school_id,
    originalSlotId: row.original_slot_id,
    classSectionCode: row.class_section_code,
    courseName: row.course_name,
    periodName: row.period_name,
    effectiveDate: row.effective_date,
    substituteId: row.substitute_id,
    substituteName: row.sub_first_name + ' ' + row.sub_last_name,
    roomId: row.room_id,
    roomName: row.room_name,
    coverageRequestId: row.coverage_request_id,
    absentTeacherName: absentName,
    notes: row.notes,
  };
}

var SELECT_SUB_BASE =
  'SELECT st.id, st.school_id, st.original_slot_id, ' +
  'c.section_code AS class_section_code, co.name AS course_name, p.name AS period_name, ' +
  "TO_CHAR(st.effective_date, 'YYYY-MM-DD') AS effective_date, " +
  'st.substitute_id, sub_ip.first_name AS sub_first_name, sub_ip.last_name AS sub_last_name, ' +
  'st.room_id, r.name AS room_name, ' +
  'st.coverage_request_id, ' +
  'abs_ip.first_name AS absent_teacher_first_name, abs_ip.last_name AS absent_teacher_last_name, ' +
  'st.notes ' +
  'FROM sch_substitution_timetable st ' +
  'JOIN sch_timetable_slots ts ON ts.id = st.original_slot_id ' +
  'JOIN sis_classes c ON c.id = ts.class_id ' +
  'JOIN sis_courses co ON co.id = c.course_id ' +
  'JOIN sch_periods p ON p.id = ts.period_id ' +
  'JOIN sch_rooms r ON r.id = st.room_id ' +
  'JOIN hr_employees sub_e ON sub_e.id = st.substitute_id ' +
  'JOIN platform.iam_person sub_ip ON sub_ip.id = sub_e.person_id ' +
  'LEFT JOIN sch_coverage_requests cr ON cr.id = st.coverage_request_id ' +
  'LEFT JOIN hr_employees abs_e ON abs_e.id = cr.absent_teacher_id ' +
  'LEFT JOIN platform.iam_person abs_ip ON abs_ip.id = abs_e.person_id ';

@Injectable()
export class SubstitutionService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(query: ListSubstitutionsQueryDto): Promise<SubstitutionResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SubRow[]>(
        SELECT_SUB_BASE +
          'WHERE ($1::date IS NULL OR st.effective_date >= $1::date) ' +
          'AND ($2::date IS NULL OR st.effective_date <= $2::date) ' +
          'ORDER BY st.effective_date, p.start_time',
        query.fromDate ?? null,
        query.toDate ?? null,
      );
    });
    return rows.map(rowToDto);
  }

  async listForTeacher(
    employeeId: string,
    query: ListSubstitutionsQueryDto,
  ): Promise<SubstitutionResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SubRow[]>(
        SELECT_SUB_BASE +
          'WHERE st.substitute_id = $1::uuid ' +
          'AND ($2::date IS NULL OR st.effective_date >= $2::date) ' +
          'AND ($3::date IS NULL OR st.effective_date <= $3::date) ' +
          'ORDER BY st.effective_date, p.start_time',
        employeeId,
        query.fromDate ?? null,
        query.toDate ?? null,
      );
    });
    return rows.map(rowToDto);
  }
}
