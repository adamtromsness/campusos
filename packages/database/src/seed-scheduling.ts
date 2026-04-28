import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

var TENANT_SCHEMA = 'tenant_demo';

interface PeriodSpec {
  name: string;
  startTime: string;
  endTime: string;
  periodType: 'LESSON' | 'BREAK' | 'LUNCH' | 'REGISTRATION' | 'ASSEMBLY';
  sortOrder: number;
}

// Standard Day — 8 LESSON periods plus 2 BREAK rows and 1 LUNCH row, M-F.
// day_of_week is NULL on every row so each period applies to every weekday;
// the Cycle 1 timetable slots reference periods by id and inherit the M-F shape
// from the slot's effective date range, not from a per-day period row.
var STANDARD_DAY_PERIODS: PeriodSpec[] = [
  { name: 'Period 1', startTime: '08:00', endTime: '08:50', periodType: 'LESSON', sortOrder: 1 },
  {
    name: 'Morning Break',
    startTime: '08:50',
    endTime: '09:00',
    periodType: 'BREAK',
    sortOrder: 2,
  },
  { name: 'Period 2', startTime: '09:00', endTime: '09:50', periodType: 'LESSON', sortOrder: 3 },
  { name: 'Period 3', startTime: '10:00', endTime: '10:50', periodType: 'LESSON', sortOrder: 4 },
  { name: 'Period 4', startTime: '10:50', endTime: '11:40', periodType: 'LESSON', sortOrder: 5 },
  { name: 'Lunch', startTime: '11:40', endTime: '12:20', periodType: 'LUNCH', sortOrder: 6 },
  { name: 'Period 5', startTime: '12:20', endTime: '13:10', periodType: 'LESSON', sortOrder: 7 },
  { name: 'Period 6', startTime: '13:10', endTime: '14:00', periodType: 'LESSON', sortOrder: 8 },
  {
    name: 'Afternoon Break',
    startTime: '14:00',
    endTime: '14:10',
    periodType: 'BREAK',
    sortOrder: 9,
  },
  { name: 'Period 7', startTime: '14:10', endTime: '15:00', periodType: 'LESSON', sortOrder: 10 },
  { name: 'Period 8', startTime: '15:00', endTime: '15:50', periodType: 'LESSON', sortOrder: 11 },
];

// Early Dismissal — 6 shortened LESSON periods plus 1 BREAK and 1 LUNCH.
var EARLY_DISMISSAL_PERIODS: PeriodSpec[] = [
  { name: 'Period 1', startTime: '08:00', endTime: '08:35', periodType: 'LESSON', sortOrder: 1 },
  { name: 'Break', startTime: '08:35', endTime: '08:45', periodType: 'BREAK', sortOrder: 2 },
  { name: 'Period 2', startTime: '08:45', endTime: '09:20', periodType: 'LESSON', sortOrder: 3 },
  { name: 'Period 3', startTime: '09:25', endTime: '10:00', periodType: 'LESSON', sortOrder: 4 },
  { name: 'Period 4', startTime: '10:00', endTime: '10:35', periodType: 'LESSON', sortOrder: 5 },
  { name: 'Lunch', startTime: '10:35', endTime: '11:15', periodType: 'LUNCH', sortOrder: 6 },
  { name: 'Period 5', startTime: '11:15', endTime: '11:50', periodType: 'LESSON', sortOrder: 7 },
  { name: 'Period 6', startTime: '11:55', endTime: '12:30', periodType: 'LESSON', sortOrder: 8 },
];

interface RoomSpec {
  name: string;
  roomType: 'CLASSROOM' | 'LAB' | 'GYM' | 'HALL' | 'LIBRARY' | 'OFFICE' | 'OUTDOOR';
  capacity: number;
  hasProjector: boolean;
  hasAv: boolean;
  building?: string;
  floor?: string;
}

var ROOMS: RoomSpec[] = [
  {
    name: 'Room 101',
    roomType: 'CLASSROOM',
    capacity: 30,
    hasProjector: true,
    hasAv: false,
    building: 'Main',
    floor: '1',
  },
  {
    name: 'Room 102',
    roomType: 'CLASSROOM',
    capacity: 30,
    hasProjector: true,
    hasAv: false,
    building: 'Main',
    floor: '1',
  },
  {
    name: 'Room 103',
    roomType: 'CLASSROOM',
    capacity: 30,
    hasProjector: true,
    hasAv: false,
    building: 'Main',
    floor: '1',
  },
  {
    name: 'Room 104',
    roomType: 'CLASSROOM',
    capacity: 30,
    hasProjector: true,
    hasAv: false,
    building: 'Main',
    floor: '1',
  },
  {
    name: 'Room 105',
    roomType: 'CLASSROOM',
    capacity: 30,
    hasProjector: true,
    hasAv: false,
    building: 'Main',
    floor: '1',
  },
  {
    name: 'Room 106',
    roomType: 'CLASSROOM',
    capacity: 30,
    hasProjector: true,
    hasAv: false,
    building: 'Main',
    floor: '1',
  },
  {
    name: 'Science Lab',
    roomType: 'LAB',
    capacity: 25,
    hasProjector: true,
    hasAv: true,
    building: 'Science',
    floor: '1',
  },
  {
    name: 'Gymnasium',
    roomType: 'GYM',
    capacity: 100,
    hasProjector: false,
    hasAv: true,
    building: 'Athletics',
    floor: '1',
  },
  {
    name: 'Library',
    roomType: 'LIBRARY',
    capacity: 50,
    hasProjector: true,
    hasAv: false,
    building: 'Main',
    floor: '2',
  },
  {
    name: 'Main Hall',
    roomType: 'HALL',
    capacity: 200,
    hasProjector: true,
    hasAv: true,
    building: 'Main',
    floor: '1',
  },
];

// Class section_code (the period number from seed-sis.ts) -> the room name we
// keep the Cycle 1 demo class meeting in. The room column on sis_classes is
// already populated with these names, so the timetable rooms line up cleanly.
var SECTION_TO_ROOM: Record<string, string> = {
  '1': 'Room 101',
  '2': 'Room 102',
  '3': 'Room 103',
  '4': 'Room 104',
  '5': 'Room 105',
  '6': 'Room 106',
};

interface CalendarEventSpec {
  title: string;
  description: string;
  eventType:
    | 'HOLIDAY'
    | 'PROFESSIONAL_DEVELOPMENT'
    | 'EARLY_DISMISSAL'
    | 'ASSEMBLY'
    | 'EXAM_PERIOD'
    | 'PARENT_EVENT'
    | 'FIELD_TRIP'
    | 'CUSTOM';
  startDate: string;
  endDate: string;
  allDay: boolean;
  startTime?: string;
  endTime?: string;
  affectsAttendance: boolean;
  isPublished: boolean;
}

var CALENDAR_EVENTS: CalendarEventSpec[] = [
  {
    title: 'Spring Break',
    description: 'No classes — campus closed for the week.',
    eventType: 'HOLIDAY',
    startDate: '2026-04-14',
    endDate: '2026-04-18',
    allDay: true,
    affectsAttendance: true,
    isPublished: true,
  },
  {
    title: 'Professional Development Day',
    description: 'Staff PD day. No students on campus.',
    eventType: 'PROFESSIONAL_DEVELOPMENT',
    startDate: '2026-03-15',
    endDate: '2026-03-15',
    allDay: true,
    affectsAttendance: true,
    isPublished: true,
  },
  {
    title: 'Parent-Teacher Conference Evening',
    description: 'Parent-teacher conferences in Main Hall. Sign up via the parent portal.',
    eventType: 'PARENT_EVENT',
    startDate: '2026-05-01',
    endDate: '2026-05-01',
    allDay: false,
    startTime: '18:00',
    endTime: '20:00',
    affectsAttendance: false,
    isPublished: true,
  },
  {
    title: 'End of Year Assembly',
    description: 'Year-end celebration in the Gymnasium.',
    eventType: 'ASSEMBLY',
    startDate: '2026-06-06',
    endDate: '2026-06-06',
    allDay: true,
    affectsAttendance: false,
    isPublished: true,
  },
  {
    title: 'Senior Prom',
    description: 'Senior prom in Main Hall — draft, ticket sales pending.',
    eventType: 'CUSTOM',
    startDate: '2026-05-23',
    endDate: '2026-05-23',
    allDay: true,
    affectsAttendance: false,
    isPublished: false,
  },
];

async function seedScheduling() {
  console.log('');
  console.log('  Scheduling Seed (Cycle 5 Step 4 — Schedules, Rooms, Timetable)');
  console.log('');

  var client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────
  var school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  var schoolId = school.id;

  var principal = await client.platformUser.findFirst({
    where: { email: 'principal@demo.campusos.dev' },
    select: { id: true, personId: true },
  });
  if (!principal) throw new Error('principal@demo.campusos.dev not found — run pnpm seed first');

  var employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, u.email::text AS email FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e JOIN platform.platform_users u ON u.id = e.account_id',
  )) as Array<{ id: string; email: string }>;
  var employeeByEmail: Record<string, string> = {};
  for (var ei = 0; ei < employees.length; ei++)
    employeeByEmail[employees[ei]!.email] = employees[ei]!.id;
  var riveraEmployeeId = employeeByEmail['teacher@demo.campusos.dev'];
  var parkEmployeeId = employeeByEmail['vp@demo.campusos.dev'];
  var mitchellEmployeeId = employeeByEmail['principal@demo.campusos.dev'];
  if (!riveraEmployeeId || !parkEmployeeId || !mitchellEmployeeId) {
    throw new Error('seed-scheduling: missing hr_employees rows. Run seed:hr first.');
  }

  // ── 2. Idempotency gate — bell schedules ──
  var existingScheds = (await client.$queryRawUnsafe(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.sch_bell_schedules',
  )) as Array<{ c: bigint }>;
  if (existingScheds[0] && Number(existingScheds[0].c) > 0) {
    console.log('  sch_bell_schedules already populated — skipping');
    return;
  }

  // ── 3. Bell schedules + periods ──
  console.log('  bell schedules + periods:');
  var standardId = await insertBellSchedule(client, schoolId, 'Standard Day', 'STANDARD', true);
  await insertPeriods(client, standardId, STANDARD_DAY_PERIODS);
  console.log('    Standard Day (default) — ' + STANDARD_DAY_PERIODS.length + ' periods');
  var earlyId = await insertBellSchedule(
    client,
    schoolId,
    'Early Dismissal',
    'EARLY_DISMISSAL',
    false,
  );
  await insertPeriods(client, earlyId, EARLY_DISMISSAL_PERIODS);
  console.log('    Early Dismissal — ' + EARLY_DISMISSAL_PERIODS.length + ' periods');

  // ── 4. Rooms ──
  console.log('  rooms:');
  var roomIdByName: Record<string, string> = {};
  for (var ri = 0; ri < ROOMS.length; ri++) {
    var r = ROOMS[ri]!;
    var roomId = generateId();
    roomIdByName[r.name] = roomId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sch_rooms (id, school_id, name, capacity, room_type, has_projector, has_av, building, floor, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4::int, $5, $6, $7, $8, $9, true)',
      roomId,
      schoolId,
      r.name,
      r.capacity,
      r.roomType,
      r.hasProjector,
      r.hasAv,
      r.building ?? null,
      r.floor ?? null,
    );
  }
  console.log('    ' + ROOMS.length + ' rooms (Room 101-106 + Lab + Gym + Library + Main Hall)');

  // ── 5. Timetable slots — Rivera's 6 classes into Periods 1-6 ──
  // Pull the period_id for Standard Day P1..P6 by start_time. The standard
  // day has only one row per LESSON period at each start time, so this lookup
  // is deterministic.
  var standardLessonRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' +
      TENANT_SCHEMA +
      ".sch_periods WHERE bell_schedule_id = $1::uuid AND period_type = 'LESSON' ORDER BY sort_order",
    standardId,
  )) as Array<{ id: string; name: string }>;
  var lessonPeriodIdByName: Record<string, string> = {};
  for (var lp = 0; lp < standardLessonRows.length; lp++) {
    lessonPeriodIdByName[standardLessonRows[lp]!.name] = standardLessonRows[lp]!.id;
  }

  var classes = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, section_code FROM ' +
      TENANT_SCHEMA +
      '.sis_classes ORDER BY section_code',
  )) as Array<{ id: string; section_code: string }>;
  if (classes.length === 0) throw new Error('No sis_classes — run seed:sis first');

  console.log('  timetable slots:');
  var slotByClassId: Record<string, string> = {};
  var slotIdForPeriod1: string | null = null;
  for (var clk = 0; clk < classes.length; clk++) {
    var cls = classes[clk]!;
    var roomName = SECTION_TO_ROOM[cls.section_code];
    if (!roomName) continue; // ignore any classes outside Periods 1-6
    var periodName = 'Period ' + cls.section_code;
    var periodId = lessonPeriodIdByName[periodName];
    if (!periodId) throw new Error('period ' + periodName + ' not found in standard schedule');
    var roomId = roomIdByName[roomName]!;
    var slotId = generateId();
    slotByClassId[cls.id] = slotId;
    if (cls.section_code === '1') slotIdForPeriod1 = slotId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sch_timetable_slots (id, school_id, class_id, period_id, teacher_id, room_id, effective_from) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::date)',
      slotId,
      schoolId,
      cls.id,
      periodId,
      riveraEmployeeId,
      roomId,
      '2025-08-15',
    );
  }
  console.log(
    '    ' + Object.keys(slotByClassId).length + ' timetable slots — Rivera in P1-P6, M-F',
  );
  if (!slotIdForPeriod1) throw new Error('Period 1 slot was not seeded — cannot wire coverage');

  // ── 6. Calendar events ──
  console.log('  calendar events:');
  for (var cei = 0; cei < CALENDAR_EVENTS.length; cei++) {
    var ev = CALENDAR_EVENTS[cei]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sch_calendar_events (id, school_id, title, description, event_type, start_date, end_date, all_day, start_time, end_time, affects_attendance, is_published, created_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, $8, $9::time, $10::time, $11, $12, $13::uuid)',
      generateId(),
      schoolId,
      ev.title,
      ev.description,
      ev.eventType,
      ev.startDate,
      ev.endDate,
      ev.allDay,
      ev.startTime ? ev.startTime : null,
      ev.endTime ? ev.endTime : null,
      ev.affectsAttendance,
      ev.isPublished,
      principal.id,
    );
  }
  var publishedCount = CALENDAR_EVENTS.filter(function (e) {
    return e.isPublished;
  }).length;
  console.log(
    '    ' +
      CALENDAR_EVENTS.length +
      ' events (' +
      publishedCount +
      ' published, ' +
      (CALENDAR_EVENTS.length - publishedCount) +
      ' draft)',
  );

  // ── 7. Day override — snow day ──
  console.log('  day overrides:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_calendar_day_overrides (id, school_id, override_date, is_school_day, reason, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::date, false, $4, $5::uuid)',
    generateId(),
    schoolId,
    '2026-02-07',
    'Winter storm closure',
    principal.id,
  );
  console.log('    1 day override (2026-02-07 snow day)');

  // ── 8. Coverage request — Rivera's seeded sick leave (2026-03-09 to 2026-03-10) ──
  // The Cycle 4 seed plants an APPROVED Sick Leave request for Rivera on
  // 2026-03-09..10. The Step 6 CoverageConsumer would normally generate
  // sch_coverage_requests rows from the hr.leave.coverage_needed event; the
  // seed plants them directly so the Step 7-8 UI has live data on a fresh
  // provision. Day 1 is ASSIGNED (Park covering) with a substitution_timetable
  // row that materialises the assignment for the substitute's daily schedule.
  var leaveRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".hr_leave_requests WHERE employee_id = $1::uuid AND start_date = '2026-03-09'::date AND status = 'APPROVED' LIMIT 1",
    riveraEmployeeId,
  )) as Array<{ id: string }>;
  var leaveRequestId = leaveRows[0] ? leaveRows[0].id : null;

  console.log('  coverage requests:');
  var coverageId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_coverage_requests (id, school_id, timetable_slot_id, absent_teacher_id, leave_request_id, coverage_date, status, assigned_substitute_id, assigned_at, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, 'ASSIGNED', $7::uuid, $8::timestamptz, $9)",
    coverageId,
    schoolId,
    slotIdForPeriod1,
    riveraEmployeeId,
    leaveRequestId,
    '2026-03-09',
    parkEmployeeId,
    '2026-03-08T17:00:00Z',
    'Rivera — flu. Linda Park covering Period 1 Algebra.',
  );
  console.log('    1 coverage request (2026-03-09 P1 Algebra) — ASSIGNED to VP Linda Park');

  // ── 9. Substitution timetable row — Park covers Period 1 in Room 101 on 2026-03-09 ──
  console.log('  substitution timetable:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_substitution_timetable (id, school_id, original_slot_id, effective_date, substitute_id, room_id, coverage_request_id, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::uuid, $6::uuid, $7::uuid, $8)',
    generateId(),
    schoolId,
    slotIdForPeriod1,
    '2026-03-09',
    parkEmployeeId,
    roomIdByName['Room 101']!,
    coverageId,
    'Same room as the original slot.',
  );
  console.log('    1 substitution row — Park, Room 101, 2026-03-09');

  // ── 10. Room booking — Main Hall for Parent-Teacher Conference Evening ──
  console.log('  room bookings:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_room_bookings (id, school_id, room_id, booked_by, booking_purpose, start_at, end_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $7::timestamptz, 'CONFIRMED')",
    generateId(),
    schoolId,
    roomIdByName['Main Hall']!,
    mitchellEmployeeId,
    'Parent-Teacher Conference Evening',
    '2026-05-01T18:00:00Z',
    '2026-05-01T20:00:00Z',
  );
  console.log('    1 room booking (Main Hall, 2026-05-01 18:00-20:00)');

  // ── 11. Summary ──
  console.log('');
  console.log('  Scheduling seed complete:');
  await summary(client);
}

async function insertBellSchedule(
  client: any,
  schoolId: string,
  name: string,
  scheduleType: string,
  isDefault: boolean,
): Promise<string> {
  var id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_bell_schedules (id, school_id, name, schedule_type, is_default) VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
    id,
    schoolId,
    name,
    scheduleType,
    isDefault,
  );
  return id;
}

async function insertPeriods(
  client: any,
  bellScheduleId: string,
  periods: PeriodSpec[],
): Promise<void> {
  for (var i = 0; i < periods.length; i++) {
    var p = periods[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sch_periods (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order) ' +
        'VALUES ($1::uuid, $2::uuid, $3, NULL, $4::time, $5::time, $6, $7::int)',
      generateId(),
      bellScheduleId,
      p.name,
      p.startTime,
      p.endTime,
      p.periodType,
      p.sortOrder,
    );
  }
}

async function summary(client: any): Promise<void> {
  var rows = [
    ['sch_bell_schedules', 'sch_bell_schedules'],
    ['sch_periods', 'sch_periods'],
    ['sch_rooms', 'sch_rooms'],
    ['sch_timetable_slots', 'sch_timetable_slots'],
    ['sch_calendar_events', 'sch_calendar_events'],
    ['sch_calendar_day_overrides', 'sch_calendar_day_overrides'],
    ['sch_coverage_requests', 'sch_coverage_requests'],
    ['sch_substitution_timetable', 'sch_substitution_timetable'],
    ['sch_room_bookings', 'sch_room_bookings'],
  ];
  for (var i = 0; i < rows.length; i++) {
    var label = rows[i]![0]!;
    var table = rows[i]![1]!;
    var counts = (await client.$queryRawUnsafe(
      'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.' + table,
    )) as Array<{ c: bigint }>;
    var n = counts[0] ? Number(counts[0].c) : 0;
    console.log('    ' + label + ': ' + n);
  }
}

seedScheduling()
  .catch(function (err) {
    console.error(err);
    process.exit(1);
  })
  .finally(function () {
    return disconnectAll();
  });
