import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateEmployeeDocumentDto,
  EmployeeDocumentResponseDto,
} from './dto/employee-document.dto';

interface DocumentRow {
  id: string;
  employee_id: string;
  document_type_id: string;
  document_type_name: string;
  file_name: string;
  s3_key: string;
  content_type: string | null;
  file_size_bytes: string | null;
  uploaded_by: string;
  uploaded_at: string;
  expiry_date: string | null;
  is_archived: boolean;
}

function rowToDto(row: DocumentRow): EmployeeDocumentResponseDto {
  return {
    id: row.id,
    employeeId: row.employee_id,
    documentTypeId: row.document_type_id,
    documentTypeName: row.document_type_name,
    fileName: row.file_name,
    s3Key: row.s3_key,
    contentType: row.content_type,
    fileSizeBytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    expiryDate: row.expiry_date,
    isArchived: row.is_archived,
  };
}

var SELECT_DOCUMENT_BASE =
  'SELECT d.id, d.employee_id, d.document_type_id, dt.name AS document_type_name, ' +
  'd.file_name, d.s3_key, d.content_type, d.file_size_bytes, d.uploaded_by, ' +
  'd.uploaded_at, ' +
  "TO_CHAR(d.expiry_date, 'YYYY-MM-DD') AS expiry_date, " +
  'd.is_archived ' +
  'FROM hr_employee_documents d ' +
  'JOIN hr_document_types dt ON dt.id = d.document_type_id ';

@Injectable()
export class EmployeeDocumentService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Visibility: school admins see every employee's documents; everyone else
   * only sees their own. Throws 403 when the calling user lacks the
   * employee record they're trying to read (e.g. parent / student
   * personas, or a Platform Admin without an hr_employees row).
   */
  async list(employeeId: string, actor: ResolvedActor): Promise<EmployeeDocumentResponseDto[]> {
    this.assertCanAccess(employeeId, actor);
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<DocumentRow[]>(
        SELECT_DOCUMENT_BASE +
          'WHERE d.employee_id = $1::uuid AND d.is_archived = false ' +
          'ORDER BY d.uploaded_at DESC',
        employeeId,
      );
    });
    return rows.map(rowToDto);
  }

  async create(
    employeeId: string,
    body: CreateEmployeeDocumentDto,
    actor: ResolvedActor,
  ): Promise<EmployeeDocumentResponseDto> {
    this.assertCanAccess(employeeId, actor);

    var docTypeRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM hr_document_types WHERE id = $1::uuid AND is_active = true',
        body.documentTypeId,
      );
    });
    if (docTypeRows.length === 0) {
      throw new NotFoundException('Document type ' + body.documentTypeId + ' not found');
    }
    var employeeRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM hr_employees WHERE id = $1::uuid',
        employeeId,
      );
    });
    if (employeeRows.length === 0) {
      throw new NotFoundException('Employee ' + employeeId + ' not found');
    }

    var docId = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hr_employee_documents ' +
          '(id, employee_id, document_type_id, file_name, s3_key, content_type, file_size_bytes, uploaded_by, expiry_date) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::date)',
        docId,
        employeeId,
        body.documentTypeId,
        body.fileName,
        body.s3Key,
        body.contentType ?? null,
        body.fileSizeBytes ?? null,
        actor.accountId,
        body.expiryDate ?? null,
      );
    });
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<DocumentRow[]>(
        SELECT_DOCUMENT_BASE + 'WHERE d.id = $1::uuid',
        docId,
      );
    });
    return rowToDto(rows[0]!);
  }

  /**
   * Soft-archive a document — the row stays for audit but stops appearing
   * in `list`. Admin or owning-employee can archive; anyone else gets 403.
   * Hard delete is intentionally not exposed via the API.
   */
  async archive(
    employeeId: string,
    documentId: string,
    actor: ResolvedActor,
  ): Promise<{ archived: boolean }> {
    this.assertCanAccess(employeeId, actor);
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM hr_employee_documents WHERE id = $1::uuid AND employee_id = $2::uuid',
        documentId,
        employeeId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('Document ' + documentId + ' not found');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE hr_employee_documents SET is_archived = true, updated_at = now() WHERE id = $1::uuid',
        documentId,
      );
    });
    return { archived: true };
  }

  private assertCanAccess(employeeId: string, actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.employeeId === employeeId) return;
    throw new ForbiddenException(
      'Only the owning employee or a school admin can access this employee document set',
    );
  }
}
