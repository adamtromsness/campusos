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
import { StudentService } from './student.service';
import { FamilyService } from './family.service';
import {
  CreateStudentDto,
  ListStudentsQueryDto,
  StudentResponseDto,
  UpdateStudentDto,
} from './dto/student.dto';
import { StudentGuardianDto } from './dto/guardian.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Students')
@ApiBearerAuth()
@Controller('students')
export class StudentController {
  constructor(
    private readonly students: StudentService,
    private readonly families: FamilyService,
  ) {}

  @Get('my-children')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'List the students for whom the authenticated user is a guardian' })
  async myChildren(@Req() req: AuthedRequest): Promise<StudentResponseDto[]> {
    var personId = req.user!.personId;
    return this.students.listForGuardianPerson(personId);
  }

  @Get()
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'List students in the current school (filterable)' })
  async list(@Query() query: ListStudentsQueryDto): Promise<StudentResponseDto[]> {
    return this.students.list(query);
  }

  @Get(':id')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'Get a single student by id' })
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<StudentResponseDto> {
    return this.students.getById(id);
  }

  @Get(':id/guardians')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'Guardians attached to this student via sis_student_guardians' })
  async getGuardians(@Param('id', ParseUUIDPipe) id: string): Promise<StudentGuardianDto[]> {
    return this.families.getStudentGuardians(id);
  }

  @Post()
  @RequirePermission('stu-001:write')
  @ApiOperation({
    summary: 'Create a new student (provisions iam_person + platform_students + sis_students)',
  })
  async create(@Body() body: CreateStudentDto): Promise<StudentResponseDto> {
    return this.students.create(body);
  }

  @Patch(':id')
  @RequirePermission('stu-001:write')
  @ApiOperation({
    summary:
      'Update school-scoped fields on a student record (identity fields are immutable here per ADR-055)',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateStudentDto,
  ): Promise<StudentResponseDto> {
    return this.students.update(id, body);
  }
}
