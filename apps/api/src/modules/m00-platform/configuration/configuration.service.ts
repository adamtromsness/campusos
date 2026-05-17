import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';

/**
 * School Configuration Admin — Step 1 + Step 2 service surface.
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

// ─── Step 2 — Facility Structure Manager ──────────────────────────

/**
 * Facility tree shape: school → buildings → floors → spaces. The UI's
 * left-panel tree view renders this verbatim; the right-panel detail
 * for a given selection is loaded from existing facility CRUD endpoints.
 *
 * Floors are grouped from `fac_spaces.floor` values within each
 * building. The grouping happens app-side so we can return them in a
 * stable sort order (numeric where possible, alphabetic fallback).
 */
export interface FacilityTreeSpaceNode {
  id: string;
  name: string;
  spaceType: string;
  isActive: boolean;
  areaSqft: number | null;
  schRoomId: string | null;
  schRoomName: string | null;
  /** Number of timetable slots that schedule classes in this space.
   *  Surfaced on the detail panel for CLASSROOM-type spaces. */
  scheduledClassCount: number;
}

export interface FacilityTreeFloorNode {
  /** Floor label as stored in fac_spaces.floor — could be "1", "Ground",
   *  "Mezzanine", null (unfloored / outdoor), etc. UI renders verbatim. */
  floor: string | null;
  spaces: FacilityTreeSpaceNode[];
}

export interface FacilityTreeBuildingNode {
  id: string;
  name: string;
  code: string | null;
  yearBuilt: number | null;
  totalFloors: number | null;
  isActive: boolean;
  spaceCount: number;
  floors: FacilityTreeFloorNode[];
}

export interface FacilityTreeResponseDto {
  schoolName: string;
  schoolId: string;
  buildings: FacilityTreeBuildingNode[];
}

interface SpaceRow {
  id: string;
  building_id: string;
  name: string;
  floor: string | null;
  space_type: string;
  area_sqft: number | null;
  is_active: boolean;
  sch_room_id: string | null;
  sch_room_name: string | null;
  scheduled_class_count: number;
}

interface BuildingRow {
  id: string;
  school_id: string;
  name: string;
  code: string | null;
  year_built: number | null;
  total_floors: number | null;
  is_active: boolean;
}

@Injectable()
export class FacilityTreeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getTree(): Promise<FacilityTreeResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Resolve the school name from platform.schools using the
      // tenant-context schoolId. Tenant context is the canonical
      // source — the tenant resolver middleware sets it on every
      // request, so we never need to guess from buildings table.
      const schoolRows = (await client.$queryRawUnsafe(
        `SELECT s.name FROM platform.schools s WHERE s.id = $1::uuid LIMIT 1`,
        tenant.schoolId,
      )) as Array<{ name: string }>;
      const schoolId = tenant.schoolId;
      const schoolName = schoolRows[0]?.name ?? 'School';

      const buildings = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, name, code, year_built,
                total_floors, is_active
           FROM fac_buildings
          ORDER BY name`,
      )) as BuildingRow[];

      // Single SELECT pulls every space + its sch_room link + its
      // scheduled-class count. Bulk for the whole tenant; we group by
      // building_id app-side. Avoids N+1 for large schools.
      const spaces = (await client.$queryRawUnsafe(
        `SELECT s.id::text AS id, s.building_id::text AS building_id, s.name,
                s.floor, s.space_type, s.area_sqft::numeric AS area_sqft,
                s.is_active, s.sch_room_id::text AS sch_room_id,
                r.name AS sch_room_name,
                COALESCE(COUNT(ts.id), 0)::int AS scheduled_class_count
           FROM fac_spaces s
           LEFT JOIN sch_rooms r ON r.id = s.sch_room_id
           LEFT JOIN sch_timetable_slots ts
                  ON ts.room_id = s.sch_room_id
                 AND ts.effective_to IS NULL
          GROUP BY s.id, r.name
          ORDER BY s.floor NULLS LAST, s.name`,
      )) as SpaceRow[];

      const spacesByBuilding = new Map<string, SpaceRow[]>();
      for (const sp of spaces) {
        const arr = spacesByBuilding.get(sp.building_id) ?? [];
        arr.push(sp);
        spacesByBuilding.set(sp.building_id, arr);
      }

      const tree: FacilityTreeBuildingNode[] = buildings.map((b) => {
        const buildingSpaces = spacesByBuilding.get(b.id) ?? [];
        const floorMap = new Map<string, FacilityTreeSpaceNode[]>();
        for (const sp of buildingSpaces) {
          const key = sp.floor ?? '__no_floor__';
          const arr = floorMap.get(key) ?? [];
          arr.push({
            id: sp.id,
            name: sp.name,
            spaceType: sp.space_type,
            isActive: sp.is_active,
            areaSqft: sp.area_sqft === null ? null : Number(sp.area_sqft),
            schRoomId: sp.sch_room_id,
            schRoomName: sp.sch_room_name,
            scheduledClassCount: sp.scheduled_class_count,
          });
          floorMap.set(key, arr);
        }
        const floorKeys = Array.from(floorMap.keys()).sort(compareFloorKeys);
        const floors: FacilityTreeFloorNode[] = floorKeys.map((k) => ({
          floor: k === '__no_floor__' ? null : k,
          spaces: floorMap.get(k) ?? [],
        }));
        return {
          id: b.id,
          name: b.name,
          code: b.code,
          yearBuilt: b.year_built,
          totalFloors: b.total_floors,
          isActive: b.is_active,
          spaceCount: buildingSpaces.length,
          floors,
        };
      });

      return { schoolName, schoolId, buildings: tree };
    });
  }

  /**
   * Pre-delete dependency check for a building. The schema lets a
   * cascade pass through with no warning; this surface refuses the
   * delete instead and tells the operator how many child rows would
   * be lost. The pattern matches the spec's "remove all rooms first
   * or archive the building" guidance.
   */
  async deleteBuildingWithDependencyCheck(buildingId: string): Promise<{ deleted: true }> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT name, is_active FROM fac_buildings WHERE id = $1::uuid LIMIT 1`,
        buildingId,
      )) as Array<{ name: string; is_active: boolean }>;
      if (rows.length === 0) {
        throw new NotFoundException(`Building ${buildingId} not found.`);
      }
      const spaceCount = await scalarCount(
        tx,
        `SELECT COUNT(*)::int AS n FROM fac_spaces WHERE building_id = '${buildingId}'::uuid`,
      );
      if (spaceCount > 0) {
        throw new ConflictException(
          `This building has ${spaceCount} space${spaceCount === 1 ? '' : 's'} — remove all spaces first or archive the building (set isActive=false).`,
        );
      }
      await tx.$executeRawUnsafe(`DELETE FROM fac_buildings WHERE id = $1::uuid`, buildingId);
      return { deleted: true };
    });
  }

  /**
   * Pre-delete dependency check for a space. Refuses delete when an
   * active timetable slot still references the corresponding sch_room.
   * The spec's example: "This room hosts 3 active classes — reschedule
   * or remove those classes first."
   */
  async deleteSpaceWithDependencyCheck(spaceId: string): Promise<{ deleted: true }> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT s.name, s.sch_room_id::text AS sch_room_id
           FROM fac_spaces s
          WHERE s.id = $1::uuid LIMIT 1`,
        spaceId,
      )) as Array<{ name: string; sch_room_id: string | null }>;
      if (rows.length === 0) {
        throw new NotFoundException(`Space ${spaceId} not found.`);
      }
      const space = rows[0]!;
      if (space.sch_room_id) {
        const scheduledCount = await scalarCount(
          tx,
          `SELECT COUNT(*)::int AS n FROM sch_timetable_slots
            WHERE room_id = '${space.sch_room_id}'::uuid AND effective_to IS NULL`,
        );
        if (scheduledCount > 0) {
          throw new ConflictException(
            `${space.name} hosts ${scheduledCount} active timetable slot${scheduledCount === 1 ? '' : 's'} — reschedule or remove those before deleting the space.`,
          );
        }
      }
      // sch_rooms row stays — it might be referenced by historical
      // bookings, attendance records, or archived timetable slots.
      // The space's sch_room_id link is dropped cleanly via DELETE.
      await tx.$executeRawUnsafe(`DELETE FROM fac_spaces WHERE id = $1::uuid`, spaceId);
      return { deleted: true };
    });
  }

  /**
   * Bulk CSV import for rooms. Validates each row up-front; if any row
   * fails, rejects the whole batch with a structured error so the
   * operator can fix and retry. Successful imports run inside one
   * tenant transaction.
   *
   * The DTO carries already-parsed rows (the controller does the CSV
   * parsing); this method validates business rules + inserts.
   */
  async bulkImportRooms(
    rows: Array<{
      buildingName: string;
      roomName: string;
      floor: string | null;
      spaceType: string;
      areaSqft: number | null;
    }>,
  ): Promise<{ created: number; skipped: number; errors: string[] }> {
    if (rows.length === 0) {
      throw new BadRequestException('CSV is empty — no rows to import.');
    }
    if (rows.length > 1000) {
      throw new BadRequestException(
        `CSV has ${rows.length} rows — max 1000 per batch. Split the import into multiple files.`,
      );
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Mirrors the fac_space_type_chk CHECK in migration 072.
      const allowedSpaceTypes = [
        'CLASSROOM',
        'BATHROOM',
        'CORRIDOR',
        'STAIRWELL',
        'MECHANICAL',
        'STORAGE',
        'OFFICE',
        'GROUNDS',
        'COMMON_AREA',
        'GYM',
        'CAFETERIA',
        'OTHER',
      ];

      // Resolve every distinct building name in one round trip.
      const wantedBuildings = Array.from(new Set(rows.map((r) => r.buildingName.trim())));
      const buildingRows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, name FROM fac_buildings WHERE name = ANY($1::text[])`,
        wantedBuildings,
      )) as Array<{ id: string; name: string }>;
      const buildingByName = new Map(buildingRows.map((b) => [b.name, b.id]));

      // Validate all rows up-front before inserting.
      const errors: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        const lineNo = i + 2; // 1-indexed + header row
        const trimmedBuilding = r.buildingName.trim();
        const trimmedRoom = r.roomName.trim();
        if (!trimmedBuilding) {
          errors.push(`Row ${lineNo}: buildingName is required`);
        } else if (!buildingByName.has(trimmedBuilding)) {
          errors.push(
            `Row ${lineNo}: building "${trimmedBuilding}" not found — create the building first or correct the name.`,
          );
        }
        if (!trimmedRoom) {
          errors.push(`Row ${lineNo}: roomName is required`);
        }
        if (!allowedSpaceTypes.includes(r.spaceType)) {
          errors.push(
            `Row ${lineNo}: spaceType "${r.spaceType}" is invalid — must be one of ${allowedSpaceTypes.join(', ')}.`,
          );
        }
        if (r.areaSqft !== null && (r.areaSqft < 0 || !Number.isFinite(r.areaSqft))) {
          errors.push(`Row ${lineNo}: areaSqft must be a non-negative number`);
        }
      }
      if (errors.length > 0) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'BulkImportFailed',
          message: `${errors.length} row${errors.length === 1 ? '' : 's'} rejected — fix and re-upload.`,
          rowErrors: errors,
        });
      }

      let created = 0;
      let skipped = 0;
      for (const r of rows) {
        const buildingId = buildingByName.get(r.buildingName.trim())!;
        // Skip duplicate (building, name) pairs — the operator may be
        // re-running an import after partial success. We could instead
        // upsert, but skipping is the safer default; the operator sees
        // the count and can investigate.
        const dupRows = (await tx.$queryRawUnsafe(
          `SELECT 1 AS ok FROM fac_spaces WHERE building_id = $1::uuid AND name = $2 LIMIT 1`,
          buildingId,
          r.roomName.trim(),
        )) as Array<{ ok: number }>;
        if (dupRows.length > 0) {
          skipped++;
          continue;
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO fac_spaces
             (id, building_id, name, floor, space_type, area_sqft, is_active)
           VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5::numeric, true)`,
          buildingId,
          r.roomName.trim(),
          r.floor,
          r.spaceType,
          r.areaSqft,
        );
        created++;
      }
      return { created, skipped, errors: [] };
    });
  }
}

/**
 * Compares two floor keys for stable sort order.
 *
 *   - "__no_floor__" sorts last.
 *   - Numeric strings sort numerically.
 *   - Mixed/alpha strings sort lexicographically.
 *
 * So a building with floors ["1", "2", "Mezzanine", null] renders as
 * 1 → 2 → Mezzanine → (no floor).
 */
function compareFloorKeys(a: string, b: string): number {
  if (a === '__no_floor__' && b === '__no_floor__') return 0;
  if (a === '__no_floor__') return 1;
  if (b === '__no_floor__') return -1;
  const an = Number(a);
  const bn = Number(b);
  const aNumeric = !Number.isNaN(an) && a.trim() !== '';
  const bNumeric = !Number.isNaN(bn) && b.trim() !== '';
  if (aNumeric && bNumeric) return an - bn;
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a.localeCompare(b);
}

// ─────────────────────────────────────────────────────────────────
// Step 3 — Academic Structure Manager
// ─────────────────────────────────────────────────────────────────

export interface AcademicTreeClassNode {
  id: string;
  sectionCode: string;
  courseId: string;
  courseName: string;
  courseCode: string;
  termName: string | null;
  teacherNames: string[];
  studentCount: number;
  roomText: string | null;
}

export interface AcademicTreeGradeNode {
  gradeLevel: string;
  classes: AcademicTreeClassNode[];
}

export interface AcademicTreeBandNode {
  bandKey: string;
  bandLabel: string;
  grades: AcademicTreeGradeNode[];
}

export interface AcademicTreeTermNode {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  termType: string;
}

export interface AcademicTreeYearNode {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

export interface AcademicTreeResponseDto {
  selectedYear: AcademicTreeYearNode | null;
  availableYears: AcademicTreeYearNode[];
  terms: AcademicTreeTermNode[];
  gradeBands: AcademicTreeBandNode[];
  ungroupedGrades: AcademicTreeGradeNode[];
  gradeBandDefinitions: GradeBandDefinitions;
}

export interface GradeBandDefinitionEntry {
  key: string;
  label: string;
  grades: string[];
}

export interface GradeBandDefinitions {
  bands: GradeBandDefinitionEntry[];
}

const GRADE_BAND_CONFIG_KEY = 'grade_band_definitions';

function emptyBandDefinitions(): GradeBandDefinitions {
  return { bands: [] };
}

@Injectable()
export class AcademicTreeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Returns the full academic hierarchy for a chosen academic year:
   * year header + terms + classes joined to courses, teachers, and
   * enrollments + grade-band groupings from school_config.
   *
   * If `academicYearId` is omitted, picks the current year (or the
   * newest year if no current). Returns selectedYear=null when the
   * tenant has no academic years yet.
   */
  async getTree(academicYearId?: string): Promise<AcademicTreeResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const yearRows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, name, start_date::text AS start_date,
                end_date::text AS end_date, is_current
         FROM sis_academic_years
         ORDER BY start_date DESC`,
      )) as Array<{
        id: string;
        name: string;
        start_date: string;
        end_date: string;
        is_current: boolean;
      }>;
      const availableYears: AcademicTreeYearNode[] = yearRows.map((r) => ({
        id: r.id,
        name: r.name,
        startDate: r.start_date,
        endDate: r.end_date,
        isCurrent: r.is_current,
      }));

      const selected =
        availableYears.find((y) => y.id === academicYearId) ??
        availableYears.find((y) => y.isCurrent) ??
        availableYears[0] ??
        null;

      if (!selected) {
        return {
          selectedYear: null,
          availableYears: [],
          terms: [],
          gradeBands: [],
          ungroupedGrades: [],
          gradeBandDefinitions: await this.loadBandDefinitions(),
        };
      }

      const termRows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, name, start_date::text AS start_date,
                end_date::text AS end_date, term_type
         FROM sis_terms
         WHERE academic_year_id = $1::uuid
         ORDER BY start_date`,
        selected.id,
      )) as Array<{
        id: string;
        name: string;
        start_date: string;
        end_date: string;
        term_type: string;
      }>;
      const terms: AcademicTreeTermNode[] = termRows.map((t) => ({
        id: t.id,
        name: t.name,
        startDate: t.start_date,
        endDate: t.end_date,
        termType: t.term_type,
      }));

      const classRows = (await client.$queryRawUnsafe(
        `SELECT
           c.id::text AS id,
           c.section_code, c.room AS room_text,
           co.id::text AS course_id, co.name AS course_name, co.code AS course_code,
           COALESCE(co.grade_level, '__ungraded__') AS grade_level,
           t.name AS term_name,
           COALESCE(
             (
               SELECT array_agg(DISTINCT (ip.first_name || ' ' || ip.last_name)
                                ORDER BY (ip.first_name || ' ' || ip.last_name))
               FROM sis_class_teachers ct
               JOIN hr_employees he ON he.id = ct.teacher_employee_id
               JOIN platform.iam_person ip ON ip.id = he.person_id
               WHERE ct.class_id = c.id
             ),
             ARRAY[]::text[]
           ) AS teacher_names,
           (
             SELECT COUNT(*)::int
             FROM sis_enrollments e
             WHERE e.class_id = c.id AND e.status = 'ACTIVE'
           ) AS student_count
         FROM sis_classes c
         JOIN sis_courses co ON co.id = c.course_id
         LEFT JOIN sis_terms t ON t.id = c.term_id
         WHERE c.school_id = $1::uuid AND c.academic_year_id = $2::uuid
         ORDER BY co.grade_level NULLS LAST, co.name, c.section_code`,
        tenant.schoolId,
        selected.id,
      )) as Array<{
        id: string;
        section_code: string;
        room_text: string | null;
        course_id: string;
        course_name: string;
        course_code: string;
        grade_level: string;
        term_name: string | null;
        teacher_names: string[];
        student_count: number;
      }>;

      // Group by grade level.
      const byGrade = new Map<string, AcademicTreeClassNode[]>();
      for (const r of classRows) {
        const arr = byGrade.get(r.grade_level) ?? [];
        arr.push({
          id: r.id,
          sectionCode: r.section_code,
          courseId: r.course_id,
          courseName: r.course_name,
          courseCode: r.course_code,
          termName: r.term_name,
          teacherNames: r.teacher_names ?? [],
          studentCount: Number(r.student_count) || 0,
          roomText: r.room_text,
        });
        byGrade.set(r.grade_level, arr);
      }

      // Apply grade band groupings.
      const definitions = await this.loadBandDefinitions();
      const usedGrades = new Set<string>();
      const gradeBands: AcademicTreeBandNode[] = definitions.bands.map((band) => {
        const grades: AcademicTreeGradeNode[] = [];
        for (const g of band.grades) {
          const cls = byGrade.get(g) ?? [];
          if (cls.length > 0) usedGrades.add(g);
          grades.push({ gradeLevel: g, classes: cls });
        }
        return { bandKey: band.key, bandLabel: band.label, grades };
      });

      // Any grade with classes but not bound to a band falls into ungroupedGrades.
      const ungroupedGrades: AcademicTreeGradeNode[] = [];
      for (const [grade, cls] of byGrade.entries()) {
        if (!usedGrades.has(grade)) {
          ungroupedGrades.push({ gradeLevel: grade, classes: cls });
        }
      }
      ungroupedGrades.sort((a, b) => a.gradeLevel.localeCompare(b.gradeLevel));

      return {
        selectedYear: selected,
        availableYears,
        terms,
        gradeBands,
        ungroupedGrades,
        gradeBandDefinitions: definitions,
      };
    });
  }

  /**
   * Reads the persisted grade-band definitions from
   * school_config.config_value where config_key='grade_band_definitions'.
   * Returns an empty bands list when nothing has been configured yet.
   */
  async loadBandDefinitions(): Promise<GradeBandDefinitions> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT config_value FROM school_config WHERE config_key = $1 LIMIT 1`,
        GRADE_BAND_CONFIG_KEY,
      )) as Array<{ config_value: unknown }>;
      if (rows.length === 0) return emptyBandDefinitions();
      const raw = rows[0]?.config_value as unknown;
      if (!raw || typeof raw !== 'object') return emptyBandDefinitions();
      const candidate = raw as { bands?: unknown };
      if (!Array.isArray(candidate.bands)) return emptyBandDefinitions();
      const bands: GradeBandDefinitionEntry[] = [];
      for (const b of candidate.bands) {
        if (!b || typeof b !== 'object') continue;
        const entry = b as { key?: unknown; label?: unknown; grades?: unknown };
        if (
          typeof entry.key !== 'string' ||
          typeof entry.label !== 'string' ||
          !Array.isArray(entry.grades)
        ) {
          continue;
        }
        const grades: string[] = [];
        for (const g of entry.grades) {
          if (typeof g === 'string') grades.push(g);
        }
        bands.push({ key: entry.key, label: entry.label, grades });
      }
      return { bands };
    });
  }

  /**
   * Replaces the grade-band definitions wholesale. Validates the
   * shape, refuses duplicate band keys, and refuses any grade
   * appearing in two bands (a grade can belong to at most one band).
   */
  async saveBandDefinitions(input: GradeBandDefinitions): Promise<GradeBandDefinitions> {
    if (!input || !Array.isArray(input.bands)) {
      throw new BadRequestException('Body must include a `bands` array.');
    }
    const seenKeys = new Set<string>();
    const seenGrades = new Set<string>();
    const sanitised: GradeBandDefinitionEntry[] = [];
    for (const b of input.bands) {
      if (!b || typeof b !== 'object') {
        throw new BadRequestException('Each band must be an object.');
      }
      const key = (b.key ?? '').toString().trim();
      const label = (b.label ?? '').toString().trim();
      if (!key) throw new BadRequestException('Band `key` is required.');
      if (!label) throw new BadRequestException('Band `label` is required.');
      if (key.length > 60) throw new BadRequestException(`Band key "${key}" too long.`);
      if (seenKeys.has(key)) {
        throw new BadRequestException(`Duplicate band key "${key}".`);
      }
      seenKeys.add(key);
      if (!Array.isArray(b.grades)) {
        throw new BadRequestException(`Band "${key}" must include a \`grades\` array.`);
      }
      const grades: string[] = [];
      for (const raw of b.grades) {
        const g = (raw ?? '').toString().trim();
        if (!g) continue;
        if (seenGrades.has(g)) {
          throw new BadRequestException(
            `Grade "${g}" appears in more than one band — a grade can belong to at most one band.`,
          );
        }
        seenGrades.add(g);
        grades.push(g);
      }
      sanitised.push({ key, label, grades });
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const value = { bands: sanitised };
      // UPSERT into the key-value school_config table.
      await tx.$executeRawUnsafe(
        `INSERT INTO school_config (id, config_key, config_value, description)
         VALUES (gen_random_uuid(), $1, $2::jsonb, $3)
         ON CONFLICT (config_key)
         DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now()`,
        GRADE_BAND_CONFIG_KEY,
        JSON.stringify(value),
        'Grade band groupings used by the Configuration admin academic tree.',
      );
      return value;
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Step 4 — Position Structure Manager
// ─────────────────────────────────────────────────────────────────

export interface PositionTreeNode {
  id: string;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
  reportsToId: string | null;
  isTeachingRole: boolean;
  isActive: boolean;
  filledByEmployeeId: string | null;
  filledByName: string | null;
  filledByAccountId: string | null;
  children: PositionTreeNode[];
}

export interface PositionTreeResponseDto {
  totalPositions: number;
  filledCount: number;
  vacantCount: number;
  roots: PositionTreeNode[];
  vacantPositions: PositionTreeNode[];
  flatList: PositionTreeNode[];
}

@Injectable()
export class PositionTreeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Returns the position hierarchy as a forest rooted at every
   * position with `reports_to IS NULL`. Includes department names and
   * the currently-filling employee resolved through the most recent
   * active hr_employee_positions row.
   */
  async getTree(): Promise<PositionTreeResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT
           p.id::text AS id, p.title,
           p.department_id::text AS department_id,
           d.name AS department_name,
           p.reports_to_id::text AS reports_to_id,
           p.is_teaching_role, p.is_active,
           ep.employee_id::text AS filled_by_employee_id,
           (ip.first_name || ' ' || ip.last_name) AS filled_by_name,
           pu.id::text AS filled_by_account_id
         FROM hr_positions p
         LEFT JOIN sis_departments d ON d.id = p.department_id
         LEFT JOIN LATERAL (
           SELECT employee_id
           FROM hr_employee_positions
           WHERE position_id = p.id AND effective_to IS NULL
           ORDER BY effective_from DESC
           LIMIT 1
         ) ep ON true
         LEFT JOIN hr_employees he ON he.id = ep.employee_id
         LEFT JOIN platform.iam_person ip ON ip.id = he.person_id
         LEFT JOIN platform.platform_users pu ON pu.id = he.account_id
         WHERE p.school_id = $1::uuid
         ORDER BY p.title`,
        tenant.schoolId,
      )) as Array<{
        id: string;
        title: string;
        department_id: string | null;
        department_name: string | null;
        reports_to_id: string | null;
        is_teaching_role: boolean;
        is_active: boolean;
        filled_by_employee_id: string | null;
        filled_by_name: string | null;
        filled_by_account_id: string | null;
      }>;

      const flatList: PositionTreeNode[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        departmentId: r.department_id,
        departmentName: r.department_name,
        reportsToId: r.reports_to_id,
        isTeachingRole: r.is_teaching_role,
        isActive: r.is_active,
        filledByEmployeeId: r.filled_by_employee_id,
        filledByName: r.filled_by_name,
        filledByAccountId: r.filled_by_account_id,
        children: [],
      }));
      const byId = new Map(flatList.map((n) => [n.id, n]));
      const roots: PositionTreeNode[] = [];
      for (const node of flatList) {
        if (node.reportsToId && byId.has(node.reportsToId)) {
          byId.get(node.reportsToId)!.children.push(node);
        } else {
          roots.push(node);
        }
      }
      const vacantPositions = flatList.filter((p) => !p.filledByEmployeeId && p.isActive);
      const filledCount = flatList.filter((p) => p.filledByEmployeeId).length;
      return {
        totalPositions: flatList.length,
        filledCount,
        vacantCount: flatList.length - filledCount,
        roots,
        vacantPositions,
        flatList,
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Step 5 — Connections Summary
// ─────────────────────────────────────────────────────────────────

export interface BuildingSchoolLink {
  buildingId: string;
  buildingName: string;
  schoolId: string;
  schoolName: string;
  spaceCount: number;
}

export interface PositionSchoolLink {
  positionId: string;
  positionTitle: string;
  departmentName: string | null;
  schoolId: string;
  schoolName: string;
  filledByName: string | null;
}

export interface PersonPositionLink {
  positionId: string;
  positionTitle: string;
  departmentName: string | null;
  employeeId: string | null;
  personName: string | null;
  startDate: string | null;
  isVacant: boolean;
}

export interface ClassRoomLink {
  classId: string;
  className: string;
  courseName: string;
  gradeLevel: string | null;
  teacherNames: string[];
  roomText: string | null;
  scheduledRoomName: string | null;
  scheduledBuildingName: string | null;
  isUnassigned: boolean;
}

export interface ConnectionsSummaryResponseDto {
  buildingSchool: BuildingSchoolLink[];
  positionSchool: PositionSchoolLink[];
  personPosition: PersonPositionLink[];
  classRoom: ClassRoomLink[];
  totals: {
    buildings: number;
    positions: number;
    filledPositions: number;
    vacantPositions: number;
    classes: number;
    classesWithRoom: number;
    classesWithoutRoom: number;
  };
}

@Injectable()
export class ConnectionsSummaryService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getSummary(): Promise<ConnectionsSummaryResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const buildingRows = (await client.$queryRawUnsafe(
        `SELECT b.id::text AS building_id, b.name AS building_name,
                b.school_id::text AS school_id, s.name AS school_name,
                (SELECT COUNT(*)::int FROM fac_spaces sp WHERE sp.building_id = b.id) AS space_count
         FROM fac_buildings b
         JOIN platform.schools s ON s.id = b.school_id
         WHERE b.school_id = $1::uuid AND b.is_active = true
         ORDER BY b.name`,
        tenant.schoolId,
      )) as Array<{
        building_id: string;
        building_name: string;
        school_id: string;
        school_name: string;
        space_count: number;
      }>;
      const buildingSchool: BuildingSchoolLink[] = buildingRows.map((r) => ({
        buildingId: r.building_id,
        buildingName: r.building_name,
        schoolId: r.school_id,
        schoolName: r.school_name,
        spaceCount: Number(r.space_count) || 0,
      }));

      const positionRows = (await client.$queryRawUnsafe(
        `SELECT p.id::text AS position_id, p.title AS position_title,
                d.name AS department_name,
                p.school_id::text AS school_id, s.name AS school_name,
                (
                  SELECT (ip.first_name || ' ' || ip.last_name)
                  FROM hr_employee_positions ep
                  JOIN hr_employees he ON he.id = ep.employee_id
                  JOIN platform.iam_person ip ON ip.id = he.person_id
                  WHERE ep.position_id = p.id AND ep.effective_to IS NULL
                  ORDER BY ep.effective_from DESC
                  LIMIT 1
                ) AS filled_by_name
         FROM hr_positions p
         LEFT JOIN sis_departments d ON d.id = p.department_id
         JOIN platform.schools s ON s.id = p.school_id
         WHERE p.school_id = $1::uuid AND p.is_active = true
         ORDER BY p.title`,
        tenant.schoolId,
      )) as Array<{
        position_id: string;
        position_title: string;
        department_name: string | null;
        school_id: string;
        school_name: string;
        filled_by_name: string | null;
      }>;
      const positionSchool: PositionSchoolLink[] = positionRows.map((r) => ({
        positionId: r.position_id,
        positionTitle: r.position_title,
        departmentName: r.department_name,
        schoolId: r.school_id,
        schoolName: r.school_name,
        filledByName: r.filled_by_name,
      }));

      const personPositionRows = (await client.$queryRawUnsafe(
        `SELECT p.id::text AS position_id, p.title AS position_title,
                d.name AS department_name,
                ep.employee_id::text AS employee_id,
                (ip.first_name || ' ' || ip.last_name) AS person_name,
                ep.effective_from::text AS start_date
         FROM hr_positions p
         LEFT JOIN sis_departments d ON d.id = p.department_id
         LEFT JOIN LATERAL (
           SELECT employee_id, effective_from
           FROM hr_employee_positions
           WHERE position_id = p.id AND effective_to IS NULL
           ORDER BY effective_from DESC
           LIMIT 1
         ) ep ON true
         LEFT JOIN hr_employees he ON he.id = ep.employee_id
         LEFT JOIN platform.iam_person ip ON ip.id = he.person_id
         WHERE p.school_id = $1::uuid AND p.is_active = true
         ORDER BY p.title`,
        tenant.schoolId,
      )) as Array<{
        position_id: string;
        position_title: string;
        department_name: string | null;
        employee_id: string | null;
        person_name: string | null;
        start_date: string | null;
      }>;
      const personPosition: PersonPositionLink[] = personPositionRows.map((r) => ({
        positionId: r.position_id,
        positionTitle: r.position_title,
        departmentName: r.department_name,
        employeeId: r.employee_id,
        personName: r.person_name,
        startDate: r.start_date,
        isVacant: !r.employee_id,
      }));

      const classRows = (await client.$queryRawUnsafe(
        `SELECT
           c.id::text AS class_id, c.section_code, c.room AS room_text,
           co.name AS course_name, co.grade_level,
           COALESCE(
             (
               SELECT array_agg(DISTINCT (ip.first_name || ' ' || ip.last_name)
                                ORDER BY (ip.first_name || ' ' || ip.last_name))
               FROM sis_class_teachers ct
               JOIN hr_employees he ON he.id = ct.teacher_employee_id
               JOIN platform.iam_person ip ON ip.id = he.person_id
               WHERE ct.class_id = c.id
             ),
             ARRAY[]::text[]
           ) AS teacher_names,
           (
             SELECT r.name
             FROM sch_timetable_slots ts
             JOIN sch_rooms r ON r.id = ts.room_id
             WHERE ts.class_id = c.id
             ORDER BY ts.created_at DESC
             LIMIT 1
           ) AS scheduled_room_name,
           (
             SELECT b.name
             FROM sch_timetable_slots ts
             JOIN sch_rooms r ON r.id = ts.room_id
             LEFT JOIN fac_spaces sp ON sp.sch_room_id = r.id
             LEFT JOIN fac_buildings b ON b.id = sp.building_id
             WHERE ts.class_id = c.id
             ORDER BY ts.created_at DESC
             LIMIT 1
           ) AS scheduled_building_name
         FROM sis_classes c
         JOIN sis_courses co ON co.id = c.course_id
         WHERE c.school_id = $1::uuid
         ORDER BY co.grade_level NULLS LAST, co.name, c.section_code`,
        tenant.schoolId,
      )) as Array<{
        class_id: string;
        section_code: string;
        room_text: string | null;
        course_name: string;
        grade_level: string | null;
        teacher_names: string[];
        scheduled_room_name: string | null;
        scheduled_building_name: string | null;
      }>;
      const classRoom: ClassRoomLink[] = classRows.map((r) => ({
        classId: r.class_id,
        className: `${r.course_name} · ${r.section_code}`,
        courseName: r.course_name,
        gradeLevel: r.grade_level,
        teacherNames: r.teacher_names ?? [],
        roomText: r.room_text,
        scheduledRoomName: r.scheduled_room_name,
        scheduledBuildingName: r.scheduled_building_name,
        isUnassigned: !r.scheduled_room_name && !r.room_text,
      }));

      const filledPositions = personPosition.filter((p) => !p.isVacant).length;
      const classesWithRoom = classRoom.filter((c) => !c.isUnassigned).length;

      return {
        buildingSchool,
        positionSchool,
        personPosition,
        classRoom,
        totals: {
          buildings: buildingSchool.length,
          positions: personPosition.length,
          filledPositions,
          vacantPositions: personPosition.length - filledPositions,
          classes: classRoom.length,
          classesWithRoom,
          classesWithoutRoom: classRoom.length - classesWithRoom,
        },
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Step 6 — Setup Wizard progress (resumable state)
// ─────────────────────────────────────────────────────────────────

const SETUP_WIZARD_CONFIG_KEY = 'setup_wizard_progress';

export interface SetupWizardProgress {
  currentStep: number;
  completedSteps: number[];
  updatedAt: string;
}

export interface SetupWizardProgressResponseDto extends SetupWizardProgress {
  setupStatus: SetupStatusResponseDto;
}

@Injectable()
export class SetupWizardService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly setupSvc: ConfigurationService,
  ) {}

  async getProgress(): Promise<SetupWizardProgressResponseDto> {
    const progress = await this.loadProgress();
    const setupStatus = await this.setupSvc.getSetupStatus();
    return { ...progress, setupStatus };
  }

  async patchProgress(input: {
    currentStep?: number;
    markStepComplete?: number;
  }): Promise<SetupWizardProgressResponseDto> {
    const current = await this.loadProgress();
    let nextCurrent = current.currentStep;
    let nextCompleted = [...current.completedSteps];
    if (typeof input.currentStep === 'number') {
      if (input.currentStep < 1 || input.currentStep > 8) {
        throw new BadRequestException('currentStep must be between 1 and 8.');
      }
      nextCurrent = input.currentStep;
    }
    if (typeof input.markStepComplete === 'number') {
      if (input.markStepComplete < 1 || input.markStepComplete > 8) {
        throw new BadRequestException('markStepComplete must be between 1 and 8.');
      }
      if (!nextCompleted.includes(input.markStepComplete)) {
        nextCompleted.push(input.markStepComplete);
        nextCompleted.sort((a, b) => a - b);
      }
    }
    await this.saveProgress({
      currentStep: nextCurrent,
      completedSteps: nextCompleted,
      updatedAt: new Date().toISOString(),
    });
    return this.getProgress();
  }

  async loadProgress(): Promise<SetupWizardProgress> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT config_value FROM school_config WHERE config_key = $1 LIMIT 1`,
        SETUP_WIZARD_CONFIG_KEY,
      )) as Array<{ config_value: unknown }>;
      const fallback: SetupWizardProgress = {
        currentStep: 1,
        completedSteps: [],
        updatedAt: new Date(0).toISOString(),
      };
      if (rows.length === 0) return fallback;
      const raw = rows[0]?.config_value as unknown;
      if (!raw || typeof raw !== 'object') return fallback;
      const candidate = raw as Partial<SetupWizardProgress>;
      const completed = Array.isArray(candidate.completedSteps)
        ? candidate.completedSteps.filter((n): n is number => typeof n === 'number')
        : [];
      return {
        currentStep:
          typeof candidate.currentStep === 'number' ? candidate.currentStep : fallback.currentStep,
        completedSteps: completed,
        updatedAt:
          typeof candidate.updatedAt === 'string' ? candidate.updatedAt : fallback.updatedAt,
      };
    });
  }

  private async saveProgress(progress: SetupWizardProgress): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO school_config (id, config_key, config_value, description)
         VALUES (gen_random_uuid(), $1, $2::jsonb, $3)
         ON CONFLICT (config_key)
         DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now()`,
        SETUP_WIZARD_CONFIG_KEY,
        JSON.stringify(progress),
        'Setup wizard resumable progress (current step + completed steps).',
      );
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Step 7 — Bulk imports for staff + students
// ─────────────────────────────────────────────────────────────────

export interface ImportStaffRow {
  firstName: string;
  lastName: string;
  email: string;
  positionTitle?: string | null;
  departmentName?: string | null;
}

export interface ImportStudentRow {
  firstName: string;
  lastName: string;
  studentNumber: string;
  gradeLevel?: string | null;
  guardianFirstName?: string | null;
  guardianLastName?: string | null;
  guardianEmail?: string | null;
}

export interface BulkImportResponseDto {
  created: number;
  skipped: number;
  errors: string[];
}

/**
 * Lightweight email shape check for CSV import paths. O(n) — uses
 * indexOf + slice rather than a backtracking regex.
 *
 * REVIEW-P2C1 ROUND 4 hardening (CodeQL js/polynomial-redos) — the
 * previous shape `^[^@\s]+@[^@\s]+\.[^@\s]+$` had two adjacent
 * unbounded `[^@\s]+` quantifiers separated only by `\.`, which the
 * RegExp engine backtracks polynomially on input like
 * `aaaa....aaaa@x` because there are many ways to split a long
 * dot-bearing left part. The split-and-validate approach below is
 * linear in input length and additionally length-caps at the
 * RFC 5321 maximum of 254 characters — the cap alone defeats the
 * polynomial blow-up because n is bounded.
 *
 * Boundary contract is the same as the prior regex: at least one
 * non-whitespace character before `@`, at least one non-whitespace
 * character after `@`, and at least one `.` somewhere in the
 * domain part with non-empty TLD-ish suffix. Real RFC 5322
 * compliance is not in scope — schools' email addresses can
 * include `+` aliases / non-Latin TLDs / multi-dot domains, and
 * the bulk-import contract treats the regex as a typo guard,
 * not an authoritative validator.
 */
function isLikelyEmail(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > 254) return false;
  if (/\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at <= 0) return false;
  if (at !== s.lastIndexOf('@')) return false;
  const domain = s.slice(at + 1);
  if (domain.length === 0) return false;
  const dot = domain.indexOf('.');
  if (dot <= 0) return false;
  if (dot === domain.length - 1) return false;
  return true;
}

@Injectable()
export class BulkImportService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Bulk-creates staff members from a parsed CSV. Each row creates
   * iam_person + platform_users + hr_employees, then optionally an
   * hr_employee_positions assignment when positionTitle resolves.
   *
   * Validates every row up-front and rejects the whole batch on any
   * failure so the operator can fix and re-upload — matches the
   * room-import contract from Step 2.
   */
  async bulkImportStaff(rows: ImportStaffRow[]): Promise<BulkImportResponseDto> {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('Body must include `rows: ImportStaffRow[]` (≥ 1 row).');
    }
    const tenant = getCurrentTenant();

    const errors: string[] = [];
    rows.forEach((r, i) => {
      const ln = i + 2;
      if (!r.firstName?.trim()) errors.push(`Row ${ln}: firstName missing.`);
      if (!r.lastName?.trim()) errors.push(`Row ${ln}: lastName missing.`);
      if (!r.email?.trim()) errors.push(`Row ${ln}: email missing.`);
      else if (!isLikelyEmail(r.email.trim()))
        errors.push(`Row ${ln}: email "${r.email}" is malformed.`);
    });
    if (errors.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'BulkImportFailed',
        message: `${errors.length} row${errors.length === 1 ? '' : 's'} rejected — fix and re-upload.`,
        rowErrors: errors,
      });
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Resolve position-title and department lookups once per batch.
      const positionTitles = Array.from(
        new Set(rows.map((r) => r.positionTitle?.trim()).filter(Boolean) as string[]),
      );
      const positionRows =
        positionTitles.length > 0
          ? ((await tx.$queryRawUnsafe(
              `SELECT id::text AS id, title FROM hr_positions
               WHERE school_id = $1::uuid AND title = ANY($2::text[])`,
              tenant.schoolId,
              positionTitles,
            )) as Array<{ id: string; title: string }>)
          : [];
      const positionByTitle = new Map(positionRows.map((p) => [p.title, p.id]));

      const rowErrors: string[] = [];
      let created = 0;
      let skipped = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        const ln = i + 2;
        const email = r.email.trim().toLowerCase();
        // Skip if account already exists.
        const existing = (await tx.$queryRawUnsafe(
          `SELECT id::text AS id FROM platform.platform_users WHERE email = $1 LIMIT 1`,
          email,
        )) as Array<{ id: string }>;
        if (existing.length > 0) {
          skipped++;
          continue;
        }

        if (
          r.positionTitle &&
          r.positionTitle.trim() &&
          !positionByTitle.has(r.positionTitle.trim())
        ) {
          rowErrors.push(
            `Row ${ln}: positionTitle "${r.positionTitle}" does not exist — create the position first.`,
          );
          continue;
        }

        const personId = await genUuid(tx);
        const accountId = await genUuid(tx);
        const employeeId = await genUuid(tx);
        const employeeNumber = `EMP-${Date.now().toString(36).slice(-4)}-${i.toString().padStart(3, '0')}`;

        await tx.$executeRawUnsafe(
          `INSERT INTO platform.iam_person (id, first_name, last_name, person_type)
           VALUES ($1::uuid, $2, $3, 'STAFF'::"PersonType")`,
          personId,
          r.firstName.trim(),
          r.lastName.trim(),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_users (id, person_id, email)
           VALUES ($1::uuid, $2::uuid, $3)`,
          accountId,
          personId,
          email,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO hr_employees (id, school_id, person_id, account_id, employee_number,
                                     employment_type, employment_status, hire_date)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'FULL_TIME', 'ACTIVE', CURRENT_DATE)`,
          employeeId,
          tenant.schoolId,
          personId,
          accountId,
          employeeNumber,
        );

        const positionId = r.positionTitle ? positionByTitle.get(r.positionTitle.trim()) : null;
        if (positionId) {
          await tx.$executeRawUnsafe(
            `INSERT INTO hr_employee_positions (id, employee_id, position_id, effective_from,
                                                fte, is_primary)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, CURRENT_DATE, 1.000, true)`,
            employeeId,
            positionId,
          );
        }
        created++;
      }
      if (rowErrors.length > 0) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'BulkImportFailed',
          message: `${rowErrors.length} row${rowErrors.length === 1 ? '' : 's'} rejected — fix and re-upload.`,
          rowErrors,
        });
      }
      return { created, skipped, errors: [] };
    });
  }

  /**
   * Bulk-creates students from a parsed CSV. Each row creates
   * iam_person + platform_students + sis_students. Optional guardian
   * fields create the guardian + the sis_student_guardians link.
   */
  async bulkImportStudents(rows: ImportStudentRow[]): Promise<BulkImportResponseDto> {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('Body must include `rows: ImportStudentRow[]` (≥ 1 row).');
    }
    const tenant = getCurrentTenant();

    const errors: string[] = [];
    rows.forEach((r, i) => {
      const ln = i + 2;
      if (!r.firstName?.trim()) errors.push(`Row ${ln}: firstName missing.`);
      if (!r.lastName?.trim()) errors.push(`Row ${ln}: lastName missing.`);
      if (!r.studentNumber?.trim()) errors.push(`Row ${ln}: studentNumber missing.`);
      if (r.guardianEmail && !isLikelyEmail(r.guardianEmail.trim())) {
        errors.push(`Row ${ln}: guardianEmail "${r.guardianEmail}" is malformed.`);
      }
    });
    if (errors.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'BulkImportFailed',
        message: `${errors.length} row${errors.length === 1 ? '' : 's'} rejected — fix and re-upload.`,
        rowErrors: errors,
      });
    }

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rowErrors: string[] = [];
      let created = 0;
      let skipped = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        const ln = i + 2;
        const studentNumber = r.studentNumber.trim();

        // Skip if student_number already exists in this tenant.
        const existing = (await tx.$queryRawUnsafe(
          `SELECT id::text AS id FROM sis_students WHERE student_number = $1 LIMIT 1`,
          studentNumber,
        )) as Array<{ id: string }>;
        if (existing.length > 0) {
          skipped++;
          continue;
        }

        try {
          const personId = await genUuid(tx);
          const platformStudentId = await genUuid(tx);
          const sisStudentId = await genUuid(tx);

          await tx.$executeRawUnsafe(
            `INSERT INTO platform.iam_person (id, first_name, last_name, person_type)
             VALUES ($1::uuid, $2, $3, 'STUDENT'::"PersonType")`,
            personId,
            r.firstName.trim(),
            r.lastName.trim(),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO platform.platform_students (id, person_id, first_name, last_name)
             VALUES ($1::uuid, $2::uuid, $3, $4)`,
            platformStudentId,
            personId,
            r.firstName.trim(),
            r.lastName.trim(),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO sis_students (id, school_id, platform_student_id, student_number,
                                       grade_level, enrollment_status)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'ENROLLED')`,
            sisStudentId,
            tenant.schoolId,
            platformStudentId,
            studentNumber,
            r.gradeLevel?.trim() || null,
          );

          // Optional guardian linkage. Reuses an existing guardian by email.
          if (r.guardianEmail && r.guardianFirstName && r.guardianLastName) {
            const gEmail = r.guardianEmail.trim().toLowerCase();
            const guardianAccount = (await tx.$queryRawUnsafe(
              `SELECT pu.id::text AS account_id, pu.person_id::text AS person_id
               FROM platform.platform_users pu WHERE pu.email = $1 LIMIT 1`,
              gEmail,
            )) as Array<{ account_id: string; person_id: string }>;

            let guardianPersonId: string;
            let guardianAccountId: string;
            if (guardianAccount.length > 0 && guardianAccount[0]) {
              guardianPersonId = guardianAccount[0].person_id;
              guardianAccountId = guardianAccount[0].account_id;
            } else {
              guardianPersonId = await genUuid(tx);
              guardianAccountId = await genUuid(tx);
              await tx.$executeRawUnsafe(
                `INSERT INTO platform.iam_person (id, first_name, last_name, person_type)
                 VALUES ($1::uuid, $2, $3, 'GUARDIAN'::"PersonType")`,
                guardianPersonId,
                r.guardianFirstName.trim(),
                r.guardianLastName.trim(),
              );
              await tx.$executeRawUnsafe(
                `INSERT INTO platform.platform_users (id, person_id, email)
                 VALUES ($1::uuid, $2::uuid, $3)`,
                guardianAccountId,
                guardianPersonId,
                gEmail,
              );
            }

            // sis_guardians is the tenant projection.
            const sisGuardian = (await tx.$queryRawUnsafe(
              `SELECT id::text AS id FROM sis_guardians WHERE person_id = $1::uuid LIMIT 1`,
              guardianPersonId,
            )) as Array<{ id: string }>;
            let sisGuardianId: string;
            if (sisGuardian.length > 0 && sisGuardian[0]) {
              sisGuardianId = sisGuardian[0].id;
            } else {
              sisGuardianId = await genUuid(tx);
              await tx.$executeRawUnsafe(
                `INSERT INTO sis_guardians (id, school_id, person_id, account_id, relationship)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'GUARDIAN')`,
                sisGuardianId,
                tenant.schoolId,
                guardianPersonId,
                guardianAccountId,
              );
            }

            const linkExists = (await tx.$queryRawUnsafe(
              `SELECT 1 FROM sis_student_guardians WHERE student_id = $1::uuid AND guardian_id = $2::uuid LIMIT 1`,
              sisStudentId,
              sisGuardianId,
            )) as Array<unknown>;
            if (linkExists.length === 0) {
              await tx.$executeRawUnsafe(
                `INSERT INTO sis_student_guardians
                   (id, student_id, guardian_id, has_custody, is_emergency_contact,
                    receives_reports, portal_access, portal_access_scope)
                 VALUES (gen_random_uuid(), $1::uuid, $2::uuid, true, true, true, true, 'FULL')`,
                sisStudentId,
                sisGuardianId,
              );
            }
          }
          created++;
        } catch (err) {
          rowErrors.push(`Row ${ln}: ${(err as Error).message}`);
        }
      }
      if (rowErrors.length > 0) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'BulkImportFailed',
          message: `${rowErrors.length} row${rowErrors.length === 1 ? '' : 's'} rejected — fix and re-upload.`,
          rowErrors,
        });
      }
      return { created, skipped, errors: [] };
    });
  }
}

/**
 * Generates a UUID inside the active tenant transaction. Calling
 * gen_random_uuid() through the tx client keeps every UPSERT in the
 * same transactional snapshot — opening a fresh tenant context here
 * would deadlock against the held locks.
 */
async function genUuid(tx: { $queryRawUnsafe: (q: string) => Promise<unknown> }): Promise<string> {
  const r = (await tx.$queryRawUnsafe(`SELECT gen_random_uuid()::text AS id`)) as Array<{
    id: string;
  }>;
  if (!r[0]) throw new Error('Failed to generate uuid.');
  return r[0].id;
}
