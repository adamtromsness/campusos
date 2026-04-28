import {
  Body,
  Controller,
  Delete,
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
import { EmployeeService } from './employee.service';
import { EmployeeDocumentService } from './employee-document.service';
import { CertificationService } from './certification.service';
import { TrainingComplianceService } from './training-compliance.service';
import {
  CreateEmployeeDto,
  EmployeeResponseDto,
  ListEmployeesQueryDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';
import {
  CreateEmployeeDocumentDto,
  EmployeeDocumentResponseDto,
} from './dto/employee-document.dto';
import {
  CertificationResponseDto,
  CreateCertificationDto,
} from './dto/certification.dto';
import { EmployeeComplianceDto } from './dto/compliance.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Employees')
@ApiBearerAuth()
@Controller('employees')
export class EmployeeController {
  constructor(
    private readonly employees: EmployeeService,
    private readonly documents: EmployeeDocumentService,
    private readonly certifications: CertificationService,
    private readonly compliance: TrainingComplianceService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('hr-001:read')
  @ApiOperation({ summary: 'Staff directory — list employees in the current tenant' })
  async list(
    @Query() query: ListEmployeesQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<EmployeeResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.employees.list(query, actor);
  }

  @Get('me')
  @RequirePermission('hr-001:read')
  @ApiOperation({ summary: "Resolve the calling user's own employee record" })
  async getMe(@Req() req: AuthedRequest): Promise<EmployeeResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.employees.getMe(actor);
  }

  @Get(':id')
  @RequirePermission('hr-001:read')
  @ApiOperation({ summary: 'Get an employee by id' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<EmployeeResponseDto> {
    return this.employees.getById(id);
  }

  @Post()
  @RequirePermission('hr-001:write')
  @ApiOperation({ summary: 'Create an employee record (admin only)' })
  async create(
    @Body() body: CreateEmployeeDto,
    @Req() req: AuthedRequest,
  ): Promise<EmployeeResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.employees.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('hr-001:write')
  @ApiOperation({ summary: 'Update an employee record (admin only)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateEmployeeDto,
    @Req() req: AuthedRequest,
  ): Promise<EmployeeResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.employees.update(id, body, actor);
  }

  @Get(':id/documents')
  @RequirePermission('hr-001:read')
  @ApiOperation({ summary: 'List documents for an employee (own or admin only)' })
  async listDocuments(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<EmployeeDocumentResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.documents.list(id, actor);
  }

  @Post(':id/documents')
  @RequirePermission('hr-001:write')
  @ApiOperation({ summary: 'Attach a document to an employee (own or admin only)' })
  async createDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateEmployeeDocumentDto,
    @Req() req: AuthedRequest,
  ): Promise<EmployeeDocumentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.documents.create(id, body, actor);
  }

  @Delete(':id/documents/:docId')
  @RequirePermission('hr-001:write')
  @ApiOperation({ summary: 'Soft-archive an employee document (own or admin only)' })
  async archiveDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Req() req: AuthedRequest,
  ): Promise<{ archived: boolean }> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.documents.archive(id, docId, actor);
  }

  @Get(':id/certifications')
  @RequirePermission('hr-004:read')
  @ApiOperation({ summary: "List an employee's certifications (own or admin only)" })
  async listCertifications(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CertificationResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.certifications.listForEmployee(id, actor);
  }

  @Post(':id/certifications')
  @RequirePermission('hr-004:write')
  @ApiOperation({ summary: 'Record a new certification for an employee (own or admin only)' })
  async createCertification(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateCertificationDto,
    @Req() req: AuthedRequest,
  ): Promise<CertificationResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.certifications.create(id, body, actor);
  }

  @Get(':id/compliance')
  @RequirePermission('hr-004:read')
  @ApiOperation({ summary: "Per-employee training compliance breakdown (own or admin only)" })
  async getCompliance(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<EmployeeComplianceDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.compliance.getForEmployee(id, actor);
  }
}
