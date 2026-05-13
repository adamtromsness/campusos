import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { OutboxService } from '../kafka/outbox.service';
import { deterministicLibImportCompletedEventId } from './event-ids';
import {
  CatalogueImportJobResponseDto,
  CreateCatalogueImportJobDto,
  ImportStatus,
  ImportType,
} from './dto/library-advanced.dto';

/**
 * P2-25a Step 5 — CatalogueImportService.
 *
 * Async bulk catalogue import. The librarian (Staff with lib-002:
 * write) or admin POSTs a job; the service writes a QUEUED row + the
 * CatalogueImportWorker (a sibling worker registered on the module)
 * processes it asynchronously.
 *
 * ISBN dedup is the contract — duplicate ISBNs count as
 * records_skipped, not records_failed. On a terminal transition the
 * service emits lib.import.completed via the platform outbox so a
 * future librarian-notification consumer can fan out an in-app
 * notification.
 */

interface ImportJobRow {
  id: string;
  school_id: string;
  import_type: string;
  source_file_s3_key: string | null;
  total_records: number | null;
  records_imported: number;
  records_skipped: number;
  records_failed: number;
  status: string;
  initiated_by: string;
  initiator_first: string | null;
  initiator_last: string | null;
  error_log_s3_key: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_JOB_BASE =
  'SELECT j.id::text AS id, j.school_id::text AS school_id, j.import_type, ' +
  'j.source_file_s3_key, j.total_records, j.records_imported, j.records_skipped, j.records_failed, ' +
  'j.status, j.initiated_by::text AS initiated_by, ' +
  'ip.first_name AS initiator_first, ip.last_name AS initiator_last, ' +
  'j.error_log_s3_key, ' +
  'TO_CHAR(j.started_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS started_at, ' +
  'TO_CHAR(j.completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  'TO_CHAR(j.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(j.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_catalogue_import_jobs j ' +
  'LEFT JOIN hr_employees ie ON ie.id = j.initiated_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = ie.person_id ';

function rowToJobDto(r: ImportJobRow): CatalogueImportJobResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    importType: r.import_type as ImportType,
    sourceFileS3Key: r.source_file_s3_key,
    totalRecords: r.total_records,
    recordsImported: r.records_imported,
    recordsSkipped: r.records_skipped,
    recordsFailed: r.records_failed,
    status: r.status as ImportStatus,
    initiatedById: r.initiated_by,
    initiatedByName:
      r.initiator_first && r.initiator_last ? r.initiator_first + ' ' + r.initiator_last : null,
    errorLogS3Key: r.error_log_s3_key,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class CatalogueImportService {
  private readonly logger = new Logger(CatalogueImportService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private async hasLibrarianScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-002:write',
    ]);
  }

  async list(): Promise<CatalogueImportJobResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ImportJobRow[]>(
        SELECT_JOB_BASE + 'WHERE j.school_id = $1::uuid ORDER BY j.created_at DESC LIMIT 200',
        tenant.schoolId,
      );
    });
    return rows.map(rowToJobDto);
  }

  async getById(id: string): Promise<CatalogueImportJobResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ImportJobRow[]>(
        SELECT_JOB_BASE + 'WHERE j.id = $1::uuid AND j.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Catalogue import job ' + id);
    return rowToJobDto(rows[0]!);
  }

  /**
   * Create a QUEUED import job. The CatalogueImportWorker picks it
   * up and processes it asynchronously. For ISBN_BATCH the supplied
   * isbns array is encoded into the source_file_s3_key with an
   * inline:// prefix so the worker can decode without an S3 round
   * trip.
   */
  async create(
    input: CreateCatalogueImportJobDto,
    actor: ResolvedActor,
  ): Promise<CatalogueImportJobResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can create catalogue import jobs');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Import initiator must have an hr_employees row — actor.employeeId is null',
      );
    }
    if (input.importType === 'ISBN_BATCH') {
      if (!input.isbns || input.isbns.length === 0) {
        throw new BadRequestException('ISBN_BATCH requires a non-empty isbns array');
      }
    }
    if (input.importType !== 'ISBN_BATCH' && !input.sourceFileS3Key) {
      throw new BadRequestException(
        input.importType + ' requires sourceFileS3Key referencing an uploaded file',
      );
    }

    const tenant = getCurrentTenant();
    const id = generateId();

    // For ISBN_BATCH we stash the inline ISBNs into source_file_s3_key
    // using an inline:// scheme so the worker can decode them without
    // an S3 round trip. Other import types carry the real S3 key.
    let sourceKey: string | null = input.sourceFileS3Key ?? null;
    let totalRecords: number | null = null;
    if (input.importType === 'ISBN_BATCH') {
      sourceKey = 'inline://' + JSON.stringify(input.isbns);
      totalRecords = input.isbns!.length;
    }

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO lib_catalogue_import_jobs ' +
          '(id, school_id, import_type, source_file_s3_key, total_records, status, initiated_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'QUEUED', $6::uuid)",
        id,
        tenant.schoolId,
        input.importType,
        sourceKey,
        totalRecords,
        actor.employeeId,
      );
    });

    this.logger.log(
      '[catalogue-import.create] id=' +
        id.slice(0, 8) +
        ' type=' +
        input.importType +
        (totalRecords ? ' total=' + totalRecords : ''),
    );
    return this.getById(id);
  }

  /**
   * Process one QUEUED job to COMPLETED or FAILED. Public so the
   * CatalogueImportWorker can call it under runWithTenantContextAsync.
   *
   * Walks ISBN_BATCH end-to-end:
   *   1. Mark PARSING + started_at
   *   2. Decode the inline isbns array
   *   3. For each ISBN: SELECT existing → if present, skipped++;
   *      otherwise INSERT lib_catalogue_items with placeholder title +
   *      author, imported++.
   *   4. On any unexpected error per row: failed++ and continue.
   *   5. Mark COMPLETED + completed_at + error_log_s3_key (when
   *      records_failed > 0). Emit lib.import.completed via outbox
   *      inside the same tx as the terminal status update.
   *
   * MARC_IMPORT and CSV_UPLOAD: scaffolded — the worker logs a
   * "deferred — uses inline placeholder counts" line and marks
   * COMPLETED with zero progress. The schema is forward-compatible
   * for a future P3 cycle that adds proper MARC/CSV parsers.
   *
   * WORLDCAT_SYNC: same scaffolded path.
   */
  async processQueuedJob(id: string): Promise<void> {
    const tenant = getCurrentTenant();
    // Load the job
    const jobRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          import_type: string;
          source_file_s3_key: string | null;
          school_id: string;
          status: string;
        }>
      >(
        'SELECT id::text AS id, import_type, source_file_s3_key, school_id::text AS school_id, status ' +
          'FROM lib_catalogue_import_jobs WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (jobRows.length === 0) {
      this.logger.warn('catalogue-import.processQueuedJob: job ' + id + ' not found');
      return;
    }
    const job = jobRows[0]!;
    if (job.status !== 'QUEUED') {
      this.logger.debug(
        'catalogue-import.processQueuedJob: job ' + id + ' is ' + job.status + ' — skipping',
      );
      return;
    }

    // Mark PARSING
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        "UPDATE lib_catalogue_import_jobs SET status = 'PARSING', started_at = now(), updated_at = now() WHERE id = $1::uuid",
        id,
      );
    });

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const errorRows: string[] = [];

    try {
      if (job.import_type === 'ISBN_BATCH') {
        const inline = job.source_file_s3_key;
        if (!inline || !inline.startsWith('inline://')) {
          throw new BadRequestException('ISBN_BATCH job has malformed source_file_s3_key');
        }
        const isbns = JSON.parse(inline.slice('inline://'.length)) as string[];

        // Move to IMPORTING
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            "UPDATE lib_catalogue_import_jobs SET status = 'IMPORTING', updated_at = now() WHERE id = $1::uuid",
            id,
          );
        });

        for (const isbn of isbns) {
          try {
            const existing = await this.tenantPrisma.executeInTenantContext(async (client) => {
              return client.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT id::text AS id FROM lib_catalogue_items WHERE school_id = $1::uuid AND isbn = $2 LIMIT 1',
                job.school_id,
                isbn,
              );
            });
            if (existing.length > 0) {
              skipped++;
              continue;
            }
            const newId = generateId();
            await this.tenantPrisma.executeInTenantContext(async (client) => {
              await client.$executeRawUnsafe(
                'INSERT INTO lib_catalogue_items (id, school_id, title, isbn, description) VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
                newId,
                job.school_id,
                'Untitled (imported via ISBN ' + isbn + ')',
                isbn,
                'Imported via ISBN_BATCH job ' + id.slice(0, 8) + '. Cataloguer to fill metadata.',
              );
            });
            imported++;
          } catch (e: unknown) {
            failed++;
            errorRows.push(
              isbn + ',' + (e instanceof Error ? e.message.replace(/[",\r\n]/g, ' ') : 'unknown'),
            );
          }
        }
      } else {
        // MARC_IMPORT / CSV_UPLOAD / WORLDCAT_SYNC scaffolded — schema
        // ready, parser deferred to a future P3 cycle.
        this.logger.log(
          '[catalogue-import.processQueuedJob] id=' +
            id.slice(0, 8) +
            ' type=' +
            job.import_type +
            ' parser deferred — marking COMPLETED with zero progress.',
        );
      }
    } catch (e: unknown) {
      // Hard failure — mark FAILED and emit
      this.logger.error(
        '[catalogue-import.processQueuedJob] id=' +
          id.slice(0, 8) +
          ' fatal: ' +
          (e instanceof Error ? e.message : String(e)),
      );
      await this.markTerminal(id, 'FAILED', { imported: 0, skipped: 0, failed: 0 }, null);
      return;
    }

    const errorLogKey =
      failed > 0
        ? 'imports/' + new Date().toISOString().slice(0, 10) + '/import-' + id + '-errors.csv'
        : null;

    // Note: in a real deployment the worker would also upload errorRows
    // to S3 under errorLogKey. The seed planted a representative key
    // and the worker scaffold leaves the S3 upload to ops.
    void errorRows;

    await this.markTerminal(id, 'COMPLETED', { imported, skipped, failed }, errorLogKey);
  }

  private async markTerminal(
    id: string,
    terminal: 'COMPLETED' | 'FAILED',
    counts: { imported: number; skipped: number; failed: number },
    errorLogKey: string | null,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'UPDATE lib_catalogue_import_jobs SET status = $1, records_imported = $2, records_skipped = $3, records_failed = $4, error_log_s3_key = $5, completed_at = now(), updated_at = now() WHERE id = $6::uuid',
        terminal,
        counts.imported,
        counts.skipped,
        counts.failed,
        errorLogKey,
        id,
      );
      await this.outbox.enqueueInTx(tx, {
        topic: 'lib.import.completed',
        key: id,
        sourceModule: 'library',
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
        eventId: deterministicLibImportCompletedEventId(id),
        payload: {
          importJobId: id,
          schoolId: tenant.schoolId,
          status: terminal,
          recordsImported: counts.imported,
          recordsSkipped: counts.skipped,
          recordsFailed: counts.failed,
          errorLogS3Key: errorLogKey,
          sourceRefId: id,
        },
      });
    });
    this.logger.log(
      '[catalogue-import.markTerminal] id=' +
        id.slice(0, 8) +
        ' status=' +
        terminal +
        ' imported=' +
        counts.imported +
        ' skipped=' +
        counts.skipped +
        ' failed=' +
        counts.failed,
    );
  }

  /**
   * Find all QUEUED jobs in the current tenant. The worker calls
   * this on each tick.
   */
  async listQueuedForCurrentTenant(): Promise<string[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        "SELECT id::text AS id FROM lib_catalogue_import_jobs WHERE school_id = $1::uuid AND status = 'QUEUED' ORDER BY created_at ASC LIMIT 25",
        tenant.schoolId,
      );
    });
    return rows.map((r) => r.id);
  }
}
