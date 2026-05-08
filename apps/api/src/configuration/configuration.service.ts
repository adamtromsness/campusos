import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';

/**
 * School Configuration Admin — Step 1 service surface.
 *
 * Computes the setup-completeness checklist on render from existing
 * tenant data — there is no `setup_progress` table. Each item maps
 * to a tri-state status:
 *
 *   - DONE      green check  → count meets the "real school is ready"
 *                              threshold for this dimension.
 *   - PARTIAL   amber dot    → some data exists but the dimension
 *                              isn't yet fleshed out enough to call
 *                              the school operational.
 *   - NOT_STARTED gray dot   → zero rows.
 *
 * Thresholds chosen to err on the side of "we still call this an
 * incomplete setup" rather than flipping green prematurely. Schools
 * iterating on their own configuration see clear next steps.
 *
 * Future Step 7 endpoints (facility-tree / academic-tree /
 * position-tree / connections-summary / imports / grade-bands) land
 * in this same module — the Configuration Hub at /admin/configuration
 * is the consumer that needs the setup-status today.
 */

export type SetupStatus = 'DONE' | 'PARTIAL' | 'NOT_STARTED';

export interface SetupStatusItem {
  /** Stable key the UI uses for icon + ordering. */
  key:
    | 'buildings'
    | 'rooms'
    | 'academic_year'
    | 'classes'
    | 'positions'
    | 'staff_assigned'
    | 'classes_in_rooms';
  label: string;
  status: SetupStatus;
  /** The actual count surfaced by the UI as a small subtitle. */
  count: number;
  /** Threshold below which we down-grade DONE → PARTIAL. */
  doneThreshold: number;
}

export interface SetupStatusResponseDto {
  items: SetupStatusItem[];
  /** Convenience rollup so the UI can show "5 of 7 complete". */
  completedCount: number;
  totalCount: number;
}

@Injectable()
export class ConfigurationService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getSetupStatus(): Promise<SetupStatusResponseDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Run every count in parallel — they're independent reads.
      const [
        buildingCount,
        classroomSpaceCount,
        currentYearCount,
        classCount,
        positionCount,
        staffWithPositionCount,
        classesInRoomsCount,
      ] = await Promise.all([
        scalarCount(client, `SELECT COUNT(*)::int AS n FROM fac_buildings WHERE is_active = true`),
        scalarCount(
          client,
          `SELECT COUNT(*)::int AS n FROM fac_spaces WHERE space_type = 'CLASSROOM' AND is_active = true`,
        ),
        scalarCount(
          client,
          `SELECT COUNT(*)::int AS n FROM sis_academic_years WHERE is_current = true`,
        ),
        scalarCount(client, `SELECT COUNT(*)::int AS n FROM sis_classes`),
        scalarCount(client, `SELECT COUNT(*)::int AS n FROM hr_positions WHERE is_active = true`),
        scalarCount(
          client,
          `SELECT COUNT(DISTINCT employee_id)::int AS n FROM hr_employee_positions WHERE effective_to IS NULL`,
        ),
        scalarCount(
          client,
          `SELECT COUNT(*)::int AS n FROM sch_timetable_slots WHERE room_id IS NOT NULL AND effective_to IS NULL`,
        ),
      ]);

      const items: SetupStatusItem[] = [
        statusItem('buildings', 'Buildings defined', buildingCount, 1),
        statusItem('rooms', 'Rooms created', classroomSpaceCount, 5),
        statusItem('academic_year', 'Academic year configured', currentYearCount, 1),
        statusItem('classes', 'Classes created', classCount, 1),
        statusItem('positions', 'Staff positions defined', positionCount, 5),
        statusItem('staff_assigned', 'Staff assigned to positions', staffWithPositionCount, 1),
        statusItem('classes_in_rooms', 'Classes assigned to rooms', classesInRoomsCount, 1),
      ];

      const completedCount = items.filter((i) => i.status === 'DONE').length;

      return {
        items,
        completedCount,
        totalCount: items.length,
      };
    });
  }
}

function statusItem(
  key: SetupStatusItem['key'],
  label: string,
  count: number,
  doneThreshold: number,
): SetupStatusItem {
  let status: SetupStatus;
  if (count >= doneThreshold) status = 'DONE';
  else if (count > 0) status = 'PARTIAL';
  else status = 'NOT_STARTED';
  return { key, label, status, count, doneThreshold };
}

async function scalarCount(
  client: { $queryRawUnsafe: (sql: string) => Promise<unknown> },
  sql: string,
): Promise<number> {
  const rows = (await client.$queryRawUnsafe(sql)) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
