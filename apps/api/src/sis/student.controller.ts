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
    private readonly actors: ActorContextService,
  ) {}

  @Get('my-children')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'List the students for whom the authenticated user is a guardian' })
  async myChildren(@Req() req: AuthedRequest): Promise<StudentResponseDto[]> {
    var personId = req.user!.personId;
    return this.students.listForGuardianPerson(personId);
  }

  @Get('me')
  @RequirePermission('stu-001:read')
  @ApiOperation({
    summary:
      'Resolve the calling student persona to their sis_students record. Used by the web app ' +
      "to bootstrap a STUDENT persona's own studentId without scanning the full student list. " +
      'Throws 404 if the caller is not a student in this tenant.',
  })
  async me(@Req() req: AuthedRequest): Promise<StudentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.students.getSelfForStudent(actor);
  }

  @Get()
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'List students in the current school (filterable, row-scoped)' })
  async list(
    @Query() query: ListStudentsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<StudentResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.students.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'Get a single student by id (row-scoped to the caller)' })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<StudentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.students.getById(id, actor);
  }

  @Get(':id/guardians')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'Guardians attached to this student (row-scoped to the caller)' })
  async getGuardians(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<StudentGuardianDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.students.assertCanViewStudent(id, actor);
    return this.families.getStudentGuardians(id);
  }

  @Post()
  @RequirePermission('stu-001:write')
  @ApiOperation({
    summary: 'Create a new student (provisions iam_person + platform_students + sis_students)',
  })
  async create(
    @Body() body: CreateStudentDto,
    @Req() req: AuthedRequest,
  ): Promise<StudentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.students.create(body, actor);
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
    @Req() req: AuthedRequest,
  ): Promise<StudentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.students.update(id, body, actor);
  }
}
