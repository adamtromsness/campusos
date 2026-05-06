export type AttendanceStatus = 'PRESENT' | 'TARDY' | 'ABSENT' | 'EXCUSED' | 'EARLY_DEPARTURE';
export type ConfirmationStatus = 'PRE_POPULATED' | 'CONFIRMED';
export type TodayAttendanceStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED';

export interface CourseSummary {
  id: string;
  code: string;
  name: string;
  gradeLevel: string | null;
}

export interface AcademicYearSummary {
  id: string;
  name: string;
  isCurrent: boolean;
}

export interface TermSummary {
  id: string;
  name: string;
  termType: string;
}

export interface ClassTeacher {
  personId: string;
  fullName: string;
  isPrimaryTeacher: boolean;
}

export interface TodayAttendanceSummary {
  status: TodayAttendanceStatus;
  totalRecorded: number;
  present: number;
  tardy: number;
  absent: number;
  excused: number;
  earlyDeparture: number;
}

export interface ClassDto {
  id: string;
  schoolId: string;
  sectionCode: string;
  room: string | null;
  maxEnrollment: number | null;
  course: CourseSummary;
  academicYear: AcademicYearSummary;
  term: TermSummary | null;
  teachers: ClassTeacher[];
  enrollmentCount: number;
  todayAttendance?: TodayAttendanceSummary;
}

export interface StudentDto {
  id: string;
  studentNumber: string | null;
  firstName: string;
  lastName: string;
  fullName: string;
  gradeLevel: string | null;
  enrollmentStatus: string;
  homeroomClassId: string | null;
  schoolId: string;
  personId: string;
  platformStudentId: string;
}

export type AbsenceReasonCategory =
  | 'ILLNESS'
  | 'MEDICAL_APPOINTMENT'
  | 'FAMILY_EMERGENCY'
  | 'HOLIDAY'
  | 'RELIGIOUS_OBSERVANCE'
  | 'OTHER';

export type AbsenceRequestType = 'SAME_DAY_REPORT' | 'ADVANCE_REQUEST';

export interface CreateAbsenceRequestPayload {
  studentId: string;
  absenceDateFrom: string;
  absenceDateTo: string;
  requestType: AbsenceRequestType;
  reasonCategory: AbsenceReasonCategory;
  reasonText: string;
  supportingDocumentS3Key?: string;
}

export interface AttendanceRecord {
  id: string;
  studentId: string;
  studentNumber: string | null;
  firstName: string;
  lastName: string;
  fullName: string;
  classId: string;
  date: string;
  period: string;
  status: AttendanceStatus;
  confirmationStatus: ConfirmationStatus;
  parentExplanation: string | null;
  markedBy: string | null;
  markedAt: string | null;
  absenceRequestId: string | null;
}

export interface BatchAttendanceEntry {
  studentId: string;
  status: AttendanceStatus;
  parentExplanation?: string;
}

export interface BatchSubmitResult {
  classId: string;
  date: string;
  period: string;
  totalStudents: number;
  presentCount: number;
  tardyCount: number;
  absentCount: number;
  earlyDepartureCount: number;
  excusedCount: number;
  confirmedAt: string;
}

// ── Classroom (Cycle 2) ──────────────────────────────────────────────────

export type AssignmentTypeCategory = 'HOMEWORK' | 'QUIZ' | 'TEST' | 'PROJECT' | 'CLASSWORK';

export interface AssignmentTypeDto {
  id: string;
  name: string;
  category: AssignmentTypeCategory;
  weightInCategory: number;
}

export interface AssignmentCategoryDto {
  id: string;
  classId: string;
  name: string;
  weight: number;
  sortOrder: number;
}

export interface AssignmentTypeSummary {
  id: string;
  name: string;
  category: AssignmentTypeCategory;
}

export interface AssignmentCategorySummary {
  id: string;
  name: string;
  weight: number;
}

export interface AssignmentDto {
  id: string;
  classId: string;
  title: string;
  instructions: string | null;
  assignmentType: AssignmentTypeSummary;
  category: AssignmentCategorySummary | null;
  gradingScaleId: string | null;
  dueDate: string | null;
  maxPoints: number;
  isAiGradingEnabled: boolean;
  isExtraCredit: boolean;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssignmentPayload {
  title: string;
  instructions?: string;
  assignmentTypeId: string;
  categoryId?: string;
  dueDate?: string;
  maxPoints?: number;
  isExtraCredit?: boolean;
  isPublished?: boolean;
}

export interface UpdateAssignmentPayload {
  title?: string;
  instructions?: string;
  assignmentTypeId?: string;
  categoryId?: string;
  dueDate?: string | null;
  maxPoints?: number;
  isExtraCredit?: boolean;
  isPublished?: boolean;
}

export interface UpsertCategoryEntry {
  name: string;
  weight: number;
  sortOrder?: number;
}

// ── Submissions, grades, gradebook (Cycle 2 Step 8) ──────────────────────

export type SubmissionStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'GRADED' | 'RETURNED';

export interface SubmissionStudentSummary {
  id: string;
  studentNumber: string | null;
  firstName: string;
  lastName: string;
  fullName: string;
}

export interface SubmissionGradeSummary {
  id: string;
  gradeValue: number;
  letterGrade: string | null;
  feedback: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  gradedAt: string;
}

export interface SubmissionDto {
  id: string;
  assignmentId: string;
  classId: string;
  student: SubmissionStudentSummary;
  status: SubmissionStatus;
  submissionText: string | null;
  attachments: Array<Record<string, unknown>>;
  submittedAt: string | null;
  returnedAt: string | null;
  returnReason: string | null;
  grade: SubmissionGradeSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeacherSubmissionListDto {
  assignmentId: string;
  classId: string;
  rosterSize: number;
  submittedCount: number;
  gradedCount: number;
  publishedCount: number;
  submissions: SubmissionDto[];
}

export interface GradeDto {
  id: string;
  assignmentId: string;
  classId: string;
  studentId: string;
  submissionId: string | null;
  teacherId: string;
  gradeValue: number;
  maxPoints: number;
  percentage: number;
  letterGrade: string | null;
  feedback: string | null;
  isPublished: boolean;
  gradedAt: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GradeSubmissionPayload {
  gradeValue: number;
  letterGrade?: string;
  feedback?: string;
  publish?: boolean;
}

export interface BatchGradeEntry {
  studentId: string;
  gradeValue: number;
  letterGrade?: string;
  feedback?: string;
}

export interface BatchGradePayload {
  assignmentId: string;
  entries: BatchGradeEntry[];
  publish?: boolean;
}

export interface BatchGradeResultDto {
  assignmentId: string;
  classId: string;
  processedCount: number;
  insertedCount: number;
  updatedCount: number;
  publishedCount: number;
  grades: GradeDto[];
}

export interface PublishAllResultDto {
  assignmentId: string;
  classId: string;
  publishedCount: number;
  grades: GradeDto[];
}

export interface GradebookStudentSummary {
  id: string;
  studentNumber: string | null;
  firstName: string;
  lastName: string;
  fullName: string;
}

export interface GradebookClassSummary {
  id: string;
  sectionCode: string | null;
  courseCode: string | null;
  courseName: string | null;
}

export interface GradebookSnapshotDto {
  id: string;
  classId: string;
  studentId: string;
  termId: string;
  currentAverage: number | null;
  letterGrade: string | null;
  assignmentsGraded: number;
  assignmentsTotal: number;
  lastGradeEventAt: string | null;
  lastUpdatedAt: string;
}

export interface GradebookClassRowDto {
  student: GradebookStudentSummary;
  snapshot: GradebookSnapshotDto | null;
}

export interface GradebookClassResponseDto {
  class: GradebookClassSummary;
  termId: string | null;
  rows: GradebookClassRowDto[];
}

export interface GradebookStudentRowDto {
  class: GradebookClassSummary;
  snapshot: GradebookSnapshotDto | null;
}

export interface GradebookStudentResponseDto {
  student: GradebookStudentSummary;
  termId: string | null;
  rows: GradebookStudentRowDto[];
}

export type EffortRating =
  | 'EXCELLENT'
  | 'GOOD'
  | 'SATISFACTORY'
  | 'NEEDS_IMPROVEMENT'
  | 'UNSATISFACTORY';

export interface ProgressNoteDto {
  id: string;
  classId: string;
  studentId: string;
  termId: string;
  authorId: string;
  noteText: string;
  overallEffortRating: EffortRating | null;
  isParentVisible: boolean;
  isStudentVisible: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProgressNotePayload {
  studentId: string;
  termId: string;
  noteText: string;
  overallEffortRating?: EffortRating;
  isParentVisible?: boolean;
  isStudentVisible?: boolean;
}

// ── Student grade views (Cycle 2 Step 9) ─────────────────────────────────

export interface StudentGradeSubmissionSummaryDto {
  id: string;
  status: SubmissionStatus;
  submittedAt: string | null;
}

export interface StudentGradeEntryDto {
  id: string;
  gradeValue: number;
  maxPoints: number;
  percentage: number;
  letterGrade: string | null;
  feedback: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  gradedAt: string;
}

export interface StudentClassAssignmentRowDto {
  assignment: AssignmentDto;
  submission: StudentGradeSubmissionSummaryDto | null;
  grade: StudentGradeEntryDto | null;
}

export interface StudentClassGradesResponseDto {
  class: GradebookClassSummary;
  student: GradebookStudentSummary;
  termId: string | null;
  snapshot: GradebookSnapshotDto | null;
  assignments: StudentClassAssignmentRowDto[];
}

export interface SubmitAssignmentPayload {
  submissionText?: string;
  attachments?: Array<Record<string, unknown>>;
}

// ── Notifications (Cycle 3 Step 8) ───────────────────────────────────────

export interface NotificationItem {
  id: string | null;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  isRead: boolean;
}

export interface NotificationInboxResponse {
  unreadCount: number;
  items: NotificationItem[];
  lastReadAt: number;
}

export interface NotificationHistoryResponse {
  items: NotificationItem[];
  nextCursor: string | null;
  lastReadAt: number;
}

export interface MarkAllReadResponse {
  lastReadAt: number;
}

// ── Messaging (Cycle 3 Step 9) ────────────────────────────────────────────

export type ThreadParticipantRole = 'OWNER' | 'PARTICIPANT' | 'OBSERVER';
export type MessageModerationStatus = 'CLEAN' | 'FLAGGED' | 'BLOCKED' | 'ESCALATED';

export interface ThreadParticipantDto {
  id: string;
  platformUserId: string;
  role: ThreadParticipantRole | string;
  displayName: string | null;
  email: string | null;
  isMuted: boolean;
  lastReadAt: string | null;
  leftAt: string | null;
}

export interface ThreadDto {
  id: string;
  schoolId: string;
  threadTypeId: string;
  threadTypeName: string;
  subject: string | null;
  createdBy: string;
  lastMessageAt: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  participants: ThreadParticipantDto[];
  unreadCount: number;
  lastMessagePreview: string | null;
  lastSenderName: string | null;
}

export interface ThreadTypeDto {
  id: string;
  name: string;
  description: string | null;
  allowedRoles: string[];
  isSystem: boolean;
}

export interface MessagingRecipientDto {
  platformUserId: string;
  displayName: string | null;
  email: string | null;
  roles: string[];
}

export interface MessageDto {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string | null;
  body: string;
  isEdited: boolean;
  editedAt: string | null;
  isDeleted: boolean;
  deletedAt: string | null;
  moderationStatus: MessageModerationStatus | string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateThreadPayload {
  threadTypeId: string;
  subject?: string;
  participants: { platformUserId: string; role?: ThreadParticipantRole }[];
  initialMessage?: string;
}

export interface PostMessagePayload {
  body: string;
}

export interface MarkThreadReadResponse {
  threadId: string;
  marked: number;
  unreadCount: number;
}

// ── Announcements (Cycle 3 Step 10) ───────────────────────────────────────

export type AudienceType = 'ALL_SCHOOL' | 'CLASS' | 'YEAR_GROUP' | 'ROLE' | 'CUSTOM';

export interface AnnouncementDto {
  id: string;
  schoolId: string;
  authorId: string;
  authorName: string | null;
  title: string;
  body: string;
  audienceType: AudienceType;
  audienceRef: string | null;
  alertTypeId: string | null;
  alertTypeName: string | null;
  alertTypeSeverity: string | null;
  publishAt: string | null;
  expiresAt: string | null;
  isPublished: boolean;
  isRecurring: boolean;
  recurrenceRule: string | null;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnnouncementStatsDto {
  announcementId: string;
  totalAudience: number;
  readCount: number;
  readPercentage: number;
  pendingCount: number;
  deliveredCount: number;
  failedCount: number;
}

export interface CreateAnnouncementPayload {
  title: string;
  body: string;
  audienceType: AudienceType;
  audienceRef?: string;
  alertTypeId?: string;
  publishAt?: string;
  expiresAt?: string;
  isPublished?: boolean;
}

export interface UpdateAnnouncementPayload {
  title?: string;
  body?: string;
  audienceType?: AudienceType;
  audienceRef?: string;
  alertTypeId?: string;
  publishAt?: string;
  expiresAt?: string;
  isPublished?: boolean;
}

export interface MarkAnnouncementReadResponse {
  announcementId: string;
  readAt: string;
  newlyRead: boolean;
}

export interface AbsenceRequestDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string;
  submittedBy: string;
  submittedByEmail: string | null;
  absenceDateFrom: string;
  absenceDateTo: string;
  requestType: string;
  reasonCategory: string;
  reasonText: string;
  supportingDocumentS3Key: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  createdAt: string;
}

// ── Cycle 4: HR & Workforce Core (M80) ──────────────────────

export type EmploymentType =
  | 'FULL_TIME'
  | 'PART_TIME'
  | 'CONTRACT'
  | 'TEMPORARY'
  | 'INTERN'
  | 'VOLUNTEER';

export type EmploymentStatus = 'ACTIVE' | 'ON_LEAVE' | 'TERMINATED' | 'SUSPENDED';

export interface EmployeePositionDto {
  id: string;
  positionId: string;
  positionTitle: string;
  isTeachingRole: boolean;
  isPrimary: boolean;
  fte: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface EmployeeDto {
  id: string;
  personId: string;
  accountId: string;
  schoolId: string;
  employeeNumber: string | null;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  employmentType: EmploymentType;
  employmentStatus: EmploymentStatus;
  hireDate: string;
  terminationDate: string | null;
  positions: EmployeePositionDto[];
  primaryPositionTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PositionDto {
  id: string;
  schoolId: string;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
  isTeachingRole: boolean;
  isActive: boolean;
  activeAssignments: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeDocumentDto {
  id: string;
  employeeId: string;
  documentTypeId: string;
  documentTypeName: string;
  fileName: string;
  s3Key: string;
  contentType: string | null;
  fileSizeBytes: number | null;
  uploadedBy: string;
  uploadedAt: string;
  expiryDate: string | null;
  isArchived: boolean;
}

export type CertificationType =
  | 'TEACHING_LICENCE'
  | 'FIRST_AID'
  | 'SAFEGUARDING_LEVEL1'
  | 'SAFEGUARDING_LEVEL2'
  | 'DBS_BASIC'
  | 'DBS_ENHANCED'
  | 'FOOD_HYGIENE'
  | 'FIRE_SAFETY_WARDEN'
  | 'SPECIALIST_SUBJECT'
  | 'CUSTOM';

export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'REVOKED';

export interface CertificationDto {
  id: string;
  employeeId: string;
  certificationType: CertificationType;
  certificationName: string;
  issuingBody: string | null;
  referenceNumber: string | null;
  issuedDate: string | null;
  expiryDate: string | null;
  verificationStatus: VerificationStatus;
  verifiedBy: string | null;
  verifiedAt: string | null;
  documentS3Key: string | null;
  notes: string | null;
  daysUntilExpiry: number | null;
}

export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface LeaveTypeDto {
  id: string;
  name: string;
  description: string | null;
  isPaid: boolean;
  accrualRate: number;
  maxBalance: number | null;
  isActive: boolean;
}

export interface LeaveBalanceDto {
  leaveTypeId: string;
  leaveTypeName: string;
  isPaid: boolean;
  accrued: number;
  used: number;
  pending: number;
  available: number;
  academicYearId: string;
}

export interface LeaveRequestDto {
  id: string;
  employeeId: string;
  employeeName: string;
  leaveTypeId: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  status: LeaveRequestStatus;
  reason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  cancelledAt: string | null;
  isHrInitiated: boolean;
}

export interface SubmitLeaveRequestPayload {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  reason?: string;
}

export interface ReviewLeaveRequestPayload {
  reviewNotes?: string;
}

export type ComplianceUrgency = 'green' | 'amber' | 'red';

export interface ComplianceRowDto {
  requirementId: string;
  requirementName: string;
  certificationType: string | null;
  frequency: string;
  isCompliant: boolean;
  lastCompletedDate: string | null;
  nextDueDate: string | null;
  linkedCertificationId: string | null;
  daysUntilDue: number | null;
  urgency: ComplianceUrgency;
}

export interface EmployeeComplianceDto {
  employeeId: string;
  employeeName: string;
  primaryPositionTitle: string | null;
  rows: ComplianceRowDto[];
  totalRequirements: number;
  compliantCount: number;
  amberCount: number;
  redCount: number;
}

export interface ComplianceDashboardDto {
  employees: EmployeeComplianceDto[];
  totalEmployees: number;
  employeesWithGaps: number;
}

// ── Cycle 5: Scheduling (M22) ─────────────────────────────────

export type BellScheduleType = 'STANDARD' | 'EARLY_DISMISSAL' | 'ASSEMBLY' | 'EXAM' | 'CUSTOM';
export type PeriodType = 'LESSON' | 'BREAK' | 'LUNCH' | 'REGISTRATION' | 'ASSEMBLY';

export interface PeriodDto {
  id: string;
  bellScheduleId: string;
  name: string;
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
  periodType: PeriodType;
  sortOrder: number;
}

export interface BellScheduleDto {
  id: string;
  schoolId: string;
  name: string;
  scheduleType: BellScheduleType;
  isDefault: boolean;
  periods: PeriodDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateBellSchedulePayload {
  name: string;
  scheduleType: BellScheduleType;
  isDefault?: boolean;
}

export interface UpdateBellSchedulePayload {
  name?: string;
  scheduleType?: BellScheduleType;
  isDefault?: boolean;
}

export interface PeriodInputPayload {
  id?: string;
  name: string;
  dayOfWeek?: number | null;
  startTime: string;
  endTime: string;
  periodType: PeriodType;
  sortOrder?: number;
}

export interface UpsertPeriodsPayload {
  periods: PeriodInputPayload[];
}

export type RoomType = 'CLASSROOM' | 'LAB' | 'GYM' | 'HALL' | 'LIBRARY' | 'OFFICE' | 'OUTDOOR';

export interface RoomDto {
  id: string;
  schoolId: string;
  name: string;
  capacity: number | null;
  roomType: RoomType;
  hasProjector: boolean;
  hasAv: boolean;
  floor: string | null;
  building: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  available?: boolean | null;
}

export interface CreateRoomPayload {
  name: string;
  capacity?: number;
  roomType: RoomType;
  hasProjector?: boolean;
  hasAv?: boolean;
  floor?: string;
  building?: string;
}

export interface UpdateRoomPayload {
  name?: string;
  capacity?: number;
  roomType?: RoomType;
  hasProjector?: boolean;
  hasAv?: boolean;
  floor?: string;
  building?: string;
  isActive?: boolean;
}

export interface ListRoomsArgs {
  includeInactive?: boolean;
  roomType?: RoomType;
  availabilityDate?: string;
  availabilityPeriodId?: string;
}

export interface TimetableSlotDto {
  id: string;
  schoolId: string;
  classId: string;
  classSectionCode: string;
  courseName: string;
  periodId: string;
  periodName: string;
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
  teacherId: string | null;
  teacherName: string | null;
  roomId: string;
  roomName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
}

export interface CreateTimetableSlotPayload {
  classId: string;
  periodId: string;
  teacherId?: string | null;
  roomId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
}

export interface UpdateTimetableSlotPayload {
  teacherId?: string | null;
  roomId?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  notes?: string;
}

export interface ListTimetableArgs {
  classId?: string;
  teacherId?: string;
  roomId?: string;
  onDate?: string;
}

export type RoomBookingStatus = 'CONFIRMED' | 'CANCELLED';

export interface RoomBookingDto {
  id: string;
  schoolId: string;
  roomId: string;
  roomName: string;
  bookedById: string;
  bookedByName: string | null;
  bookingPurpose: string;
  startAt: string;
  endAt: string;
  status: RoomBookingStatus;
  cancelledAt: string | null;
  cancelledReason: string | null;
  createdAt: string;
}

export interface CreateRoomBookingPayload {
  roomId: string;
  bookingPurpose: string;
  startAt: string;
  endAt: string;
}

export interface CancelRoomBookingPayload {
  cancelledReason?: string;
}

export interface ListRoomBookingsArgs {
  roomId?: string;
  status?: RoomBookingStatus;
  fromDate?: string;
  toDate?: string;
}

export type RoomChangeRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'AUTO_APPROVED';

export interface RoomChangeRequestDto {
  id: string;
  schoolId: string;
  timetableSlotId: string;
  classSectionCode: string;
  courseName: string;
  periodName: string;
  requestedById: string;
  requestedByName: string | null;
  currentRoomId: string;
  currentRoomName: string;
  requestedRoomId: string | null;
  requestedRoomName: string | null;
  requestDate: string;
  reason: string;
  status: RoomChangeRequestStatus;
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
}

export interface CreateRoomChangeRequestPayload {
  timetableSlotId: string;
  requestedRoomId?: string | null;
  requestDate: string;
  reason: string;
}

export interface ReviewRoomChangeRequestPayload {
  approvedRoomId?: string;
  reviewNotes?: string;
}

export interface ListRoomChangeRequestsArgs {
  status?: RoomChangeRequestStatus;
  fromDate?: string;
  toDate?: string;
}

// ── Calendar / Coverage (Cycle 5 Step 8) ─────────────────────

export type CalendarEventType =
  | 'HOLIDAY'
  | 'PROFESSIONAL_DEVELOPMENT'
  | 'EARLY_DISMISSAL'
  | 'ASSEMBLY'
  | 'EXAM_PERIOD'
  | 'PARENT_EVENT'
  | 'FIELD_TRIP'
  | 'CUSTOM';

export interface CalendarEventDto {
  id: string;
  schoolId: string;
  title: string;
  description: string | null;
  eventType: CalendarEventType;
  startDate: string;
  endDate: string;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  bellScheduleId: string | null;
  bellScheduleName: string | null;
  affectsAttendance: boolean;
  isPublished: boolean;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCalendarEventPayload {
  title: string;
  description?: string;
  eventType: CalendarEventType;
  startDate: string;
  endDate: string;
  allDay?: boolean;
  startTime?: string;
  endTime?: string;
  bellScheduleId?: string;
  affectsAttendance?: boolean;
  isPublished?: boolean;
}

export interface UpdateCalendarEventPayload {
  title?: string;
  description?: string;
  eventType?: CalendarEventType;
  startDate?: string;
  endDate?: string;
  allDay?: boolean;
  startTime?: string;
  endTime?: string;
  bellScheduleId?: string | null;
  affectsAttendance?: boolean;
  isPublished?: boolean;
}

export interface ListCalendarEventsArgs {
  fromDate?: string;
  toDate?: string;
  eventType?: CalendarEventType;
  includeDrafts?: boolean;
  myKidsOnly?: boolean;
}

export type CalendarEventRsvpResponse = 'GOING' | 'TENTATIVE' | 'NOT_GOING';

export interface CalendarEventRsvpDto {
  id: string;
  calendarEventId: string;
  personId: string;
  personName: string | null;
  response: CalendarEventRsvpResponse;
  respondedAt: string;
}

export interface CalendarEventRsvpSummaryDto {
  going: number;
  tentative: number;
  notGoing: number;
  myResponse: CalendarEventRsvpResponse | null;
}

export interface SetCalendarEventRsvpPayload {
  response: CalendarEventRsvpResponse;
}

export interface DayOverrideDto {
  id: string;
  schoolId: string;
  overrideDate: string;
  bellScheduleId: string | null;
  bellScheduleName: string | null;
  isSchoolDay: boolean;
  reason: string | null;
  createdAt: string;
}

export interface CreateDayOverridePayload {
  overrideDate: string;
  bellScheduleId?: string;
  isSchoolDay?: boolean;
  reason?: string;
}

export interface ListDayOverridesArgs {
  fromDate?: string;
  toDate?: string;
}

export type DayResolutionSource = 'OVERRIDE' | 'EVENT' | 'DEFAULT' | 'NONE';

export interface CalendarDayResolutionDto {
  date: string;
  resolvedFrom: DayResolutionSource;
  isSchoolDay: boolean;
  bellScheduleId: string | null;
  bellScheduleName: string | null;
  overrideId: string | null;
  overrideReason: string | null;
  eventIds: string[];
}

export type CoverageStatus = 'OPEN' | 'ASSIGNED' | 'COVERED' | 'CANCELLED';

export interface CoverageRequestDto {
  id: string;
  schoolId: string;
  timetableSlotId: string;
  classSectionCode: string;
  courseName: string;
  periodId: string;
  periodName: string;
  roomId: string;
  roomName: string;
  absentTeacherId: string;
  absentTeacherName: string;
  leaveRequestId: string | null;
  coverageDate: string;
  status: CoverageStatus;
  assignedSubstituteId: string | null;
  assignedSubstituteName: string | null;
  assignedAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface AssignCoveragePayload {
  substituteId: string;
  roomId?: string;
  notes?: string;
}

export interface CancelCoveragePayload {
  notes?: string;
}

export interface ListCoverageArgs {
  fromDate?: string;
  toDate?: string;
  status?: CoverageStatus;
}

export interface SubstitutionDto {
  id: string;
  schoolId: string;
  originalSlotId: string;
  classSectionCode: string;
  courseName: string;
  periodName: string;
  effectiveDate: string;
  substituteId: string;
  substituteName: string;
  roomId: string;
  roomName: string;
  coverageRequestId: string | null;
  absentTeacherName: string | null;
  notes: string | null;
}

export interface ListSubstitutionsArgs {
  fromDate?: string;
  toDate?: string;
}

// ── Cycle 6: Enrollment (M81) ─────────────────────────────────

export interface AcademicYearDto {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

export type EnrollmentPeriodStatus = 'UPCOMING' | 'OPEN' | 'CLOSED';

export interface IntakeCapacityDto {
  id: string;
  enrollmentPeriodId: string;
  streamId: string | null;
  gradeLevel: string;
  totalPlaces: number;
  reservedPlaces: number;
}

export interface AdmissionStreamDto {
  id: string;
  enrollmentPeriodId: string;
  name: string;
  gradeLevel: string | null;
  opensAt: string | null;
  closesAt: string | null;
  isActive: boolean;
}

export interface CapacitySummaryRowDto {
  gradeLevel: string;
  totalPlaces: number;
  reserved: number;
  applicationsReceived: number;
  offersIssued: number;
  offersAccepted: number;
  waitlisted: number;
  available: number;
}

export interface EnrollmentPeriodDto {
  id: string;
  schoolId: string;
  academicYearId: string;
  academicYearName: string;
  name: string;
  opensAt: string;
  closesAt: string;
  status: EnrollmentPeriodStatus;
  allowsMidYearApplications: boolean;
  streams: AdmissionStreamDto[];
  capacities: IntakeCapacityDto[];
  capacitySummary: CapacitySummaryRowDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateEnrollmentPeriodPayload {
  academicYearId: string;
  name: string;
  opensAt: string;
  closesAt: string;
  allowsMidYearApplications?: boolean;
}

export interface UpdateEnrollmentPeriodPayload {
  name?: string;
  opensAt?: string;
  closesAt?: string;
  status?: EnrollmentPeriodStatus;
  allowsMidYearApplications?: boolean;
}

export interface CreateAdmissionStreamPayload {
  name: string;
  gradeLevel?: string | null;
  opensAt?: string;
  closesAt?: string;
  isActive?: boolean;
}

export interface CreateIntakeCapacityPayload {
  streamId?: string | null;
  gradeLevel: string;
  totalPlaces: number;
  reservedPlaces?: number;
}

export type ApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'WAITLISTED'
  | 'WITHDRAWN'
  | 'ENROLLED';

export type AdminTransitionTarget =
  | 'UNDER_REVIEW'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'WAITLISTED'
  | 'WITHDRAWN';

export type AdmissionType = 'NEW_STUDENT' | 'TRANSFER' | 'MID_YEAR_ADMISSION';

export type ApplicationNoteType =
  | 'INTERVIEW_NOTES'
  | 'ASSESSMENT_RESULT'
  | 'STAFF_OBSERVATION'
  | 'REFERENCE_CHECK'
  | 'VISIT_NOTES'
  | 'GENERAL';

export interface ScreeningResponseDto {
  questionKey: string;
  responseValue: unknown;
}

export interface ApplicationDocumentDto {
  id: string;
  documentType: string;
  s3Key: string;
  fileName: string | null;
  contentType: string | null;
  fileSizeBytes: number | null;
  uploadedAt: string;
}

export interface ApplicationNoteDto {
  id: string;
  noteType: ApplicationNoteType;
  noteText: string;
  isConfidential: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface ApplicationDto {
  id: string;
  schoolId: string;
  enrollmentPeriodId: string;
  enrollmentPeriodName: string;
  streamId: string | null;
  streamName: string | null;
  studentFirstName: string;
  studentLastName: string;
  studentDateOfBirth: string;
  applyingForGrade: string;
  guardianPersonId: string | null;
  guardianEmail: string;
  guardianPhone: string | null;
  admissionType: AdmissionType;
  status: ApplicationStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  screening: ScreeningResponseDto[];
  documents: ApplicationDocumentDto[];
  notes: ApplicationNoteDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateApplicationPayload {
  enrollmentPeriodId: string;
  streamId?: string | null;
  studentFirstName: string;
  studentLastName: string;
  studentDateOfBirth: string;
  applyingForGrade: string;
  guardianEmail: string;
  guardianPhone?: string;
  admissionType?: AdmissionType;
  screening?: { questionKey: string; responseValue: unknown }[];
}

export interface UpdateApplicationStatusPayload {
  status: AdminTransitionTarget;
  reviewNote?: string;
}

export interface CreateApplicationNotePayload {
  noteType?: ApplicationNoteType;
  noteText: string;
  isConfidential?: boolean;
}

export interface ListApplicationsArgs {
  enrollmentPeriodId?: string;
  status?: ApplicationStatus;
  applyingForGrade?: string;
}

export type OfferType = 'UNCONDITIONAL' | 'CONDITIONAL';

export type OfferStatus =
  | 'ISSUED'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'WITHDRAWN'
  | 'CONDITIONS_NOT_MET';

export type FamilyResponse = 'ACCEPTED' | 'DECLINED' | 'DEFERRED';

export interface OfferDto {
  id: string;
  schoolId: string;
  applicationId: string;
  studentFirstName: string;
  studentLastName: string;
  applyingForGrade: string;
  offerType: OfferType;
  offerConditions: string[] | null;
  conditionsMet: boolean | null;
  offerLetterS3Key: string | null;
  issuedAt: string;
  responseDeadline: string;
  familyResponse: FamilyResponse | null;
  familyRespondedAt: string | null;
  deferralTargetYearId: string | null;
  status: OfferStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOfferPayload {
  offerType?: OfferType;
  offerConditions?: string[];
  offerLetterS3Key?: string;
  responseDeadline: string;
}

export interface UpdateOfferConditionsMetPayload {
  conditionsMet: boolean;
}

export interface RespondToOfferPayload {
  familyResponse: FamilyResponse;
  deferralTargetYearId?: string;
}

export type WaitlistStatus = 'ACTIVE' | 'OFFERED' | 'ENROLLED' | 'EXPIRED' | 'WITHDRAWN';

export interface WaitlistEntryDto {
  id: string;
  schoolId: string;
  enrollmentPeriodId: string;
  applicationId: string;
  studentFirstName: string;
  studentLastName: string;
  gradeLevel: string;
  priorityScore: number;
  position: number;
  status: WaitlistStatus;
  addedAt: string;
  offeredAt: string | null;
}

export interface ListWaitlistArgs {
  enrollmentPeriodId?: string;
  gradeLevel?: string;
  status?: WaitlistStatus;
}

export interface OfferFromWaitlistPayload {
  responseDeadline: string;
}

// ── Cycle 6 — Payments / Billing ──────────────────────────

export type Recurrence = 'ONE_TIME' | 'MONTHLY' | 'QUARTERLY' | 'SEMESTER' | 'ANNUAL';

export interface FeeCategoryDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFeeCategoryPayload {
  name: string;
  description?: string;
}

export interface FeeScheduleDto {
  id: string;
  schoolId: string;
  academicYearId: string;
  academicYearName: string;
  feeCategoryId: string;
  feeCategoryName: string;
  name: string;
  description: string | null;
  gradeLevel: string | null;
  amount: number;
  isRecurring: boolean;
  recurrence: Recurrence;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFeeSchedulePayload {
  academicYearId: string;
  feeCategoryId: string;
  name: string;
  description?: string;
  gradeLevel?: string | null;
  amount: number;
  isRecurring?: boolean;
  recurrence?: Recurrence;
}

export interface UpdateFeeSchedulePayload {
  name?: string;
  description?: string;
  gradeLevel?: string | null;
  amount?: number;
  isRecurring?: boolean;
  recurrence?: Recurrence;
  isActive?: boolean;
}

export type FamilyAccountStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type PaymentAuthPolicy = 'ACCOUNT_HOLDER_ONLY' | 'ANY_AUTHORISED';

export interface FamilyAccountStudentDto {
  studentId: string;
  studentNumber: string;
  firstName: string;
  lastName: string;
  gradeLevel: string;
  addedAt: string;
}

export interface FamilyAccountDto {
  id: string;
  schoolId: string;
  schoolName: string | null;
  sharedBillingGroupId: string | null;
  accountHolderId: string;
  accountHolderName: string;
  accountHolderEmail: string | null;
  accountNumber: string;
  status: FamilyAccountStatus;
  paymentAuthorisationPolicy: PaymentAuthPolicy;
  balance: number;
  students: FamilyAccountStudentDto[];
  createdAt: string;
  updatedAt: string;
}

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'CANCELLED';

export interface InvoiceLineItemDto {
  id: string;
  invoiceId: string;
  feeScheduleId: string | null;
  feeScheduleName: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  sortOrder: number;
}

export interface InvoiceLineItemInputDto {
  feeScheduleId?: string;
  description: string;
  quantity?: number;
  unitPrice: number;
}

export interface InvoiceDto {
  id: string;
  schoolId: string;
  familyAccountId: string;
  familyAccountNumber: string;
  familyAccountHolderName: string;
  title: string;
  description: string | null;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  dueDate: string | null;
  status: InvoiceStatus;
  sentAt: string | null;
  notes: string | null;
  lineItems: InvoiceLineItemDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateInvoicePayload {
  familyAccountId: string;
  title: string;
  description?: string;
  dueDate?: string;
  lineItems: InvoiceLineItemInputDto[];
}

export interface GenerateFromSchedulePayload {
  feeScheduleId: string;
  title?: string;
  dueDate?: string;
}

export interface GenerateFromScheduleResponse {
  feeScheduleId: string;
  created: number;
  skipped: number;
  invoiceIds: string[];
}

export interface ListInvoicesArgs {
  familyAccountId?: string;
  status?: InvoiceStatus;
}

export type PaymentMethod = 'CARD' | 'BANK_TRANSFER' | 'CASH' | 'CHEQUE' | 'WAIVER';
export type PaymentStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED';

export interface PaymentDto {
  id: string;
  schoolId: string;
  invoiceId: string;
  invoiceTitle: string;
  familyAccountId: string;
  familyAccountNumber: string;
  amount: number;
  paymentMethod: PaymentMethod;
  stripePaymentIntentId: string | null;
  status: PaymentStatus;
  paidAt: string | null;
  receiptS3Key: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayInvoicePayload {
  amount: number;
  paymentMethod?: PaymentMethod;
  notes?: string;
}

export interface ListPaymentsArgs {
  familyAccountId?: string;
  invoiceId?: string;
  status?: PaymentStatus;
}

export type EntryType = 'CHARGE' | 'PAYMENT' | 'REFUND' | 'CREDIT' | 'ADJUSTMENT';

export interface LedgerEntryDto {
  id: string;
  familyAccountId: string;
  entryType: EntryType;
  amount: number;
  referenceId: string | null;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface LedgerBalanceDto {
  familyAccountId: string;
  balance: number;
  cached: boolean;
}

export interface ListLedgerArgs {
  limit?: number;
  before?: string;
  referenceId?: string;
}

export type RefundCategory =
  | 'OVERPAYMENT'
  | 'WITHDRAWAL'
  | 'PROGRAMME_CANCELLED'
  | 'ERROR_CORRECTION'
  | 'GOODWILL'
  | 'OTHER';
export type RefundStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface RefundDto {
  id: string;
  schoolId: string;
  paymentId: string;
  familyAccountId: string;
  amount: number;
  refundCategory: RefundCategory;
  reason: string;
  stripeRefundId: string | null;
  status: RefundStatus;
  authorisedBy: string;
  authorisedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRefundPayload {
  amount: number;
  refundCategory: RefundCategory;
  reason: string;
}

export interface ListRefundsArgs {
  familyAccountId?: string;
  paymentId?: string;
  status?: RefundStatus;
}

export type PlanFrequency = 'MONTHLY' | 'QUARTERLY';
export type PlanStatus = 'ACTIVE' | 'COMPLETED' | 'DEFAULTED' | 'CANCELLED';
export type InstallmentStatus = 'UPCOMING' | 'DUE' | 'PAID' | 'OVERDUE';

export interface PaymentPlanInstallmentDto {
  id: string;
  planId: string;
  installmentNumber: number;
  amount: number;
  dueDate: string;
  status: InstallmentStatus;
  paymentId: string | null;
  paidAt: string | null;
}

export interface PaymentPlanDto {
  id: string;
  schoolId: string;
  familyAccountId: string;
  invoiceId: string;
  totalAmount: number;
  installmentCount: number;
  frequency: PlanFrequency;
  startDate: string;
  status: PlanStatus;
  installments: PaymentPlanInstallmentDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreatePaymentPlanPayload {
  installmentCount: number;
  frequency: PlanFrequency;
  startDate: string;
}

// ── Profile & Household (Mini-Cycle) ────────────────────────

export type PhoneType = 'MOBILE' | 'HOME' | 'WORK';

// The 7 active values used by the Cycle 6.1 UI. Legacy values
// (LEGACY_MEMBER_ROLES below) survive in the database for backwards
// compat with the cross-school sibling-detection scaffolding.
export type HouseholdRole =
  | 'HEAD_OF_HOUSEHOLD'
  | 'SPOUSE'
  | 'CHILD'
  | 'GRANDPARENT'
  | 'OTHER_GUARDIAN'
  | 'SIBLING'
  | 'OTHER';

// Legacy MemberRole values that pre-date Cycle 6.1. The DB enum
// retains them; UI label maps must cover them so a leaked legacy row
// never renders as `undefined`. SIBLING + OTHER overlap with the
// active set and are not duplicated here.
export type LegacyHouseholdRole = 'PARENT' | 'GUARDIAN' | 'STUDENT';

export type AnyHouseholdRole = HouseholdRole | LegacyHouseholdRole;

export interface StudentDemographicsDto {
  gender: string | null;
  ethnicity: string | null;
  primaryLanguage: string | null;
  birthCountry: string | null;
  citizenship: string | null;
  medicalAlertNotes: string | null;
}

export interface GuardianEmploymentDto {
  employer: string | null;
  employerPhone: string | null;
  occupation: string | null;
  workAddress: string | null;
}

export interface EmergencyContactDto {
  id: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  source: 'STUDENT' | 'EMPLOYEE';
}

export interface HouseholdSummaryDto {
  id: string;
  name: string | null;
  role: HouseholdRole;
  isPrimaryContact: boolean;
}

export interface ProfileDto {
  personId: string;
  accountId: string | null;
  personType: string | null;
  firstName: string;
  lastName: string;
  middleName: string | null;
  preferredName: string | null;
  suffix: string | null;
  previousNames: string[];
  dateOfBirth: string | null;
  loginEmail: string | null;
  personalEmail: string | null;
  primaryPhone: string | null;
  phoneTypePrimary: PhoneType | null;
  secondaryPhone: string | null;
  phoneTypeSecondary: PhoneType | null;
  workPhone: string | null;
  preferredLanguage: string;
  notes: string | null;
  profileUpdatedAt: string | null;
  household: HouseholdSummaryDto | null;
  emergencyContact: EmergencyContactDto | null;
  demographics: StudentDemographicsDto | null;
  employment: GuardianEmploymentDto | null;
}

export interface UpdateEmergencyContactPayload {
  name: string;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  isPrimary?: boolean;
}

export interface UpdateProfilePayload {
  middleName?: string | null;
  preferredName?: string | null;
  suffix?: string | null;
  previousNames?: string[];
  primaryPhone?: string | null;
  phoneTypePrimary?: PhoneType | null;
  secondaryPhone?: string | null;
  phoneTypeSecondary?: PhoneType | null;
  workPhone?: string | null;
  personalEmail?: string | null;
  preferredLanguage?: string;
  notes?: string | null;
  employer?: string | null;
  employerPhone?: string | null;
  occupation?: string | null;
  workAddress?: string | null;
  primaryLanguage?: string | null;
  emergencyContact?: UpdateEmergencyContactPayload;
}

export interface UpdateAdminProfilePayload extends UpdateProfilePayload {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  ethnicity?: string | null;
  birthCountry?: string | null;
  citizenship?: string | null;
  medicalAlertNotes?: string | null;
}

export interface HouseholdMemberDto {
  id: string;
  personId: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  role: HouseholdRole;
  isPrimaryContact: boolean;
  joinedAt: string;
}

export interface HouseholdDto {
  id: string;
  name: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  homePhone: string | null;
  homeLanguage: string;
  mailingAddressSame: boolean;
  mailingLine1: string | null;
  mailingLine2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostalCode: string | null;
  mailingCountry: string | null;
  notes: string | null;
  members: HouseholdMemberDto[];
  canEdit: boolean;
}

export interface UpdateHouseholdPayload {
  name?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  homePhone?: string | null;
  homeLanguage?: string;
  mailingAddressSame?: boolean;
  mailingLine1?: string | null;
  mailingLine2?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingPostalCode?: string | null;
  mailingCountry?: string | null;
  notes?: string | null;
}

export interface AddHouseholdMemberPayload {
  personId: string;
  role: HouseholdRole;
  isPrimaryContact?: boolean;
}

export interface UpdateHouseholdMemberPayload {
  role?: HouseholdRole;
  isPrimaryContact?: boolean;
}

// ── Add Child / Child Link Requests ─────────────────────────────────

export type ChildLinkRequestType = 'LINK_EXISTING' | 'ADD_NEW';
export type ChildLinkRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ChildSearchResultDto {
  studentId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  gradeLevel: string | null;
  schoolName: string | null;
  studentNumber: string | null;
}

export interface ChildLinkRequestDto {
  id: string;
  schoolId: string;
  requestingGuardianId: string;
  requestingGuardianName: string | null;
  requestType: ChildLinkRequestType;
  existingStudentId: string | null;
  existingStudentName: string | null;
  newChildFirstName: string | null;
  newChildLastName: string | null;
  newChildDateOfBirth: string | null;
  newChildGender: string | null;
  newChildGradeLevel: string | null;
  status: ChildLinkRequestStatus;
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChildSearchArgs {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
}

export interface SubmitLinkExistingPayload {
  existingStudentId: string;
}

export interface SubmitAddNewChildPayload {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender?: string;
  gradeLevel: string;
}

export interface ReviewLinkRequestPayload {
  reviewerNotes?: string;
}

// ── Cycle 7 Tasks + Acknowledgements ─────────────────────────────────

export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type TaskCategory = 'ACADEMIC' | 'PERSONAL' | 'ADMINISTRATIVE' | 'ACKNOWLEDGEMENT';
export type TaskSource = 'MANUAL' | 'AUTO' | 'SYSTEM';

export interface TaskDto {
  id: string;
  schoolId: string;
  ownerId: string;
  ownerName: string | null;
  title: string;
  description: string | null;
  source: TaskSource;
  sourceRefId: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt: string | null;
  taskCategory: TaskCategory;
  acknowledgementId: string | null;
  createdForId: string | null;
  createdForName: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskPayload {
  title: string;
  description?: string;
  priority?: TaskPriority;
  taskCategory?: TaskCategory;
  dueAt?: string;
  assigneeAccountId?: string;
}

export interface UpdateTaskPayload {
  status?: TaskStatus;
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  dueAt?: string | null;
}

export interface ListTasksArgs {
  status?: TaskStatus;
  taskCategory?: TaskCategory;
  priority?: TaskPriority;
  dueAfter?: string;
  dueBefore?: string;
  includeCompleted?: boolean;
  limit?: number;
}

export type AcknowledgementStatus =
  | 'PENDING'
  | 'ACKNOWLEDGED'
  | 'ACKNOWLEDGED_WITH_DISPUTE'
  | 'EXPIRED';

export type AcknowledgementSourceType =
  | 'ANNOUNCEMENT'
  | 'DISCIPLINE_RECORD'
  | 'POLICY_DOCUMENT'
  | 'SIGNED_FORM'
  | 'CONSENT_REQUEST'
  | 'CUSTOM';

export interface AcknowledgementDto {
  id: string;
  schoolId: string;
  subjectId: string;
  sourceType: AcknowledgementSourceType;
  sourceRefId: string;
  sourceTable: string;
  title: string;
  bodyS3Key: string | null;
  requiresDisputeOption: boolean;
  status: AcknowledgementStatus;
  acknowledgedAt: string | null;
  disputeReason: string | null;
  createdBy: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DisputeAcknowledgementPayload {
  reason: string;
}

// ── Cycle 7 Approval Workflows ────────────────────────────────────

export type ApprovalRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'WITHDRAWN';

export type ApprovalStepStatus = 'AWAITING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';

export type ApproverType = 'SPECIFIC_USER' | 'ROLE' | 'MANAGER' | 'DEPARTMENT_HEAD';

export interface ApprovalStepDto {
  id: string;
  requestId: string;
  stepOrder: number;
  approverId: string;
  approverName: string | null;
  status: ApprovalStepStatus;
  actionedAt: string | null;
  comments: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalCommentDto {
  id: string;
  requestId: string;
  authorId: string;
  authorName: string | null;
  body: string;
  isRequesterVisible: boolean;
  createdAt: string;
}

export interface ApprovalRequestDto {
  id: string;
  schoolId: string;
  templateId: string;
  templateName: string;
  requesterId: string;
  requesterName: string | null;
  requestType: string;
  referenceId: string | null;
  referenceTable: string | null;
  status: ApprovalRequestStatus;
  submittedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  steps: ApprovalStepDto[];
  comments: ApprovalCommentDto[];
}

export interface SubmitApprovalPayload {
  requestType: string;
  referenceId?: string;
  referenceTable?: string;
  requesterAccountId?: string;
}

export interface ReviewStepPayload {
  comments?: string;
}

export interface CreateApprovalCommentPayload {
  body: string;
  isRequesterVisible?: boolean;
}

export interface ListApprovalsArgs {
  status?: ApprovalRequestStatus;
  requestType?: string;
  mine?: boolean;
}

export interface WorkflowTemplateStepDto {
  id: string;
  stepOrder: number;
  approverType: ApproverType;
  approverRef: string | null;
  isParallel: boolean;
  timeoutHours: number | null;
  escalationTargetId: string | null;
}

export interface WorkflowTemplateDto {
  id: string;
  schoolId: string;
  name: string;
  requestType: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowTemplateStepDto[];
}

// ── Cycle 8 — Service Tickets (M60) ─────────────────────────────

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type TicketStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'VENDOR_ASSIGNED'
  | 'PENDING_REQUESTER'
  | 'RESOLVED'
  | 'CLOSED'
  | 'CANCELLED';
export type VendorType =
  | 'IT_REPAIR'
  | 'FACILITIES_MAINTENANCE'
  | 'CLEANING'
  | 'ELECTRICAL'
  | 'PLUMBING'
  | 'HVAC'
  | 'SECURITY'
  | 'GROUNDS'
  | 'OTHER';
export type TicketActivityType =
  | 'STATUS_CHANGE'
  | 'REASSIGNMENT'
  | 'COMMENT'
  | 'ATTACHMENT'
  | 'ESCALATION'
  | 'VENDOR_ASSIGNMENT'
  | 'SLA_BREACH';
export type ProblemStatus = 'OPEN' | 'INVESTIGATING' | 'KNOWN_ERROR' | 'RESOLVED';

export interface TicketSubcategoryDto {
  id: string;
  categoryId: string;
  name: string;
  defaultAssigneeId: string | null;
  defaultAssigneeName: string | null;
  autoAssignToRole: string | null;
  isActive: boolean;
}

export interface TicketCategoryDto {
  id: string;
  schoolId: string;
  parentCategoryId: string | null;
  name: string;
  icon: string | null;
  isActive: boolean;
  subcategories: TicketSubcategoryDto[];
}

export interface TicketSlaPolicyDto {
  id: string;
  schoolId: string;
  categoryId: string;
  categoryName: string;
  priority: TicketPriority;
  responseHours: number;
  resolutionHours: number;
}

export interface TicketVendorDto {
  id: string;
  schoolId: string;
  vendorName: string;
  vendorType: VendorType;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  isPreferred: boolean;
  notes: string | null;
  isActive: boolean;
}

export interface TicketSlaSnapshotDto {
  policyId: string | null;
  responseHours: number | null;
  resolutionHours: number | null;
  responseBreached: boolean;
  resolutionBreached: boolean;
  responseHoursRemaining: number | null;
  resolutionHoursRemaining: number | null;
}

export interface TicketDto {
  id: string;
  schoolId: string;
  categoryId: string;
  categoryName: string;
  subcategoryId: string | null;
  subcategoryName: string | null;
  requesterId: string;
  requesterName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  vendorReference: string | null;
  vendorAssignedAt: string | null;
  title: string;
  description: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  slaPolicyId: string | null;
  locationId: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sla: TicketSlaSnapshotDto;
}

export interface TicketCommentDto {
  id: string;
  ticketId: string;
  authorId: string;
  authorName: string | null;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

export interface TicketActivityDto {
  id: string;
  ticketId: string;
  actorId: string | null;
  actorName: string | null;
  activityType: TicketActivityType;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateTicketPayload {
  categoryId: string;
  subcategoryId?: string;
  title: string;
  description?: string;
  priority?: TicketPriority;
  locationId?: string;
}

export interface AssignTicketPayload {
  assigneeEmployeeId: string;
}

export interface AssignVendorPayload {
  vendorId: string;
  vendorReference?: string;
}

export interface ResolveTicketPayload {
  resolution?: string;
}

export interface CancelTicketPayload {
  reason?: string;
}

export interface CreateTicketCommentPayload {
  body: string;
  isInternal?: boolean;
}

export interface ListTicketsArgs {
  status?: TicketStatus;
  priority?: TicketPriority;
  categoryId?: string;
  assigneeId?: string;
  vendorId?: string;
  createdAfter?: string;
  createdBefore?: string;
  includeTerminal?: boolean;
  limit?: number;
}

export interface CreateTicketCategoryPayload {
  name: string;
  parentCategoryId?: string;
  icon?: string;
}

export interface UpdateTicketCategoryPayload {
  name?: string;
  icon?: string | null;
  isActive?: boolean;
}

export interface CreateTicketSubcategoryPayload {
  categoryId: string;
  name: string;
  defaultAssigneeId?: string;
  autoAssignToRole?: string;
}

export interface UpdateTicketSubcategoryPayload {
  name?: string;
  defaultAssigneeId?: string | null;
  autoAssignToRole?: string | null;
  isActive?: boolean;
}

export interface CreateTicketVendorPayload {
  vendorName: string;
  vendorType: VendorType;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
  isPreferred?: boolean;
  notes?: string;
}

export interface UpdateTicketVendorPayload {
  vendorName?: string;
  vendorType?: VendorType;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  website?: string | null;
  isPreferred?: boolean;
  notes?: string | null;
  isActive?: boolean;
}

export interface UpsertTicketSlaPayload {
  categoryId: string;
  priority: TicketPriority;
  responseHours: number;
  resolutionHours: number;
}

export interface ProblemDto {
  id: string;
  schoolId: string;
  title: string;
  description: string;
  categoryId: string;
  categoryName: string;
  status: ProblemStatus;
  rootCause: string | null;
  resolution: string | null;
  workaround: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  createdBy: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ticketIds: string[];
}

export interface CreateProblemPayload {
  title: string;
  description: string;
  categoryId: string;
  assignedToId?: string;
  vendorId?: string;
  ticketIds?: string[];
}

export interface UpdateProblemPayload {
  title?: string;
  description?: string;
  status?: Exclude<ProblemStatus, 'RESOLVED'>;
  rootCause?: string | null;
  workaround?: string | null;
  assignedToId?: string | null;
  vendorId?: string | null;
}

export interface LinkProblemTicketsPayload {
  ticketIds: string[];
}

export interface ResolveProblemPayload {
  rootCause: string;
  resolution: string;
  workaround?: string;
}

export interface ResolveProblemResponse {
  problem: ProblemDto;
  ticketsFlipped: string[];
}

export interface ListProblemsArgs {
  status?: ProblemStatus;
  categoryId?: string;
  limit?: number;
}

// ─── Cycle 9: Behaviour & Discipline ──────────────────────────

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type IncidentStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED';

export interface DisciplineCategoryDto {
  id: string;
  schoolId: string;
  name: string;
  severity: Severity;
  description: string | null;
  isActive: boolean;
}

export interface DisciplineActionTypeDto {
  id: string;
  schoolId: string;
  name: string;
  requiresParentNotification: boolean;
  description: string | null;
  isActive: boolean;
}

export interface DisciplineActionDto {
  id: string;
  incidentId: string;
  actionTypeId: string;
  actionTypeName: string;
  requiresParentNotification: boolean;
  assignedById: string | null;
  assignedByName: string | null;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  parentNotified: boolean;
  parentNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DisciplineIncidentDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  studentGradeLevel: string | null;
  reportedById: string | null;
  reportedByName: string | null;
  categoryId: string;
  categoryName: string;
  severity: Severity;
  description: string;
  incidentDate: string;
  incidentTime: string | null;
  location: string | null;
  witnesses: string | null;
  status: IncidentStatus;
  resolvedById: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  /**
   * Internal admin notes. Populated for managers (admin / counsellor /
   * staff with beh-001:admin reach via everyFunction). Stripped to null
   * for parents and non-manager teachers per the Step 4 row-scope
   * contract.
   */
  adminNotes: string | null;
  actions: DisciplineActionDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateIncidentPayload {
  studentId: string;
  categoryId: string;
  description: string;
  incidentDate: string;
  incidentTime?: string;
  location?: string | null;
  witnesses?: string | null;
}

export interface ReviewIncidentPayload {
  adminNotes?: string;
}

export interface ResolveIncidentPayload {
  adminNotes?: string;
}

export interface CreateActionPayload {
  actionTypeId: string;
  startDate?: string;
  endDate?: string;
  notes?: string | null;
}

export interface UpdateActionPayload {
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
  parentNotified?: boolean;
}

export interface CreateDisciplineCategoryPayload {
  name: string;
  severity: Severity;
  description?: string | null;
}

export interface UpdateDisciplineCategoryPayload {
  name?: string;
  severity?: Severity;
  description?: string | null;
  isActive?: boolean;
}

export interface CreateDisciplineActionTypePayload {
  name: string;
  requiresParentNotification?: boolean;
  description?: string | null;
}

export interface UpdateDisciplineActionTypePayload {
  name?: string;
  requiresParentNotification?: boolean;
  description?: string | null;
  isActive?: boolean;
}

export interface ListIncidentsArgs {
  status?: IncidentStatus;
  severity?: Severity;
  categoryId?: string;
  studentId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

// ─── Cycle 9 Step 5: Behaviour Plans ──────────────────────────

export type BehaviorPlanType = 'BIP' | 'BSP' | 'SAFETY_PLAN';
export type BehaviorPlanStatus = 'DRAFT' | 'ACTIVE' | 'REVIEW' | 'EXPIRED';
export type GoalProgress = 'NOT_STARTED' | 'IN_PROGRESS' | 'MET' | 'NOT_MET';
export type FeedbackEffectiveness =
  | 'NOT_EFFECTIVE'
  | 'SOMEWHAT_EFFECTIVE'
  | 'EFFECTIVE'
  | 'VERY_EFFECTIVE';

export interface GoalDto {
  id: string;
  planId: string;
  goalText: string;
  baselineFrequency: string | null;
  targetFrequency: string | null;
  measurementMethod: string | null;
  progress: GoalProgress;
  lastAssessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BIPFeedbackDto {
  id: string;
  planId: string;
  teacherId: string | null;
  teacherName: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  requestedAt: string;
  submittedAt: string | null;
  strategiesObserved: string[] | null;
  overallEffectiveness: FeedbackEffectiveness | null;
  classroomObservations: string | null;
  recommendedAdjustments: string | null;
  /** Populated only on the /bip-feedback/pending response. */
  studentName: string | null;
  /** Populated only on the /bip-feedback/pending response. */
  planType: string | null;
}

export interface BehaviorPlanDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  studentGradeLevel: string | null;
  caseloadId: string | null;
  planType: BehaviorPlanType;
  status: BehaviorPlanStatus;
  createdById: string | null;
  createdByName: string | null;
  reviewDate: string;
  reviewMeetingId: string | null;
  targetBehaviors: string[];
  replacementBehaviors: string[];
  reinforcementStrategies: string[];
  planDocumentS3Key: string | null;
  sourceIncidentId: string | null;
  goals: GoalDto[];
  feedback: BIPFeedbackDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateBehaviorPlanPayload {
  studentId: string;
  planType: BehaviorPlanType;
  reviewDate: string;
  targetBehaviors: string[];
  replacementBehaviors?: string[];
  reinforcementStrategies?: string[];
  sourceIncidentId?: string;
  caseloadId?: string;
}

export interface UpdateBehaviorPlanPayload {
  reviewDate?: string;
  targetBehaviors?: string[];
  replacementBehaviors?: string[];
  reinforcementStrategies?: string[];
  status?: 'DRAFT' | 'REVIEW';
}

export interface CreateGoalPayload {
  goalText: string;
  baselineFrequency?: string | null;
  targetFrequency?: string | null;
  measurementMethod?: string | null;
}

export interface UpdateGoalPayload {
  goalText?: string;
  baselineFrequency?: string | null;
  targetFrequency?: string | null;
  measurementMethod?: string | null;
  progress?: GoalProgress;
}

export interface RequestFeedbackPayload {
  teacherId: string;
}

export interface SubmitFeedbackPayload {
  strategiesObserved?: string[];
  overallEffectiveness?: FeedbackEffectiveness;
  classroomObservations?: string | null;
  recommendedAdjustments?: string | null;
}

export interface ListBehaviorPlansArgs {
  studentId?: string;
  status?: BehaviorPlanStatus;
  planType?: BehaviorPlanType;
}

// ── Cycle 10 Health Records DTOs ──────────────────────────────

export type ConditionSeverity = 'MILD' | 'MODERATE' | 'SEVERE';
export type ImmunisationStatus = 'CURRENT' | 'OVERDUE' | 'WAIVED';
export type MedicationRoute = 'ORAL' | 'TOPICAL' | 'INHALER' | 'INJECTION' | 'OTHER';
export type MissedReason =
  | 'STUDENT_ABSENT'
  | 'STUDENT_REFUSED'
  | 'MEDICATION_UNAVAILABLE'
  | 'PARENT_CANCELLED'
  | 'OTHER';
export type IepPlanType = 'IEP' | '504';
export type IepPlanStatus = 'DRAFT' | 'ACTIVE' | 'REVIEW' | 'EXPIRED';
export type IepGoalStatus = 'ACTIVE' | 'MET' | 'NOT_MET' | 'DISCONTINUED';
export type IepDeliveryMethod = 'PULL_OUT' | 'PUSH_IN' | 'CONSULT';
export type IepAppliesTo = 'ALL_ASSESSMENTS' | 'ALL_ASSIGNMENTS' | 'SPECIFIC';
export type VisitedPersonType = 'STUDENT' | 'STAFF';
export type NurseVisitStatus = 'IN_PROGRESS' | 'COMPLETED';
export type ScreeningResult = 'PASS' | 'REFER' | 'RESCREEN' | 'ABSENT';
export type HealthAccessType =
  | 'VIEW_RECORD'
  | 'VIEW_CONDITIONS'
  | 'VIEW_IMMUNISATIONS'
  | 'VIEW_MEDICATIONS'
  | 'VIEW_VISITS'
  | 'VIEW_IEP'
  | 'VIEW_SCREENING'
  | 'VIEW_DIETARY'
  | 'EXPORT';

export interface AllergyEntryDto {
  allergen: string;
  severity: ConditionSeverity;
  reaction?: string | null;
  notes?: string | null;
}

export interface ConditionDto {
  id: string;
  healthRecordId: string;
  conditionName: string;
  diagnosisDate: string | null;
  isActive: boolean;
  severity: ConditionSeverity;
  managementPlan: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImmunisationDto {
  id: string;
  healthRecordId: string;
  vaccineName: string;
  administeredDate: string | null;
  dueDate: string | null;
  administeredBy: string | null;
  status: ImmunisationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface HealthRecordDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  bloodType: string | null;
  allergies: AllergyEntryDto[];
  emergencyMedicalNotes: string | null;
  physicianName: string | null;
  physicianPhone: string | null;
  conditions: ConditionDto[];
  immunisations: ImmunisationDto[];
  createdAt: string;
  updatedAt: string;
}

export interface ImmunisationComplianceRowDto {
  vaccineName: string;
  totalRows: number;
  currentCount: number;
  overdueCount: number;
  waivedCount: number;
}

export interface ScheduleSlotDto {
  id: string;
  medicationId: string;
  scheduledTime: string;
  dayOfWeek: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MedicationDto {
  id: string;
  healthRecordId: string;
  medicationName: string;
  dosage: string | null;
  frequency: string | null;
  route: MedicationRoute;
  prescribingPhysician: string | null;
  isSelfAdministered: boolean;
  isActive: boolean;
  schedule: ScheduleSlotDto[];
  createdAt: string;
  updatedAt: string;
}

export interface AdministrationDto {
  id: string;
  medicationId: string;
  scheduleEntryId: string | null;
  administeredById: string | null;
  administeredByName: string | null;
  administeredAt: string | null;
  doseGiven: string | null;
  notes: string | null;
  parentNotified: boolean;
  wasMissed: boolean;
  missedReason: MissedReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface MedicationDashboardRowDto {
  scheduleEntryId: string;
  medicationId: string;
  medicationName: string;
  dosage: string | null;
  route: MedicationRoute;
  isSelfAdministered: boolean;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  scheduledTime: string;
  status: 'ADMINISTERED' | 'MISSED' | 'PENDING';
  administrationId: string | null;
  administeredAt: string | null;
  missedReason: MissedReason | null;
}

export interface NurseVisitDto {
  id: string;
  schoolId: string;
  visitedPersonId: string;
  visitedPersonType: VisitedPersonType;
  visitedPersonName: string | null;
  nurseId: string | null;
  nurseName: string | null;
  visitDate: string;
  status: NurseVisitStatus;
  signedInAt: string;
  signedOutAt: string | null;
  reason: string | null;
  treatmentGiven: string | null;
  parentNotified: boolean;
  sentHome: boolean;
  sentHomeAt: string | null;
  followUpRequired: boolean;
  followUpNotes: string | null;
  followUpDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNurseVisitPayload {
  visitedPersonId: string;
  visitedPersonType?: VisitedPersonType;
  reason?: string | null;
}

export interface UpdateNurseVisitPayload {
  reason?: string | null;
  treatmentGiven?: string | null;
  parentNotified?: boolean;
  sentHome?: boolean;
  followUpRequired?: boolean;
  followUpNotes?: string | null;
  followUpDate?: string | null;
  signOut?: boolean;
}

export interface AdministerDosePayload {
  scheduleEntryId?: string | null;
  doseGiven?: string | null;
  notes?: string | null;
  parentNotified?: boolean;
}

export interface LogMissedDosePayload {
  scheduleEntryId?: string | null;
  missedReason: MissedReason;
  notes?: string | null;
}

export interface IepGoalProgressDto {
  id: string;
  goalId: string;
  recordedById: string | null;
  recordedByName: string | null;
  progressValue: string | null;
  observationNotes: string | null;
  recordedAt: string;
}

export interface IepGoalDto {
  id: string;
  iepPlanId: string;
  goalText: string;
  measurementCriteria: string | null;
  baseline: string | null;
  targetValue: string | null;
  currentValue: string | null;
  goalArea: string | null;
  status: IepGoalStatus;
  progress: IepGoalProgressDto[];
  createdAt: string;
  updatedAt: string;
}

export interface IepServiceDto {
  id: string;
  iepPlanId: string;
  serviceType: string;
  providerName: string | null;
  frequency: string | null;
  minutesPerSession: number | null;
  deliveryMethod: IepDeliveryMethod;
  createdAt: string;
  updatedAt: string;
}

export interface IepAccommodationDto {
  id: string;
  iepPlanId: string;
  accommodationType: string;
  description: string | null;
  appliesTo: IepAppliesTo;
  specificAssignmentTypes: string[] | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IepPlanDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  planType: IepPlanType;
  status: IepPlanStatus;
  startDate: string | null;
  reviewDate: string | null;
  endDate: string | null;
  caseManagerId: string | null;
  caseManagerName: string | null;
  goals: IepGoalDto[];
  services: IepServiceDto[];
  accommodations: IepAccommodationDto[];
  createdAt: string;
  updatedAt: string;
}

export interface ScreeningDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  screeningType: string;
  screeningDate: string;
  screenedById: string | null;
  screenedByName: string | null;
  result: ScreeningResult | null;
  resultNotes: string | null;
  followUpRequired: boolean;
  followUpCompleted: boolean;
  referralNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DietaryAllergenDto {
  allergen: string;
  severity: ConditionSeverity;
  reaction?: string | null;
}

export interface DietaryProfileDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  dietaryRestrictions: string[];
  allergens: DietaryAllergenDto[];
  specialMealInstructions: string | null;
  posAllergenAlert: boolean;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HealthAccessLogRowDto {
  id: string;
  schoolId: string;
  accessedById: string;
  accessedByName: string | null;
  accessedByEmail: string | null;
  studentId: string;
  studentName: string | null;
  accessType: HealthAccessType;
  ipAddress: string | null;
  accessedAt: string;
}

export interface ListNurseVisitsArgs {
  status?: NurseVisitStatus;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

// Cycle 10 Step 9 — IEP / Screening / Dietary write payloads.

export interface CreateIepPlanPayload {
  planType: IepPlanType;
  startDate?: string | null;
  reviewDate?: string | null;
  endDate?: string | null;
  caseManagerId?: string | null;
}

export interface UpdateIepPlanPayload {
  status?: IepPlanStatus;
  startDate?: string | null;
  reviewDate?: string | null;
  endDate?: string | null;
  caseManagerId?: string | null;
}

export interface CreateIepGoalPayload {
  goalText: string;
  measurementCriteria?: string | null;
  baseline?: string | null;
  targetValue?: string | null;
  currentValue?: string | null;
  goalArea?: string | null;
}

export interface UpdateIepGoalPayload {
  goalText?: string;
  measurementCriteria?: string | null;
  baseline?: string | null;
  targetValue?: string | null;
  currentValue?: string | null;
  goalArea?: string | null;
  status?: IepGoalStatus;
}

export interface CreateGoalProgressPayload {
  progressValue?: string | null;
  observationNotes?: string | null;
}

export interface CreateIepServicePayload {
  serviceType: string;
  providerName?: string | null;
  frequency?: string | null;
  minutesPerSession?: number | null;
  deliveryMethod: IepDeliveryMethod;
}

export interface UpdateIepServicePayload {
  serviceType?: string;
  providerName?: string | null;
  frequency?: string | null;
  minutesPerSession?: number | null;
  deliveryMethod?: IepDeliveryMethod;
}

export interface CreateAccommodationPayload {
  accommodationType: string;
  description?: string | null;
  appliesTo: IepAppliesTo;
  specificAssignmentTypes?: string[] | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface UpdateAccommodationPayload {
  accommodationType?: string;
  description?: string | null;
  appliesTo?: IepAppliesTo;
  specificAssignmentTypes?: string[] | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface ListScreeningsArgs {
  studentId?: string;
  screeningType?: string;
  result?: ScreeningResult;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

export interface CreateScreeningPayload {
  studentId: string;
  screeningType: string;
  screeningDate: string;
  result?: ScreeningResult | null;
  resultNotes?: string | null;
  followUpRequired?: boolean;
  referralNotes?: string | null;
}

export interface UpdateScreeningPayload {
  result?: ScreeningResult | null;
  resultNotes?: string | null;
  followUpRequired?: boolean;
  followUpCompleted?: boolean;
  referralNotes?: string | null;
}

export interface CreateDietaryProfilePayload {
  dietaryRestrictions?: string[];
  allergens?: DietaryAllergenDto[];
  specialMealInstructions?: string | null;
  posAllergenAlert?: boolean;
}

export interface UpdateDietaryProfilePayload {
  dietaryRestrictions?: string[];
  allergens?: DietaryAllergenDto[];
  specialMealInstructions?: string | null;
  posAllergenAlert?: boolean;
}

// ─── Cycle 11 — Counselling & Student Support ─────────────────

export type PrimaryConcern =
  | 'ACADEMIC'
  | 'BEHAVIORAL'
  | 'SOCIAL_EMOTIONAL'
  | 'ATTENDANCE'
  | 'CRISIS'
  | 'TRANSITION'
  | 'GENERAL';

export type CaseloadStatus = 'ACTIVE' | 'CLOSED' | 'TRANSFERRED';

export type ReferralPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export type ReferralStatus =
  | 'SUBMITTED'
  | 'TRIAGED'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'DECLINED'
  | 'CANCELLED';

export type ReferralActivityType =
  | 'STATUS_CHANGE'
  | 'ASSIGNMENT_CHANGE'
  | 'NOTE_ADDED'
  | 'PARENT_NOTIFIED'
  | 'ESCALATED'
  | 'EXTERNAL_CONTACT_MADE';

export type SessionType =
  | 'INDIVIDUAL'
  | 'GROUP'
  | 'CRISIS'
  | 'CHECK_IN'
  | 'PARENT_MEETING'
  | 'CONSULTATION';

export type SessionStatus = 'SCHEDULED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';

export type SessionAttendanceStatus = 'ATTENDED' | 'NO_SHOW' | 'LATE';

export interface CaseloadDto {
  id: string;
  schoolId: string;
  counselorId: string;
  counselorName: string | null;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  studentGradeLevel: string | null;
  academicYearId: string;
  academicYearName: string | null;
  primaryConcern: PrimaryConcern;
  isPrimaryCounselor: boolean;
  status: CaseloadStatus;
  openedAt: string;
  closedAt: string | null;
  closureReason: string | null;
  notes: string | null;
  // Inlined for getById only
  sessionCount?: number | null;
  lastSessionDate?: string | null;
  linkedBipId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCaseloadPayload {
  counselorId: string;
  studentId: string;
  academicYearId: string;
  primaryConcern: PrimaryConcern;
  isPrimaryCounselor?: boolean;
  openedAt: string;
  notes?: string | null;
  fromReferralId?: string;
}

export interface UpdateCaseloadPayload {
  primaryConcern?: PrimaryConcern;
  notes?: string | null;
}

export interface CloseCaseloadPayload {
  closureReason: string;
}

export interface ReferralTypeDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  defaultPriority: ReferralPriority;
  requiresParentNotification: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReferralTypePayload {
  name: string;
  description?: string | null;
  defaultPriority: ReferralPriority;
  requiresParentNotification?: boolean;
  isActive?: boolean;
}

export interface UpdateReferralTypePayload {
  name?: string;
  description?: string | null;
  defaultPriority?: ReferralPriority;
  requiresParentNotification?: boolean;
  isActive?: boolean;
}

export interface ReferralActivityDto {
  id: string;
  referralId: string;
  actorId: string;
  actorName: string | null;
  activityType: ReferralActivityType;
  notes: string | null;
  createdAt: string;
}

export interface ReferralDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  studentGradeLevel: string | null;
  referredById: string;
  referredByName: string | null;
  referralTypeId: string;
  referralTypeName: string | null;
  requiresParentNotification: boolean;
  assignedCounselorId: string | null;
  assignedCounselorName: string | null;
  priority: ReferralPriority;
  status: ReferralStatus;
  reason: string;
  parentNotified: boolean;
  parentNotifiedAt: string | null;
  outcome: string | null;
  createdAt: string;
  updatedAt: string;
  activity?: ReferralActivityDto[];
}

export interface CreateReferralPayload {
  studentId: string;
  referralTypeId: string;
  reason: string;
  priority?: ReferralPriority;
}

export interface TriageReferralPayload {
  assignedCounselorId: string;
  notes?: string | null;
}

export interface AcceptReferralPayload {
  openCaseload?: boolean;
  caseloadConcern?: PrimaryConcern;
  academicYearId?: string;
  notes?: string | null;
}

export interface CompleteReferralPayload {
  outcome: string;
}

export interface DeclineReferralPayload {
  reason: string;
}

export interface SessionParticipantDto {
  id: string;
  sessionId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  caseloadId: string | null;
  attendanceStatus: SessionAttendanceStatus;
  notes: string | null;
}

export interface SessionDto {
  id: string;
  schoolId: string;
  counselorId: string;
  counselorName: string | null;
  sessionDate: string;
  durationMinutes: number | null;
  sessionType: SessionType;
  primaryCaseloadId: string | null;
  primaryStudentId: string | null;
  primaryStudentName: string | null;
  referralId: string | null;
  status: SessionStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  participants?: SessionParticipantDto[];
}

export interface CreateSessionPayload {
  counselorId: string;
  sessionDate: string;
  durationMinutes?: number;
  sessionType: SessionType;
  primaryCaseloadId?: string | null;
  referralId?: string | null;
  status?: SessionStatus;
  notes?: string | null;
}

export interface UpdateSessionPayload {
  status?: SessionStatus;
  durationMinutes?: number;
  sessionType?: SessionType;
  notes?: string | null;
}

export interface AddParticipantPayload {
  studentId: string;
  caseloadId?: string | null;
  attendanceStatus?: SessionAttendanceStatus;
  notes?: string | null;
}

export interface MarkAttendancePayload {
  attendanceStatus: SessionAttendanceStatus;
  notes?: string | null;
}

export interface SessionNoteDto {
  id: string;
  sessionId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  notesText: string;
  goalsAddressed: string[] | null;
  followUpRequired: boolean;
  followUpNotes: string | null;
  isLocked: boolean;
  lockedAt: string | null;
  lockedById: string | null;
  lockedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionNotePayload {
  studentId: string;
  notesText: string;
  goalsAddressed?: string[];
  followUpRequired?: boolean;
  followUpNotes?: string | null;
}

export interface UpdateSessionNotePayload {
  notesText?: string;
  goalsAddressed?: string[];
  followUpRequired?: boolean;
  followUpNotes?: string | null;
}

// ─── Cycle 11 Step 7 — MTSS / Care / Reporting ────────────────

export type MtssTier = 'TIER_1' | 'TIER_2' | 'TIER_3';

export type MtssDomain = 'ACADEMIC' | 'BEHAVIORAL' | 'SOCIAL_EMOTIONAL' | 'ATTENDANCE';

export type MtssTierStatus = 'ACTIVE' | 'EXITED' | 'PROMOTED' | 'DEMOTED';

export type InterventionType =
  | 'ACADEMIC_SUPPORT'
  | 'BEHAVIORAL_SUPPORT'
  | 'SOCIAL_EMOTIONAL_LEARNING'
  | 'ATTENDANCE_SUPPORT'
  | 'COUNSELING'
  | 'EXTERNAL_SERVICE';

export type InterventionStatus = 'ACTIVE' | 'COMPLETED' | 'DISCONTINUED';

export type MeetingOutcome =
  | 'NO_CHANGE'
  | 'TIER_UP'
  | 'TIER_DOWN'
  | 'EXIT'
  | 'CONTINUE_WITH_ADJUSTMENT';

export type CareAuthorRole = 'NURSE' | 'COUNSELLOR';

export type ReportType = 'SUSPECTED_ABUSE' | 'SUSPECTED_NEGLECT' | 'IMMINENT_DANGER' | 'OTHER';

export type ReportStatus = 'FILED' | 'CPS_CONTACTED' | 'INVESTIGATION_ACTIVE' | 'CLOSED';

// MTSS Tier

export interface MtssTierDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  academicYearId: string;
  academicYearName: string | null;
  tier: MtssTier;
  domain: MtssDomain;
  assignedById: string;
  assignedByName: string | null;
  assignedAt: string;
  reviewDate: string;
  exitDate: string | null;
  exitReason: string | null;
  status: MtssTierStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMtssTierPayload {
  studentId: string;
  academicYearId: string;
  tier: MtssTier;
  domain: MtssDomain;
  assignedAt: string;
  reviewDate: string;
  notes?: string | null;
}

export interface UpdateMtssTierPayload {
  tier?: MtssTier;
  status?: MtssTierStatus;
  reviewDate?: string;
  exitDate?: string;
  exitReason?: string | null;
  notes?: string | null;
}

export interface MtssDashboardCellDto {
  tier: MtssTier;
  domain: MtssDomain;
  count: number;
}

export interface MtssDashboardDto {
  cells: MtssDashboardCellDto[];
  totalActive: number;
}

// Intervention + progress

export interface InterventionProgressEntryDto {
  id: string;
  interventionId: string;
  recordedById: string;
  recordedByName: string | null;
  recordedDate: string;
  measureType: string;
  score: number | null;
  benchmark: number | null;
  notes: string | null;
  createdAt: string;
}

export interface InterventionDto {
  id: string;
  tierId: string;
  interventionName: string;
  interventionType: InterventionType;
  description: string | null;
  frequency: string | null;
  startDate: string;
  endDate: string | null;
  providerId: string | null;
  providerName: string | null;
  status: InterventionStatus;
  latestProgress?: InterventionProgressEntryDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInterventionPayload {
  interventionName: string;
  interventionType: InterventionType;
  description?: string | null;
  frequency?: string | null;
  startDate: string;
  endDate?: string;
  providerId?: string | null;
}

export interface UpdateInterventionPayload {
  status?: InterventionStatus;
  frequency?: string | null;
  endDate?: string;
  description?: string | null;
}

export interface LogProgressPayload {
  recordedDate: string;
  measureType: string;
  score?: number;
  benchmark?: number;
  notes?: string | null;
}

// Team meetings

export interface TeamMeetingStudentDto {
  id: string;
  teamMeetingId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  tierId: string | null;
  outcome: MeetingOutcome | null;
  outcomeNotes: string | null;
}

export interface TeamMeetingDto {
  id: string;
  schoolId: string;
  meetingId: string | null;
  academicYearId: string;
  facilitatedById: string;
  facilitatedByName: string | null;
  meetingDate: string;
  notes: string | null;
  students?: TeamMeetingStudentDto[];
  createdAt: string;
}

export interface CreateTeamMeetingPayload {
  academicYearId: string;
  meetingDate: string;
  notes?: string | null;
}

export interface AttachTeamMeetingStudentPayload {
  studentId: string;
  tierId?: string | null;
  outcome?: MeetingOutcome | null;
  outcomeNotes?: string | null;
}

// Coordinated care

export interface CoordinatedCareNoteDto {
  id: string;
  studentId: string;
  authorPersonId: string;
  authorName: string | null;
  authorRole: CareAuthorRole;
  noteText: string;
  createdAt: string;
}

export interface CreateCoordinatedCareNotePayload {
  authorRole: CareAuthorRole;
  noteText: string;
}

// Mandatory reports

export interface MandatoryReportDto {
  id: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  reporterPersonId: string;
  reporterName: string | null;
  reportType: ReportType;
  reportedToAuthority: string;
  reportDate: string;
  description: string;
  supportingDocsS3Keys: string[] | null;
  cpsResponse: string | null;
  status: ReportStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMandatoryReportPayload {
  studentId: string;
  reportType: ReportType;
  reportedToAuthority: string;
  reportDate: string;
  description: string;
  supportingDocsS3Keys?: string[];
}

export interface UpdateMandatoryReportPayload {
  status?: ReportStatus;
  cpsResponse?: string | null;
}

// ─── Cycle 11.1 Wellbeing ──────────────────────────────────────

export type FrequencyRecommendation = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'AS_NEEDED';

export type WellbeingQuestionType =
  | 'SCALE_1_5'
  | 'SCALE_1_10'
  | 'YES_NO'
  | 'FREE_TEXT'
  | 'EMOJI_SCALE';

export type WellbeingDomain = 'ACADEMIC' | 'SOCIAL' | 'EMOTIONAL' | 'PHYSICAL' | 'SAFETY';

export type DeploymentTargetType = 'CASELOAD' | 'CLASS' | 'YEAR_GROUP' | 'SCHOOL' | 'CUSTOM_LIST';

export type DeploymentStatus = 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export type WellbeingAlertType =
  | 'FEELS_UNSAFE'
  | 'WANTS_TO_TALK'
  | 'SIGNIFICANT_SCORE_DROP'
  | 'PERSISTENT_LOW_SCORE'
  | 'SELF_HARM_INDICATOR';

export type WellbeingAlertStatus = 'NEW' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLVED';

export interface WellbeingQuestionDto {
  id: string;
  templateId: string;
  questionText: string;
  questionType: WellbeingQuestionType;
  domain: WellbeingDomain;
  sortOrder: number;
}

export interface WellbeingTemplateDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  frequencyRecommendation: FrequencyRecommendation;
  isActive: boolean;
  createdById: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  questions?: WellbeingQuestionDto[];
}

export interface CreateWellbeingQuestionInputDto {
  questionText: string;
  questionType: WellbeingQuestionType;
  domain: WellbeingDomain;
  sortOrder: number;
}

export interface CreateWellbeingTemplatePayload {
  name: string;
  description?: string;
  frequencyRecommendation: FrequencyRecommendation;
  questions: CreateWellbeingQuestionInputDto[];
}

export interface UpdateWellbeingTemplatePayload {
  name?: string;
  description?: string;
  frequencyRecommendation?: FrequencyRecommendation;
  isActive?: boolean;
}

export interface UpdateWellbeingQuestionPayload {
  questionText?: string;
  questionType?: WellbeingQuestionType;
  domain?: WellbeingDomain;
  sortOrder?: number;
}

export interface WellbeingDeploymentDto {
  id: string;
  schoolId: string;
  templateId: string;
  templateName: string | null;
  deployedById: string;
  deployedByName: string | null;
  deployAt: string;
  expiresAt: string | null;
  targetType: DeploymentTargetType;
  targetIds: string[] | null;
  status: DeploymentStatus;
  totalTargeted: number | null;
  totalCompleted: number | null;
  completionRate: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWellbeingDeploymentPayload {
  templateId: string;
  deployAt: string;
  expiresAt?: string;
  targetType: DeploymentTargetType;
  targetIds?: string[];
}

export interface ActivateWellbeingDeploymentResponse {
  deployment: WellbeingDeploymentDto;
  checkinsCreated: number;
}

export interface WellbeingResponseDto {
  id: string;
  checkinId: string;
  questionId: string;
  numericResponse: number | null;
  textResponse: string | null;
  createdAt: string;
}

export interface WellbeingCheckinDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  templateId: string;
  templateName: string | null;
  deploymentId: string | null;
  completedAt: string | null;
  flaggedForFollowUp: boolean;
  assignedCounselorId: string | null;
  assignedCounselorName: string | null;
  createdAt: string;
  updatedAt: string;
  responses?: WellbeingResponseDto[];
}

export interface SubmitWellbeingCheckinResponseInput {
  questionId: string;
  numericResponse?: number;
  textResponse?: string;
}

export interface SubmitWellbeingCheckinPayload {
  responses: SubmitWellbeingCheckinResponseInput[];
}

export interface WellbeingAlertDto {
  id: string;
  studentId: string;
  studentName: string | null;
  responseId: string;
  checkinId: string | null;
  questionId: string | null;
  questionText: string | null;
  responsePreview: string | null;
  alertType: WellbeingAlertType;
  status: WellbeingAlertStatus;
  acknowledgedById: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResolveWellbeingAlertPayload {
  resolutionNotes: string;
}

// ─── Cycle 12 Library DTOs ────────────────────────────────────

export type LibraryLocationType =
  | 'SHELF'
  | 'DISPLAY'
  | 'BOOK_DROP'
  | 'PROCESSING'
  | 'REPAIR'
  | 'STORAGE';

export type LibraryCopyCondition = 'NEW' | 'GOOD' | 'FAIR' | 'POOR' | 'LOST';

export type LibraryCopyLocationStatus =
  | 'ON_SHELF'
  | 'IN_BOOK_DROP'
  | 'IN_PROCESSING'
  | 'CHECKED_OUT'
  | 'ON_HOLD_SHELF'
  | 'IN_REPAIR'
  | 'LOST';

export type LibraryPatronType = 'STUDENT' | 'STAFF';

export type LibraryCheckoutStatus = 'ACTIVE' | 'RETURNED' | 'OVERDUE' | 'LOST';

export type LibraryHoldStatus = 'PENDING' | 'READY' | 'COLLECTED' | 'EXPIRED' | 'CANCELLED';

export type LibraryFineType = 'OVERDUE' | 'LOST' | 'DAMAGE';

export type LibraryFineStatus = 'OUTSTANDING' | 'PAID' | 'WAIVED';

export type ReadingProgrammeAudienceType = 'SCHOOL_WIDE' | 'YEAR_GROUP' | 'CLASS' | 'CUSTOM';

export type ReadingListType =
  | 'CLASS'
  | 'YEAR_GROUP'
  | 'CURRICULUM_UNIT'
  | 'GENERAL'
  | 'NEW_ARRIVALS';

export type ReadingListItemType = 'REQUIRED' | 'RECOMMENDED' | 'EXTENSION' | 'REFERENCE';

export interface LibraryLocationDto {
  id: string;
  schoolId: string;
  name: string;
  locationType: LibraryLocationType;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLibraryLocationPayload {
  name: string;
  locationType: LibraryLocationType;
  sortOrder?: number;
}

export interface UpdateLibraryLocationPayload {
  name?: string;
  locationType?: LibraryLocationType;
  sortOrder?: number;
  isActive?: boolean;
}

export interface LibraryCopyDto {
  id: string;
  catalogueItemId: string;
  locationId: string | null;
  locationName: string | null;
  barcode: string;
  condition: LibraryCopyCondition;
  isAvailable: boolean;
  replacementValue: number | null;
  locationStatus: LibraryCopyLocationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLibraryCopyPayload {
  barcode: string;
  condition?: LibraryCopyCondition;
  locationId?: string;
  locationStatus?: LibraryCopyLocationStatus;
  replacementValue?: number;
}

export interface UpdateLibraryCopyPayload {
  condition?: LibraryCopyCondition;
  locationId?: string | null;
  locationStatus?: LibraryCopyLocationStatus;
  isAvailable?: boolean;
  replacementValue?: number;
}

export interface LibraryCatalogueItemSearchHitDto {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  category: string | null;
  deweyDecimal: string | null;
  coverImageUrl: string | null;
  totalCopies: number;
  availableCopies: number;
  averageRating: number | null;
  reviewCount: number;
}

export interface LibraryCatalogueItemDto {
  id: string;
  schoolId: string;
  title: string;
  author: string | null;
  isbn: string | null;
  publisher: string | null;
  publishYear: number | null;
  category: string | null;
  deweyDecimal: string | null;
  description: string | null;
  coverImageUrl: string | null;
  totalCopies: number;
  availableCopies: number;
  activeHoldsCount: number;
  averageRating: number | null;
  reviewCount: number;
  copies?: LibraryCopyDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateLibraryCatalogueItemPayload {
  title: string;
  author?: string;
  isbn?: string;
  publisher?: string;
  publishYear?: number;
  category?: string;
  deweyDecimal?: string;
  description?: string;
  coverImageUrl?: string;
}

export interface UpdateLibraryCatalogueItemPayload extends Partial<CreateLibraryCatalogueItemPayload> {}

export interface LibraryActiveCheckoutDto {
  checkoutId: string;
  patronId: string;
  patronName: string | null;
  checkoutDate: string;
  dueDate: string;
  daysUntilDue: number;
  status: string;
  renewalCount: number;
}

export interface LibraryBarcodeLookupDto {
  copy: LibraryCopyDto;
  item: LibraryCatalogueItemDto;
  activeCheckout: LibraryActiveCheckoutDto | null;
  pendingHoldsCount: number;
}

export interface LibraryCheckoutPolicyDto {
  id: string;
  schoolId: string;
  patronType: LibraryPatronType;
  maxCheckouts: number;
  loanPeriodDays: number;
  renewalsAllowed: number;
  overdueFinePerDay: number;
}

export interface LibraryCheckoutDto {
  id: string;
  copyId: string;
  copyBarcode: string;
  itemTitle: string | null;
  patronId: string;
  patronName: string | null;
  checkoutDate: string;
  dueDate: string;
  returnedAt: string | null;
  renewalCount: number;
  status: LibraryCheckoutStatus;
  daysUntilDue: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLibraryCheckoutPayload {
  barcode?: string;
  copyId?: string;
  patronId: string;
  loanPeriodDays?: number;
}

export interface LibraryHoldDto {
  id: string;
  catalogueItemId: string;
  itemTitle: string | null;
  patronId: string;
  patronName: string | null;
  placedAt: string;
  expiresAt: string | null;
  status: LibraryHoldStatus;
  notifiedAt: string | null;
  queuePosition: number | null;
}

export interface CreateLibraryHoldPayload {
  catalogueItemId: string;
  patronId?: string;
}

export interface LibraryFineDto {
  id: string;
  checkoutId: string;
  itemTitle: string | null;
  patronId: string;
  patronName: string | null;
  fineType: LibraryFineType;
  amount: number;
  daysOverdue: number | null;
  status: LibraryFineStatus;
  invoiceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WaiveLibraryFinePayload {
  reason: string;
}

export interface ReadingProgrammeProgressDto {
  programmeId: string;
  studentId: string;
  booksRead: number;
  pagesRead: number;
  isComplete: boolean;
  lastUpdatedAt: string | null;
}

export interface ReadingProgrammeDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  academicYearId: string | null;
  targetBooks: number | null;
  targetPages: number | null;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  targetAudienceType: ReadingProgrammeAudienceType;
  targetId: string | null;
  myProgress?: ReadingProgrammeProgressDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReadingProgrammePayload {
  name: string;
  description?: string;
  academicYearId?: string;
  targetBooks?: number;
  targetPages?: number;
  startDate?: string;
  endDate?: string;
  targetAudienceType: ReadingProgrammeAudienceType;
  targetId?: string;
}

export interface UpdateReadingProgrammePayload {
  name?: string;
  description?: string;
  targetBooks?: number;
  targetPages?: number;
  startDate?: string;
  endDate?: string;
  isActive?: boolean;
}

export interface ReadingProgrammeLeaderboardEntryDto {
  studentId: string;
  studentName: string | null;
  booksRead: number;
  pagesRead: number;
  isComplete: boolean;
}

export interface ReadingLogDto {
  id: string;
  studentId: string;
  studentName: string | null;
  catalogueItemId: string;
  itemTitle: string | null;
  itemAuthor: string | null;
  startedDate: string | null;
  completedDate: string | null;
  pagesRead: number | null;
  rating: number | null;
  reviewText: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReadingLogPayload {
  catalogueItemId: string;
  startedDate?: string;
  completedDate?: string;
  pagesRead?: number;
  rating?: number;
  reviewText?: string;
}

export interface UpdateReadingLogPayload {
  startedDate?: string;
  completedDate?: string;
  pagesRead?: number;
  rating?: number;
  reviewText?: string;
}

export interface ReadingListItemDto {
  id: string;
  readingListId: string;
  catalogueItemId: string;
  itemTitle: string | null;
  itemAuthor: string | null;
  itemCoverImageUrl: string | null;
  itemType: ReadingListItemType;
  sortOrder: number;
  notes: string | null;
  addedById: string;
  addedByName: string | null;
  createdAt: string;
}

export interface ReadingListDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  listType: ReadingListType;
  createdById: string;
  createdByName: string | null;
  targetClassId: string | null;
  academicYearId: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  itemCount: number;
  items?: ReadingListItemDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateReadingListPayload {
  name: string;
  description?: string;
  listType: ReadingListType;
  targetClassId?: string;
  academicYearId?: string;
}

export interface UpdateReadingListPayload {
  name?: string;
  description?: string;
  listType?: ReadingListType;
  targetClassId?: string;
  isPublished?: boolean;
}

export interface CreateReadingListItemPayload {
  catalogueItemId: string;
  itemType?: ReadingListItemType;
  sortOrder?: number;
  notes?: string;
}

export interface UpdateReadingListItemPayload {
  itemType?: ReadingListItemType;
  sortOrder?: number;
  notes?: string;
}

export interface LibraryReviewDto {
  id: string;
  itemId: string;
  studentId: string;
  studentName: string | null;
  rating: number;
  reviewText: string | null;
  isApproved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLibraryReviewPayload {
  rating: number;
  reviewText?: string;
}

export interface UpdateLibraryReviewPayload {
  rating?: number;
  reviewText?: string;
}

// ── Cycle 13 — Athletics ───────────────────────────────────────

export type AthleticsProgrammeSeason = 'FALL' | 'WINTER' | 'SPRING' | 'YEAR_ROUND';
export type AthleticsRosterLevel = 'VARSITY' | 'JV' | 'FRESHMAN' | 'CLUB';
export type AthleticsSeasonStatus = 'UPCOMING' | 'ACTIVE' | 'POSTSEASON' | 'COMPLETED';
export type AthleticsEligibilityStatus =
  | 'ELIGIBLE'
  | 'INELIGIBLE'
  | 'PENDING_PHYSICAL'
  | 'PENDING_CONSENT'
  | 'PENDING_TRANSFER_WAIVER'
  | 'INJURED_NOT_CLEARED';
export type AthleticsGameStatus =
  | 'SCHEDULED'
  | 'CONFIRMED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'POSTPONED'
  | 'CANCELLED';
export type AthleticsGameLocation = 'HOME' | 'AWAY' | 'NEUTRAL';
export type AthleticsGameOutcome = 'WIN' | 'LOSS' | 'DRAW' | 'FORFEIT';
export type AthleticsCoachingRole =
  | 'HEAD_COACH'
  | 'ASSISTANT_COACH'
  | 'VOLUNTEER_COACH'
  | 'SPECIALIST';
export type AthleticsInjurySeverity = 'MINOR' | 'MODERATE' | 'SEVERE' | 'EMERGENCY';
export type AthleticsReturnToPlayStatus =
  | 'ACTIVE'
  | 'SIDELINED'
  | 'CONCUSSION_PROTOCOL'
  | 'CLEARED';
export type AthleticsClearanceReviewStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'NOT_SUBMITTED'
  | 'EXPIRED';

export interface AthleticsProgrammeDto {
  id: string;
  schoolId: string;
  sportName: string;
  season: AthleticsProgrammeSeason;
  levelsOffered: AthleticsRosterLevel[];
  maxRosterSizePerLevel: Record<string, number> | null;
  minGpa: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAthleticsProgrammePayload {
  sportName: string;
  season: AthleticsProgrammeSeason;
  levelsOffered: AthleticsRosterLevel[];
  maxRosterSizePerLevel?: Record<string, number>;
  minGpa?: number;
  isActive?: boolean;
}

export interface AthleticsSeasonDto {
  id: string;
  programmeId: string;
  programmeName?: string;
  academicYear: string;
  firstPracticeDate: string | null;
  firstGameDate: string | null;
  lastGameDate: string | null;
  playoffCutoffDate: string | null;
  status: AthleticsSeasonStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAthleticsSeasonPayload {
  academicYear: string;
  firstPracticeDate?: string;
  firstGameDate?: string;
  lastGameDate?: string;
  playoffCutoffDate?: string;
  status?: AthleticsSeasonStatus;
}

export interface AthleticsRosterDto {
  id: string;
  seasonId: string;
  level: AthleticsRosterLevel;
  headCoachId: string | null;
  headCoachName: string | null;
  isCertified: boolean;
  certifiedAt: string | null;
  certifiedBy: string | null;
  certifiedByName: string | null;
  memberCount?: number;
  eligibleCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAthleticsRosterPayload {
  level: AthleticsRosterLevel;
  headCoachId?: string;
}

export interface AthleticsRosterMemberDto {
  id: string;
  rosterId: string;
  studentId: string;
  studentName: string;
  studentGradeLevel: string | null;
  jerseyNumber: string | null;
  position: string | null;
  eligibilityStatus: AthleticsEligibilityStatus;
  eligibilityNotes: string | null;
  liveGpa: number | null;
  programmeMinGpa: number | null;
  joinedAt: string;
  removedAt: string | null;
  removalReason: string | null;
}

export interface AddAthleticsRosterMemberPayload {
  studentId: string;
  jerseyNumber?: string;
  position?: string;
  eligibilityNotes?: string;
}

export interface AthleticsGameResultDto {
  id: string;
  gameId: string;
  homeScore: number;
  awayScore: number;
  scoreByPeriod: Record<string, unknown> | null;
  outcome: AthleticsGameOutcome;
  notes: string | null;
  enteredBy: string;
  enteredByName: string | null;
  enteredAt: string;
}

export interface AthleticsGameDto {
  id: string;
  seasonId: string;
  rosterId: string;
  rosterLevel: AthleticsRosterLevel | null;
  programmeName: string | null;
  gameDate: string;
  gameTime: string;
  opponentName: string;
  opponentSchoolId: string | null;
  location: AthleticsGameLocation;
  status: AthleticsGameStatus;
  isConferenceGame: boolean;
  isTicketed: boolean;
  notes: string | null;
  result: AthleticsGameResultDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAthleticsGamePayload {
  rosterId: string;
  gameDate: string;
  gameTime: string;
  opponentName: string;
  opponentSchoolId?: string;
  location: AthleticsGameLocation;
  isConferenceGame?: boolean;
  isTicketed?: boolean;
  notes?: string;
}

export interface EnterGameResultPayload {
  homeScore: number;
  awayScore: number;
  scoreByPeriod?: Record<string, unknown>;
  outcome: AthleticsGameOutcome;
  notes?: string;
}

export interface AthleticsPlayerStatLineDto {
  id: string;
  gameId: string;
  studentId: string;
  studentName: string;
  statCategory: string;
  statValue: number;
  notes: string | null;
  enteredBy: string;
  enteredAt: string;
}

export interface AthleticsSeasonRecordDto {
  rosterId: string;
  wins: number;
  losses: number;
  draws: number;
  conferenceWins: number;
  conferenceLosses: number;
  conferenceDraws: number;
  lastUpdatedAt: string;
}

export interface AthleticsCoachingAssignmentDto {
  id: string;
  rosterId: string;
  coachPersonId: string;
  coachName: string | null;
  role: AthleticsCoachingRole;
  stipendAmount: number | null;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  notes: string | null;
}

export interface AthleticsConcussionProtocolStepDto {
  id: string;
  injuryId: string;
  stepNumber: number;
  stepName: string;
  startedAt: string;
  minimumDurationHours: number;
  completedAt: string | null;
  symptomFree: boolean;
  clearedBy: string | null;
  clearedByName: string | null;
  notes: string | null;
  canStartNext: boolean;
}

export interface AthleticsMedicalClearanceDto {
  id: string;
  injuryId: string;
  documentS3Key: string;
  physicianName: string | null;
  physicianPhone: string | null;
  clearanceDate: string;
  uploadedBy: string;
  uploadedByName: string | null;
  uploadedAt: string;
  reviewStatus: AthleticsClearanceReviewStatus;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  expiresAt: string | null;
}

export interface AthleticsInjuryDto {
  id: string;
  studentId: string;
  studentName: string;
  gameId: string | null;
  practiceDate: string | null;
  injuryDate: string;
  bodyPart: string;
  injuryDescription: string;
  initialAssessment: string | null;
  actionTaken: string | null;
  severity: AthleticsInjurySeverity;
  healthRecordId: string | null;
  incidentReportId: string | null;
  returnToPlayStatus: AthleticsReturnToPlayStatus;
  loggedBy: string;
  loggedByName: string | null;
  loggedAt: string;
  clearedAt: string | null;
  protocolSteps?: AthleticsConcussionProtocolStepDto[];
  clearances?: AthleticsMedicalClearanceDto[];
}

export interface CreateAthleticsInjuryPayload {
  studentId: string;
  gameId?: string;
  practiceDate?: string;
  injuryDate: string;
  bodyPart: string;
  injuryDescription: string;
  initialAssessment?: string;
  actionTaken?: string;
  severity: AthleticsInjurySeverity;
  returnToPlayStatus: AthleticsReturnToPlayStatus;
  healthRecordId?: string;
  incidentReportId?: string;
}

// ============================================================================
// Cycle 14 — Emergency Alerts + Moderation
// ============================================================================

export type AlertSeverity = 'INFO' | 'WARNING' | 'URGENT' | 'EMERGENCY';
export type AlertChannel = 'PUSH' | 'SMS' | 'EMAIL' | 'APP';
export type AlertStatus = 'ACTIVE' | 'RESOLVED';
export type DeliveryStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED';

export interface AlertTypeDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  severity: AlertSeverity;
  defaultChannels: AlertChannel[];
  requiresAcknowledgement: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAlertTypePayload {
  name: string;
  description?: string;
  severity: AlertSeverity;
  defaultChannels: AlertChannel[];
  requiresAcknowledgement?: boolean;
}

export interface UpdateAlertTypePayload {
  name?: string;
  description?: string;
  severity?: AlertSeverity;
  defaultChannels?: AlertChannel[];
  requiresAcknowledgement?: boolean;
  isActive?: boolean;
}

export interface EmergencyAlertDeliveryDto {
  id: string;
  alertId: string;
  recipientId: string;
  recipientName: string | null;
  channel: AlertChannel;
  status: DeliveryStatus;
  sentAt: string | null;
  acknowledgedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmergencyAlertDto {
  id: string;
  schoolId: string;
  alertTypeId: string;
  alertTypeName: string | null;
  alertSeverity: AlertSeverity;
  requiresAcknowledgement: boolean;
  title: string;
  body: string;
  issuedBy: string;
  issuedByName: string | null;
  incidentId: string | null;
  issuedAt: string;
  status: AlertStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  deliveries?: EmergencyAlertDeliveryDto[];
  myDelivery?: EmergencyAlertDeliveryDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueEmergencyAlertPayload {
  alertTypeId: string;
  title: string;
  body: string;
  incidentId?: string;
  channels?: AlertChannel[];
}

export interface EmergencyAlertStatusDto {
  alertId: string;
  totalDeliveries: number;
  sentCount: number;
  deliveredCount: number;
  acknowledgedCount: number;
  failedCount: number;
  pendingCount: number;
}

// ── Moderation ──

export type ModerationPolicyScope = 'PLATFORM' | 'DISTRICT' | 'BUILDING';
export type ModerationPolicyAction = 'BLOCK' | 'FLAG_FOR_REVIEW' | 'ESCALATE_TO_COUNSELLOR';
export type ModerationReviewOutcome = 'CONFIRMED_BLOCK' | 'RELEASED' | 'ESCALATED';

export interface ModerationPolicyDto {
  id: string;
  scope: ModerationPolicyScope;
  scopeId: string | null;
  name: string | null;
  description: string | null;
  keywords: string[];
  keywordAction: ModerationPolicyAction;
  isActive: boolean;
  isEditable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateModerationPolicyPayload {
  name: string;
  description?: string;
  keywords: string[];
  keywordAction: ModerationPolicyAction;
}

export interface UpdateModerationPolicyPayload {
  name?: string;
  description?: string;
  keywords?: string[];
  keywordAction?: ModerationPolicyAction;
  isActive?: boolean;
}

export interface ModerationQueueRowDto {
  logId: string;
  messageId: string;
  threadId: string | null;
  senderId: string;
  senderName: string | null;
  flagType: string;
  matchedKeywords: string[];
  severity: string;
  policyId: string;
  policyName: string | null;
  reviewOutcome: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  messagePreview: string | null;
  messageStatus: string | null;
  loggedAt: string;
}

export interface ReviewModerationLogPayload {
  outcome: ModerationReviewOutcome;
  notes?: string;
}

// ============================================================================
// Cycle 15 — Meetings & Conferences
// ============================================================================

export type ConferenceType = 'PARENT_TEACHER' | 'STAFF' | 'BOARD' | 'IEP' | 'TRAINING';
export type ConferenceStatus = 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type MeetingStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type ParticipantRole = 'HOST' | 'PRESENTER' | 'ATTENDEE' | 'OBSERVER';
export type ActionItemStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type RecordingStatus = 'PROCESSING' | 'AVAILABLE' | 'FAILED';

export interface ConferenceEventDto {
  id: string;
  schoolId: string;
  title: string;
  description: string | null;
  conferenceType: ConferenceType;
  startDate: string;
  endDate: string;
  status: ConferenceStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  meetingCount?: number;
  totalSlots?: number;
  bookedSlots?: number;
}

export interface CreateConferenceEventPayload {
  title: string;
  description?: string;
  conferenceType: ConferenceType;
  startDate: string;
  endDate: string;
}

export interface UpdateConferenceEventPayload {
  title?: string;
  description?: string;
  status?: ConferenceStatus;
  startDate?: string;
  endDate?: string;
}

export interface MeetingTypeDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  defaultDurationMinutes: number;
  isVideo: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingParticipantDto {
  id: string;
  meetingId: string;
  participantId: string;
  participantName: string | null;
  role: ParticipantRole;
  attended: boolean;
  joinAt: string | null;
  leaveAt: string | null;
  notes: string | null;
}

export interface MeetingDto {
  id: string;
  schoolId: string;
  meetingTypeId: string;
  meetingTypeName: string | null;
  conferenceEventId: string | null;
  conferenceEventTitle: string | null;
  title: string;
  description: string | null;
  scheduledAt: string;
  durationMinutes: number;
  meetingUrl: string | null;
  status: MeetingStatus;
  organiserId: string;
  organiserName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  participants?: MeetingParticipantDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateMeetingPayload {
  meetingTypeId: string;
  conferenceEventId?: string;
  title: string;
  description?: string;
  scheduledAt: string;
  durationMinutes: number;
  meetingUrl?: string;
  participantIds?: string[];
}

export interface UpdateMeetingPayload {
  title?: string;
  description?: string;
  scheduledAt?: string;
  durationMinutes?: number;
  meetingUrl?: string;
  status?: MeetingStatus;
}

export interface MeetingSlotDto {
  id: string;
  meetingId: string;
  startTime: string;
  endTime: string;
  isBooked: boolean;
  bookedBy: string | null;
  bookedByName: string | null;
  bookedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSlotsPayload {
  slots: { startTime: string; endTime: string }[];
}

export interface MeetingNotesDto {
  id: string;
  meetingId: string;
  notesText: string | null;
  isApproved: boolean;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  isParentVisible: boolean;
  parentVisibleSummary: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertMeetingNotesPayload {
  notesText?: string;
  isParentVisible?: boolean;
  parentVisibleSummary?: string;
}

export interface AgendaItemDto {
  id: string;
  meetingId: string;
  title: string;
  description: string | null;
  presenterId: string | null;
  presenterName: string | null;
  durationMinutes: number | null;
  sortOrder: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgendaItemPayload {
  title: string;
  description?: string;
  presenterId?: string;
  durationMinutes?: number;
  sortOrder?: number;
  notes?: string;
}

export interface ActionItemDto {
  id: string;
  meetingId: string;
  meetingTitle: string | null;
  assigneeId: string;
  assigneeName: string | null;
  description: string;
  dueDate: string | null;
  status: ActionItemStatus;
  completedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateActionItemPayload {
  assigneeId: string;
  description: string;
  dueDate?: string;
}

export interface UpdateActionItemPayload {
  description?: string;
  dueDate?: string;
  status?: ActionItemStatus;
}

export interface RecordingConsentDto {
  id: string;
  recordingId: string;
  participantId: string;
  participantName: string | null;
  consentGiven: boolean;
  consentedAt: string;
  notes: string | null;
}

export interface RecordingDto {
  id: string;
  meetingId: string;
  s3Key: string | null;
  signedUrl: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
  status: RecordingStatus;
  consentConfirmed: boolean;
  consents?: RecordingConsentDto[];
  consentedCount?: number;
  totalParticipants?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRecordingPayload {
  s3Key?: string;
  durationSeconds?: number;
  fileSizeBytes?: number;
}

export interface GiveConsentPayload {
  consentGiven: boolean;
  notes?: string;
}

export interface IepMeetingRecordDto {
  id: string;
  meetingId: string;
  studentId: string;
  studentName: string | null;
  iepPlanId: string | null;
  iepPlanType: string | null;
  iepPlanStatus: string | null;
  attendeeRoles: { personId: string; role: string; name: string }[];
  outcomesSummary: string | null;
  nextReviewDate: string | null;
  recordedBy: string | null;
  recordedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIepMeetingRecordPayload {
  studentId: string;
  iepPlanId?: string;
  attendeeRoles?: { personId: string; role: string; name: string }[];
  outcomesSummary?: string;
  nextReviewDate?: string;
}

// ── Cycle 16: Application stages, scores, and onboarding ──

export const APPLICATION_STAGE_TARGETS = [
  'UNDER_REVIEW',
  'INTERVIEW',
  'ASSESSMENT',
  'OFFERED',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
  'WITHDRAWN',
  'ENROLLED',
] as const;
export type ApplicationStageTarget = (typeof APPLICATION_STAGE_TARGETS)[number];

export interface ApplicationStageDto {
  id: string;
  applicationId: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string;
  changedByName: string | null;
  notes: string | null;
  changedAt: string;
}

export interface AdvanceStagePayload {
  toStatus: ApplicationStageTarget;
  notes?: string;
}

export interface ApplicationScoreDto {
  id: string;
  applicationId: string;
  criterionName: string;
  score: number;
  maxScore: number | null;
  scoredBy: string;
  scoredByName: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScorePayload {
  criterionName: string;
  score: number;
  maxScore?: number;
  notes?: string;
}

export interface UpdateScorePayload {
  score?: number;
  maxScore?: number;
  notes?: string;
}

export const ONBOARDING_ADMISSION_TYPES = [
  'STANDARD_INTAKE',
  'MID_YEAR_ADMISSION',
  'TRANSFER_IN',
  'RETURNING_STUDENT',
  'INTERNATIONAL',
] as const;
export type OnboardingAdmissionType = (typeof ONBOARDING_ADMISSION_TYPES)[number];

export const ONBOARDING_TASK_CATEGORIES = [
  'ADMINISTRATIVE',
  'HEALTH',
  'IT',
  'FACILITIES',
  'TRANSPORT',
  'COMMUNICATIONS',
  'FINANCE',
] as const;
export type OnboardingTaskCategory = (typeof ONBOARDING_TASK_CATEGORIES)[number];

export const ONBOARDING_TASK_STATUSES = ['PENDING', 'COMPLETED', 'WAIVED', 'OVERDUE'] as const;
export type OnboardingTaskStatus = (typeof ONBOARDING_TASK_STATUSES)[number];

export type OnboardingProgressStatus = 'IN_PROGRESS' | 'COMPLETE' | 'OVERDUE';

export interface OnboardingTaskTemplateDto {
  id: string;
  checklistId: string;
  taskName: string;
  description: string | null;
  taskCategory: OnboardingTaskCategory;
  isMandatory: boolean;
  responsibleRole: string | null;
  sortOrder: number;
  dueDaysBeforeStart: number;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingChecklistDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  admissionType: OnboardingAdmissionType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  tasks?: OnboardingTaskTemplateDto[];
}

export interface OnboardingTaskCompletionDto {
  id: string;
  progressId: string;
  taskId: string;
  taskName: string | null;
  taskCategory: OnboardingTaskCategory | null;
  responsibleRole: string | null;
  isMandatory?: boolean;
  sortOrder?: number;
  status: OnboardingTaskStatus;
  completedBy: string | null;
  completedByName: string | null;
  completedAt: string | null;
  notes: string | null;
}

export interface OnboardingProgressDto {
  id: string;
  applicationId: string;
  checklistId: string;
  checklistName: string | null;
  studentId: string | null;
  startedDate: string;
  targetStartDate: string;
  overallStatus: OnboardingProgressStatus;
  tasksTotal: number;
  tasksCompleted: number;
  completedAt: string | null;
  taskCompletions?: OnboardingTaskCompletionDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CompleteTaskPayload {
  notes?: string;
}

export interface CompleteTaskResponse {
  completion: OnboardingTaskCompletionDto;
  progress: OnboardingProgressDto;
  onboarded: boolean;
}

export interface CreateChecklistTaskInput {
  taskName: string;
  description?: string;
  taskCategory: OnboardingTaskCategory;
  responsibleRole?: string;
  sortOrder?: number;
  dueDaysBeforeStart?: number;
  isMandatory?: boolean;
}

export interface CreateChecklistPayload {
  name: string;
  description?: string;
  admissionType: OnboardingAdmissionType;
  tasks?: CreateChecklistTaskInput[];
}

// ── Cycle 17: Clubs & Student Life ──

export const ACTIVITY_CATEGORIES = [
  'SPORT',
  'ARTS',
  'ACADEMIC',
  'LEADERSHIP',
  'COMMUNITY',
  'OTHER',
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export type ActivityStatus = 'ACTIVE' | 'INACTIVE' | 'COMPLETED';
export const MEMBER_ROLES = ['MEMBER', 'OFFICER', 'PRESIDENT', 'SECRETARY'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface ActivityTypeDto {
  id: string;
  schoolId: string;
  name: string;
  category: ActivityCategory;
  description: string | null;
  isActive: boolean;
}

export interface ActivityScheduleDto {
  id: string;
  activityId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  location: string | null;
  isActive: boolean;
}

export interface ActivityMemberDto {
  id: string;
  activityId: string;
  studentId: string;
  studentName: string | null;
  role: MemberRole;
  joinedAt: string;
  leftAt: string | null;
  isActive: boolean;
}

export interface ActivityDto {
  id: string;
  schoolId: string;
  activityTypeId: string;
  activityTypeName: string | null;
  activityTypeCategory: ActivityCategory | null;
  name: string;
  description: string | null;
  academicYearId: string;
  advisorId: string | null;
  advisorName: string | null;
  maxParticipants: number | null;
  status: ActivityStatus;
  meetingLocation: string | null;
  memberCount: number;
  members?: ActivityMemberDto[];
  schedule?: ActivityScheduleDto[];
}

export interface CreateActivityPayload {
  activityTypeId: string;
  name: string;
  description?: string;
  academicYearId: string;
  advisorId?: string;
  maxParticipants?: number;
  meetingLocation?: string;
}

export interface JoinActivityPayload {
  role?: MemberRole;
}

export type TripStatus = 'PLANNING' | 'APPROVED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
export type FieldTripAttendanceStatus = 'REGISTERED' | 'ATTENDED' | 'ABSENT' | 'WITHDRAWN';
export type ChaperoneRole = 'LEAD' | 'CHAPERONE' | 'DRIVER';
export type BackgroundCheckStatus = 'NOT_REQUIRED' | 'PENDING' | 'CLEARED' | 'FAILED';

export interface FieldTripParticipantDto {
  id: string;
  fieldTripId: string;
  studentId: string;
  studentName: string | null;
  attendanceStatus: FieldTripAttendanceStatus;
  consentSigned?: boolean;
  consentGiven?: boolean | null;
}

export interface FieldTripChaperoneDto {
  id: string;
  fieldTripId: string;
  personId: string;
  personName: string | null;
  role: ChaperoneRole;
  backgroundCheckStatus: BackgroundCheckStatus;
  confirmed: boolean;
}

export interface FieldTripDto {
  id: string;
  schoolId: string;
  title: string;
  description: string | null;
  destination: string;
  tripDate: string;
  departureTime: string | null;
  returnTime: string | null;
  gradeLevels: string[] | null;
  maxParticipants: number | null;
  costPerStudent: number | null;
  organiserId: string;
  organiserName: string | null;
  status: TripStatus;
  consentDeadline: string | null;
  participantCount: number;
  consentSignedCount: number;
  participants?: FieldTripParticipantDto[];
  chaperones?: FieldTripChaperoneDto[];
}

export interface SignConsentPayload {
  studentId: string;
  consentGiven: boolean;
  emergencyContactOverride?: string;
  medicalNotesOverride?: string;
  notes?: string;
}

export interface ConsentRecordDto {
  id: string;
  fieldTripId: string;
  studentId: string;
  guardianPersonId: string;
  guardianName: string | null;
  consentGiven: boolean;
  signedAt: string;
  ipAddress: string | null;
  emergencyContactOverride: string | null;
  medicalNotesOverride: string | null;
  notes: string | null;
}

export type ElectionStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'RESULTS_PUBLISHED';

export interface ElectionCandidateDto {
  id: string;
  electionId: string;
  studentId: string;
  studentName: string | null;
  position: string;
  statement: string | null;
  photoS3Key: string | null;
  isApproved: boolean;
  registeredAt: string;
  voteCount?: number | null;
}

export interface ElectionDto {
  id: string;
  schoolId: string;
  title: string;
  description: string | null;
  votingStart: string;
  votingEnd: string;
  eligibleVotersFilter: Record<string, unknown>;
  status: ElectionStatus;
  createdBy: string;
  createdByName: string | null;
  candidates?: ElectionCandidateDto[];
}

export interface CastVotePayload {
  position: string;
  candidateId: string;
}

export interface CanVoteDto {
  electionId: string;
  canVote: boolean;
  hasVoted: boolean;
  reason: string;
}

export interface ElectionResultDto {
  position: string;
  candidateId: string;
  candidateName: string | null;
  voteCount: number;
}

export interface ElectionResultsDto {
  electionId: string;
  status: ElectionStatus;
  results: ElectionResultDto[];
  totalVotersChecked: number;
}

export type ServiceHourStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ServiceProgrammeDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  academicYearId: string;
  targetHours: number;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  eligibleGradeLevels: string[] | null;
}

export interface ServiceHourDto {
  id: string;
  studentId: string;
  studentName: string | null;
  programmeId: string | null;
  programmeName: string | null;
  organisation: string;
  description: string;
  serviceDate: string;
  hours: number;
  supervisorName: string | null;
  supervisorContact: string | null;
  evidenceS3Key: string | null;
  approvalStatus: ServiceHourStatus | null;
  approvalNotes: string | null;
  approvedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface LogServiceHourPayload {
  programmeId?: string;
  organisation: string;
  description: string;
  serviceDate: string;
  hours: number;
  supervisorName?: string;
  supervisorContact?: string;
}

export interface ApproveHourPayload {
  status: 'APPROVED' | 'REJECTED';
  notes?: string;
}

export interface ServiceProgressDto {
  id: string;
  programmeId: string;
  programmeName: string | null;
  targetHours: number | null;
  studentId: string;
  studentName: string | null;
  approvedHours: number;
  pendingHours: number;
  isComplete: boolean;
}

// ── Cycle 18: Groups & Communities ──

export type GroupScopeType = 'CLASS' | 'YEAR_GROUP' | 'SCHOOL' | 'CUSTOM' | 'ACTIVITY';
export type GroupStatus = 'ACTIVE' | 'ARCHIVED' | 'DISSOLVED';
export type JoinPolicy = 'OPEN' | 'APPROVAL_REQUIRED' | 'INVITE_ONLY';
export type GroupMemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type GroupMemberStatus =
  | 'ACTIVE'
  | 'INVITED'
  | 'PENDING_APPROVAL'
  | 'SUSPENDED'
  | 'LEFT'
  | 'REMOVED';
export type GroupTransferStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';
export type GroupEventType =
  | 'PRACTICE'
  | 'MATCH'
  | 'MEETING'
  | 'SOCIAL'
  | 'PERFORMANCE'
  | 'COMPETITION'
  | 'OTHER';
export type GroupRsvpStatus = 'GOING' | 'NOT_GOING' | 'MAYBE';
export type GroupNotificationChannel = 'IN_APP' | 'EMAIL' | 'PUSH' | 'ALL' | 'NONE';

export interface GroupDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  scopeType: GroupScopeType;
  scopeId: string | null;
  scopeLabel: string | null;
  status: GroupStatus;
  joinPolicy: JoinPolicy;
  autoDissolveAt: string | null;
  createdBy: string;
  avatarUrl: string | null;
  memberCount: number;
  pendingCount: number;
  myMembership: { id: string; role: GroupMemberRole; status: GroupMemberStatus } | null;
  createdAt: string;
}

export interface CreateGroupPayload {
  name: string;
  description?: string;
  scopeType: GroupScopeType;
  scopeId?: string;
  joinPolicy?: JoinPolicy;
  autoDissolveAt?: string;
  avatarUrl?: string;
}

export interface UpdateGroupPayload {
  name?: string;
  description?: string;
  status?: GroupStatus;
  joinPolicy?: JoinPolicy;
  autoDissolveAt?: string;
  avatarUrl?: string;
}

export interface GroupMemberDto {
  id: string;
  groupId: string;
  personId: string;
  personName: string | null;
  role: GroupMemberRole;
  status: GroupMemberStatus;
  joinedAt: string | null;
  invitedBy: string | null;
  leftAt: string | null;
  suspensionReason: string | null;
}

export interface InviteGroupMemberPayload {
  personId: string;
  role?: 'ADMIN' | 'MEMBER';
}

export interface GroupTransferDto {
  id: string;
  groupId: string;
  fromMemberId: string;
  fromName: string | null;
  toMemberId: string;
  toName: string | null;
  reason: string | null;
  status: GroupTransferStatus;
  initiatedAt: string;
  expiresAt: string;
  respondedAt: string | null;
}

export interface InitiateGroupTransferPayload {
  toMemberId: string;
  reason?: string;
  expiryHours?: number;
}

export interface GroupAnnouncementDto {
  id: string;
  groupId: string;
  authorId: string;
  authorName: string | null;
  title: string;
  body: string;
  pinned: boolean;
  attachments: unknown[] | null;
  publishAt: string;
  expiresAt: string | null;
  readCount: number;
  iHaveRead: boolean;
  createdAt: string;
}

export interface CreateGroupAnnouncementPayload {
  title: string;
  body: string;
  pinned?: boolean;
  attachments?: unknown[];
  expiresAt?: string;
}

export interface GroupEventDto {
  id: string;
  groupId: string;
  createdBy: string;
  createdByName: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string | null;
  eventType: GroupEventType;
  requiresRsvp: boolean;
  rsvpDeadline: string | null;
  maxAttendees: number | null;
  isPublic: boolean;
  goingCount: number;
  maybeCount: number;
  notGoingCount: number;
  myRsvp: GroupRsvpStatus | null;
  createdAt: string;
}

export interface CreateGroupEventPayload {
  title: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt?: string;
  eventType: GroupEventType;
  requiresRsvp?: boolean;
  rsvpDeadline?: string;
  maxAttendees?: number;
  isPublic?: boolean;
}

export interface GroupNotificationPrefsDto {
  membershipId: string;
  notifyAnnouncements: boolean;
  notifyEvents: boolean;
  notifyMembershipChanges: boolean;
  notifyResults: boolean;
  preferredChannel: GroupNotificationChannel;
  quietHoursOverride: boolean;
}

export interface UpdateGroupNotificationPrefsPayload {
  notifyAnnouncements?: boolean;
  notifyEvents?: boolean;
  notifyMembershipChanges?: boolean;
  notifyResults?: boolean;
  preferredChannel?: GroupNotificationChannel;
  quietHoursOverride?: boolean;
}

// ── Cycle 19 Transportation ──

export type RouteDirection = 'AM' | 'PM';
export type RouteStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type AssignmentDirection = 'AM' | 'PM' | 'BOTH';
export type TransportChangeRequestType = 'DIFFERENT_STOP' | 'NO_BUS' | 'DIFFERENT_ROUTE';
export type TransportChangeRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type RouteChangeLogType =
  | 'STOP_ADDED'
  | 'STOP_REMOVED'
  | 'STOP_REORDERED'
  | 'STOP_TIME_CHANGED'
  | 'STUDENT_ADDED'
  | 'STUDENT_REMOVED'
  | 'ROUTE_ACTIVATED'
  | 'ROUTE_DEACTIVATED';
export type VehicleType = 'BUS' | 'MINIBUS' | 'VAN';
export type VehicleStatus = 'ACTIVE' | 'MAINTENANCE' | 'RETIRED';
export type DocumentType = 'INSURANCE' | 'REGISTRATION' | 'MOT' | 'INSPECTION';
export type InspectionStatus = 'PASS' | 'FAIL' | 'CONDITIONAL';
export type InspectionItemStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
export type CredentialType = 'CDL' | 'MEDICAL_CERTIFICATE' | 'BACKGROUND_CHECK' | 'FIRST_AID';
export type CredentialStatus = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED';
export type ScanDirection = 'BOARDING' | 'ALIGHTING';
export type ScanMethod = 'QR_CODE' | 'MANUAL' | 'RFID';
export type PassType = 'ANNUAL' | 'TERM' | 'DAILY';
export type RunStatus = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type NoShowResolution =
  | 'ABSENT_CONFIRMED'
  | 'LATE_ARRIVAL'
  | 'PARENT_NOTIFIED'
  | 'FALSE_ALARM';

export interface TransportStopDto {
  id: string;
  routeId: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  sequenceOrder: number;
  scheduledTime: string | null;
  notes: string | null;
}

export interface TransportRouteDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  direction: RouteDirection;
  status: RouteStatus;
  vehicleId: string | null;
  vehicleRegistration: string | null;
  driverId: string | null;
  driverName: string | null;
  academicYearId: string | null;
  academicYearName: string | null;
  stopCount: number;
  studentCount: number;
  createdAt: string;
  stops?: TransportStopDto[];
}

export interface CreateTransportRoutePayload {
  name: string;
  description?: string;
  direction: RouteDirection;
  vehicleId?: string;
  driverId?: string;
  academicYearId?: string;
}

export interface UpdateTransportRoutePayload {
  name?: string;
  description?: string;
  status?: RouteStatus;
  vehicleId?: string | null;
  driverId?: string | null;
}

export interface TransportStudentAssignmentDto {
  id: string;
  studentId: string;
  studentName: string | null;
  routeId: string;
  stopId: string;
  stopName: string | null;
  stopSequence: number | null;
  direction: AssignmentDirection;
  effectiveFrom: string;
  effectiveTo: string | null;
  isOverride: boolean;
  parentRequestId: string | null;
  createdAt: string;
}

export interface CreateTransportAssignmentPayload {
  studentId: string;
  stopId: string;
  direction: AssignmentDirection;
  effectiveFrom?: string;
  effectiveTo?: string;
  isOverride?: boolean;
  notes?: string;
}

export interface TransportRouteChangeRequestDto {
  id: string;
  studentId: string;
  studentName: string | null;
  submittedBy: string;
  submittedByName: string | null;
  changeDate: string;
  changeType: TransportChangeRequestType;
  requestedRouteId: string | null;
  requestedStopId: string | null;
  reason: string | null;
  status: TransportChangeRequestStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  overrideAssignmentId: string | null;
  createdAt: string;
}

export interface CreateTransportChangeRequestPayload {
  studentId: string;
  changeDate: string;
  changeType: TransportChangeRequestType;
  requestedStopId?: string;
  requestedRouteId?: string;
  reason?: string;
}

export interface ApproveChangeRequestPayload {
  reviewNotes?: string;
}

export interface RejectChangeRequestPayload {
  reviewNotes: string;
}

export interface RouteChangeLogDto {
  id: string;
  routeId: string;
  changedBy: string;
  changedByName: string | null;
  changedAt: string;
  changeType: RouteChangeLogType;
  stopId: string | null;
  studentId: string | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string | null;
}

export interface TransportVehicleDto {
  id: string;
  schoolId: string;
  registration: string;
  make: string | null;
  model: string | null;
  year: number | null;
  capacity: number;
  vehicleType: VehicleType;
  status: VehicleStatus;
  documentSummary: { total: number; current: number; expiringSoon: number; expired: number };
  createdAt: string;
}

export interface CreateTransportVehiclePayload {
  registration: string;
  make?: string;
  model?: string;
  year?: number;
  capacity: number;
  vehicleType: VehicleType;
}

export interface TransportVehicleDocumentDto {
  id: string;
  vehicleId: string;
  documentType: DocumentType;
  documentNumber: string | null;
  s3Key: string | null;
  issuedDate: string | null;
  expiryDate: string;
  isCurrent: boolean;
  expiryStatus: 'CURRENT' | 'EXPIRING_SOON' | 'EXPIRED';
  daysUntilExpiry: number;
}

export interface CreateVehicleDocumentPayload {
  documentType: DocumentType;
  documentNumber?: string;
  s3Key?: string;
  issuedDate?: string;
  expiryDate: string;
}

export interface TransportInspectionItemDto {
  id: string;
  inspectionId: string;
  itemName: string;
  status: InspectionItemStatus;
  notes: string | null;
}

export interface TransportInspectionDto {
  id: string;
  vehicleId: string;
  driverId: string;
  driverName: string | null;
  inspectionDate: string;
  overallStatus: InspectionStatus;
  notes: string | null;
  completedAt: string;
  items?: TransportInspectionItemDto[];
}

export interface CreateInspectionItemPayload {
  itemName: string;
  status: InspectionItemStatus;
  notes?: string;
}

export interface CreateInspectionPayload {
  inspectionDate: string;
  notes?: string;
  items: CreateInspectionItemPayload[];
}

export interface DriverCredentialDto {
  id: string;
  driverId: string;
  credentialType: CredentialType;
  credentialNumber: string | null;
  issuedDate: string;
  expiryDate: string;
  s3Key: string | null;
  status: CredentialStatus;
  daysUntilExpiry: number;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface DriverDto {
  id: string;
  name: string | null;
  credentials: DriverCredentialDto[];
}

export interface CreateDriverCredentialPayload {
  credentialType: CredentialType;
  credentialNumber?: string;
  issuedDate: string;
  expiryDate: string;
  s3Key?: string;
}

export interface UpdateDriverCredentialPayload {
  credentialNumber?: string;
  issuedDate?: string;
  expiryDate?: string;
  s3Key?: string;
  verify?: boolean;
}

export interface TransportBusPassDto {
  id: string;
  studentId: string;
  studentName: string | null;
  passType: PassType;
  qrCodeToken: string;
  isActive: boolean;
  validFrom: string;
  validTo: string;
  issuedAt: string;
}

export interface CreateBusPassPayload {
  studentId: string;
  passType: PassType;
  validFrom: string;
  validTo: string;
  academicYearId?: string;
}

export interface ScanRidershipPayload {
  qrCodeToken: string;
  stopId: string;
  scanDirection: ScanDirection;
}

export interface RidershipRecordDto {
  id: string;
  studentId: string;
  studentName: string | null;
  routeId: string;
  stopId: string;
  stopName: string | null;
  scanDirection: ScanDirection;
  scannedAt: string;
  scanMethod: ScanMethod;
}

export interface NoShowAlertDto {
  id: string;
  studentId: string;
  studentName: string | null;
  routeId: string;
  expectedDate: string;
  expectedStopId: string;
  expectedStopName: string | null;
  alertTime: string;
  resolution: NoShowResolution | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  parentNotifiedAt: string | null;
  resolutionNotes: string | null;
}

export interface ResolveNoShowPayload {
  resolution: NoShowResolution;
  resolutionNotes?: string;
}

export interface CreateRunLogPayload {
  routeId: string;
  runDate: string;
  odometerStart?: number;
}

export interface CompleteRunLogPayload {
  odometerEnd?: number;
  status?: 'COMPLETED' | 'CANCELLED';
  notes?: string;
}

export interface RunLogDto {
  id: string;
  routeId: string;
  vehicleId: string;
  driverId: string;
  runDate: string;
  departureTime: string | null;
  arrivalTime: string | null;
  odometerStart: number | null;
  odometerEnd: number | null;
  studentsBoarded: number;
  status: RunStatus;
}

export interface CreateDelayReportPayload {
  routeId: string;
  runDate: string;
  delayMinutes: number;
  reason: string;
  affectedStops?: string[];
}

export interface DelayReportDto {
  id: string;
  routeId: string;
  runDate: string;
  reportedBy: string;
  delayMinutes: number;
  reason: string;
  affectedStops: string[] | null;
  parentNotificationSent: boolean;
  reportedAt: string;
}

// ── Cycle 20 Food Service ──

export type FdsMenuItemCategory = 'MAIN' | 'SIDE' | 'DESSERT' | 'DRINK' | 'SNACK';
export type FdsMealType = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK';
export type FdsPosDeviceType = 'CASHIER_STAFFED' | 'SELF_SERVICE_KIOSK' | 'MOBILE_CART';
export type FdsPaymentMethod = 'LUNCH_ACCOUNT' | 'INVOICE' | 'CASH' | 'FREE_MEAL' | 'STAFF_ACCOUNT';
export type FdsPatronType = 'STUDENT' | 'STAFF';
export type FdsReconciliationStatus = 'OPEN' | 'RECONCILED' | 'VARIANCE_FLAGGED';
export type FdsAllergenSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type FdsDietaryMealPlan = 'STANDARD' | 'VEGETARIAN' | 'VEGAN' | 'HALAL' | 'KOSHER' | 'OTHER';
export type FdsDietaryUpdateChangeType =
  | 'ADD_RESTRICTION'
  | 'REMOVE_RESTRICTION'
  | 'ADD_ALLERGEN'
  | 'REMOVE_ALLERGEN'
  | 'CHANGE_MEAL_PLAN'
  | 'UPDATE_ELIGIBILITY';
export type FdsDietaryUpdateStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type FdsEligibilityApplicationType = 'INCOME_BASED' | 'CATEGORICAL' | 'DIRECT_CERTIFICATION';
export type FdsEligibilityStatus =
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'DENIED'
  | 'WITHDRAWN';
export type FdsEligibilityCategory = 'FREE' | 'REDUCED' | 'PAID' | 'DENIED';
export type FdsUsdaClaimStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
export type FdsTempCheckLocation =
  | 'DELIVERY'
  | 'REFRIGERATOR'
  | 'FREEZER'
  | 'SERVING_LINE'
  | 'HOT_HOLD'
  | 'COLD_HOLD'
  | 'COOK_TEMP';

export interface FdsMenuCycleDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  cycleLengthDays: number;
  isActive: boolean;
  createdAt: string;
}

export interface FdsMenuItemDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  category: FdsMenuItemCategory;
  unitCost: number | null;
  calories: number | null;
  allergens: string[];
  allergenCodes: string[];
  isVegetarian: boolean;
  isVegan: boolean;
  isGlutenFree: boolean;
  isPreorderable: boolean;
  isActive: boolean;
}

export interface FdsDailyMenuItemDto {
  id: string;
  dailyMenuId: string;
  menuItemId: string;
  menuItemName: string | null;
  category: FdsMenuItemCategory | null;
  unitCost: number | null;
  allergenCodes: string[];
  quantityPrepared: number | null;
  quantityServed: number | null;
  quantityWasted: number | null;
  isAvailable: boolean;
}

export interface FdsDailyMenuDto {
  id: string;
  schoolId: string;
  menuDate: string;
  cycleId: string | null;
  mealType: FdsMealType;
  notes: string | null;
  items?: FdsDailyMenuItemDto[];
}

export interface CreateFdsMenuItemPayload {
  name: string;
  description?: string;
  category: FdsMenuItemCategory;
  unitCost?: number;
  calories?: number;
  allergens?: string[];
  allergenCodes?: string[];
  isVegetarian?: boolean;
  isVegan?: boolean;
  isGlutenFree?: boolean;
  isPreorderable?: boolean;
}

export interface CreateFdsDailyMenuPayload {
  menuDate: string;
  mealType: FdsMealType;
  cycleId?: string;
  notes?: string;
}

export interface FdsPosDeviceDto {
  id: string;
  schoolId: string;
  deviceName: string;
  location: string | null;
  deviceType: FdsPosDeviceType;
  isActive: boolean;
}

export interface FdsSessionDto {
  id: string;
  schoolId: string;
  serviceDate: string;
  mealType: FdsMealType;
  openedBy: string;
  openedByName: string | null;
  openedAt: string;
  closedBy: string | null;
  closedAt: string | null;
  transactionCount: number;
  totalSales: number;
}

export interface FdsAllergenMatchDto {
  itemId: string;
  itemName: string | null;
  matchedAllergens: string[];
  severity: FdsAllergenSeverity;
}

export interface FdsTransactionItem {
  itemId: string;
  name?: string;
  price: number;
}

export interface FdsTransactionDto {
  id: string;
  patronId: string;
  patronName: string | null;
  patronType: FdsPatronType;
  sessionId: string;
  posDeviceId: string;
  items: unknown;
  total: number;
  paymentMethod: FdsPaymentMethod;
  allergenOverrideRequired: boolean;
  supervisorOverrideId: string | null;
  overrideReason: string | null;
  servedAt: string;
  warnings?: FdsAllergenMatchDto[];
}

export interface CreateFdsTransactionPayload {
  patronId: string;
  patronType?: FdsPatronType;
  sessionId: string;
  posDeviceId: string;
  items: FdsTransactionItem[];
  paymentMethod: FdsPaymentMethod;
  supervisorOverrideId?: string;
  overrideReason?: string;
}

export interface FdsAllergenCheckDto {
  patronId: string;
  activeAllergens: string[];
  criticalCount: number;
  warningCount: number;
  infoCount: number;
}

export interface FdsReconciliationDto {
  id: string;
  sessionId: string;
  posDeviceId: string;
  openingBalance: number;
  expectedClosingBalance: number;
  actualClosingBalance: number | null;
  variance: number | null;
  reconciledBy: string | null;
  reconciledAt: string | null;
  status: FdsReconciliationStatus;
}

export interface FdsDietaryProfileDto {
  id: string;
  studentId: string;
  schoolId: string;
  dietaryRestrictions: string[];
  allergens: string[];
  freeMealEligible: boolean;
  mealPlanType: FdsDietaryMealPlan;
}

export interface FdsDietaryUpdateRequestDto {
  id: string;
  studentId: string;
  studentName: string | null;
  submittedBy: string;
  submittedByName: string | null;
  changeType: FdsDietaryUpdateChangeType;
  proposedValue: string;
  reason: string | null;
  status: FdsDietaryUpdateStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
}

export interface FdsAllergenAlertDto {
  id: string;
  studentId: string;
  studentName: string | null;
  schoolId: string;
  allergenCode: string;
  allergenDisplayName: string;
  severity: FdsAllergenSeverity;
  sourceHealthAlertId: string;
  isActive: boolean;
  lastSyncedAt: string;
}

export interface FdsEligibilityApplicationDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  submittedBy: string;
  householdSize: number;
  annualHouseholdIncome: number | null;
  snapBenefitCaseNumber: string | null;
  applicationType: FdsEligibilityApplicationType;
  status: FdsEligibilityStatus;
  submittedAt: string;
  determination?: FdsEligibilityDeterminationDto;
}

export interface FdsEligibilityDeterminationDto {
  id: string;
  applicationId: string;
  determinedBy: string;
  determinedAt: string;
  eligibilityCategory: FdsEligibilityCategory;
  effectiveFrom: string;
  effectiveTo: string;
  notificationSent: boolean;
}

export interface FdsUsdaClaimDto {
  id: string;
  schoolId: string;
  academicYearId: string | null;
  monthYear: string;
  freeMealsCount: number;
  reducedMealsCount: number;
  paidMealsCount: number;
  reimbursementAmount: number | null;
  status: FdsUsdaClaimStatus;
  submittedAt: string | null;
}

export interface FdsTemperatureLogDto {
  id: string;
  schoolId: string;
  checkLocation: FdsTempCheckLocation;
  locationName: string;
  temperatureCelsius: number;
  safeRangeMin: number;
  safeRangeMax: number;
  isCompliant: boolean;
  correctiveAction: string | null;
  loggedBy: string;
  loggedByName: string | null;
  loggedAt: string;
}

export interface CreateFdsTemperatureLogPayload {
  checkLocation: FdsTempCheckLocation;
  locationName: string;
  temperatureCelsius: number;
  safeRangeMin: number;
  safeRangeMax: number;
  correctiveAction?: string;
  notes?: string;
}

export interface CreateFdsDietaryUpdateRequestPayload {
  studentId: string;
  changeType: FdsDietaryUpdateChangeType;
  proposedValue: string;
  reason?: string;
}

export interface CreateFdsEligibilityApplicationPayload {
  studentId: string;
  householdSize: number;
  annualHouseholdIncome?: number;
  snapBenefitCaseNumber?: string;
  applicationType: FdsEligibilityApplicationType;
  academicYearId?: string;
}

// ============================================================
// Cycle 21 — Facilities Management types
// ============================================================

export type FacSpaceType =
  | 'CLASSROOM'
  | 'BATHROOM'
  | 'CORRIDOR'
  | 'STAIRWELL'
  | 'MECHANICAL'
  | 'STORAGE'
  | 'OFFICE'
  | 'GROUNDS'
  | 'COMMON_AREA'
  | 'GYM'
  | 'CAFETERIA'
  | 'OTHER';

export type FacBookingStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';

export type FacWorkOrderType =
  | 'REPAIR'
  | 'INSTALLATION'
  | 'INSPECTION_PREP'
  | 'DEEP_CLEAN'
  | 'RENOVATION';

export type FacWorkOrderPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type FacWorkOrderStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'VENDOR_ASSIGNED'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'CANCELLED';

export type FacWorkOrderActivityType = 'STATUS_CHANGE' | 'REASSIGNMENT' | 'COMMENT' | 'ATTACHMENT';

export type FacPmTargetType = 'BUILDING' | 'SPACE' | 'SYSTEM';
export type FacPmTaskStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'OVERDUE';
export type FacInspectionOutcome = 'PENDING' | 'PASSED' | 'PASSED_WITH_CONDITIONS' | 'FAILED';
export type FacViolationSeverity = 'MINOR' | 'MAJOR' | 'CRITICAL';
export type FacZoneShift = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'OVERNIGHT';

export interface FacBuildingDto {
  id: string;
  schoolId: string;
  name: string;
  code: string | null;
  yearBuilt: number | null;
  totalFloors: number | null;
  address: string | null;
  isActive: boolean;
  spaceCount: number;
  openWorkOrders: number;
}

export interface FacCreateBuildingPayload {
  name: string;
  code?: string;
  yearBuilt?: number;
  totalFloors?: number;
  address?: string;
}

export interface FacUpdateBuildingPayload {
  name?: string;
  code?: string;
  yearBuilt?: number;
  totalFloors?: number;
  address?: string;
  isActive?: boolean;
}

export interface FacSpaceDto {
  id: string;
  buildingId: string;
  name: string;
  floor: string | null;
  spaceType: FacSpaceType;
  areaSqft: number | null;
  isActive: boolean;
  schRoomId: string | null;
  schRoomName: string | null;
}

export interface FacCreateSpacePayload {
  name: string;
  floor?: string;
  spaceType: FacSpaceType;
  areaSqft?: number;
  schRoomId?: string | null;
}

export interface FacUpdateSpacePayload {
  name?: string;
  floor?: string;
  spaceType?: FacSpaceType;
  areaSqft?: number;
  isActive?: boolean;
  schRoomId?: string | null;
}

export interface FacBookingDto {
  id: string;
  spaceId: string;
  spaceName: string;
  bookedBy: string;
  bookedByName: string | null;
  title: string;
  startsAt: string;
  endsAt: string;
  status: FacBookingStatus;
  notes: string | null;
}

export interface FacCreateBookingPayload {
  title: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
}

export interface FacUpdateBookingPayload {
  status?: FacBookingStatus;
  notes?: string;
}

export interface FacClosureDto {
  id: string;
  spaceId: string;
  spaceName: string;
  closureReason: string;
  startsAt: string;
  endsAt: string | null;
  affectsScheduling: boolean;
  linkedWorkOrderId: string | null;
  createdBy: string;
}

export interface FacCreateClosurePayload {
  spaceId: string;
  closureReason: string;
  startsAt: string;
  endsAt?: string;
  affectsScheduling?: boolean;
  linkedWorkOrderId?: string;
}

export interface FacUpdateClosurePayload {
  endsAt?: string;
  closureReason?: string;
  affectsScheduling?: boolean;
}

export interface FacWorkOrderActivityDto {
  id: string;
  workOrderId: string;
  actorId: string;
  actorName: string | null;
  activityType: FacWorkOrderActivityType;
  metadata: unknown;
  createdAt: string;
}

export interface FacWorkOrderDto {
  id: string;
  schoolId: string;
  workOrderType: FacWorkOrderType;
  priority: FacWorkOrderPriority;
  spaceId: string | null;
  spaceName: string | null;
  buildingId: string | null;
  buildingName: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  scheduledDate: string | null;
  completedAt: string | null;
  status: FacWorkOrderStatus;
  tktTicketId: string | null;
  cost: number | null;
  description: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  activity?: FacWorkOrderActivityDto[];
}

export interface FacCreateWorkOrderPayload {
  workOrderType: FacWorkOrderType;
  priority: FacWorkOrderPriority;
  spaceId?: string;
  buildingId?: string;
  assignedToId?: string;
  vendorId?: string;
  scheduledDate?: string;
  description?: string;
  tktTicketId?: string;
}

export interface FacUpdateWorkOrderPayload {
  status?: FacWorkOrderStatus;
  priority?: FacWorkOrderPriority;
  assignedToId?: string | null;
  vendorId?: string | null;
  scheduledDate?: string;
  cost?: number;
  description?: string;
  notes?: string;
}

export interface FacPmChecklistItemDto {
  id: string;
  planId: string;
  itemName: string;
  description: string | null;
  sortOrder: number;
}

export interface FacPmPlanDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  frequencyMonths: number;
  targetType: FacPmTargetType;
  targetId: string | null;
  isActive: boolean;
  items: FacPmChecklistItemDto[];
}

export interface FacCreatePmPlanPayload {
  name: string;
  description?: string;
  frequencyMonths: number;
  targetType: FacPmTargetType;
  targetId?: string;
  items?: Array<{ itemName: string; description?: string; sortOrder?: number }>;
}

export interface FacGeneratePmTasksPayload {
  fromDate: string;
  toDate: string;
}

export interface FacPmTaskDto {
  id: string;
  planId: string;
  planName: string;
  scheduledDate: string;
  assignedTo: string | null;
  assignedToName: string | null;
  status: FacPmTaskStatus;
  completedAt: string | null;
  completedBy: string | null;
  notes: string | null;
}

export interface FacUpdatePmTaskPayload {
  status?: FacPmTaskStatus;
  assignedTo?: string | null;
  notes?: string;
}

export interface FacChecklistResultDto {
  id: string;
  taskId: string;
  checklistItemId: string;
  itemName: string;
  passed: boolean;
  notes: string | null;
  photoS3Keys: string[];
  followUpWorkOrderId: string | null;
  submittedBy: string;
  submittedAt: string;
}

export interface FacSubmitChecklistResultsPayload {
  results: Array<{
    checklistItemId: string;
    passed: boolean;
    notes?: string;
    photoS3Keys?: string[];
  }>;
}

export interface FacInspectionTypeDto {
  id: string;
  schoolId: string;
  name: string;
  authority: string;
  frequencyMonths: number;
  isMandatory: boolean;
  failureEscalationDays: number | null;
}

export interface FacCreateInspectionTypePayload {
  name: string;
  authority: string;
  frequencyMonths: number;
  isMandatory?: boolean;
  failureEscalationDays?: number;
}

export interface FacInspectionDto {
  id: string;
  schoolId: string;
  inspectionTypeId: string;
  inspectionTypeName: string;
  authority: string;
  buildingId: string;
  buildingName: string;
  scheduledDate: string | null;
  conductedDate: string | null;
  inspectorName: string | null;
  inspectorAgency: string | null;
  outcome: FacInspectionOutcome;
  certificateS3Key: string | null;
  nextDueDate: string | null;
  notes: string | null;
}

export interface FacCreateInspectionPayload {
  inspectionTypeId: string;
  buildingId: string;
  scheduledDate?: string;
  conductedDate?: string;
  inspectorName?: string;
  inspectorAgency?: string;
  outcome: FacInspectionOutcome;
  certificateS3Key?: string;
  nextDueDate?: string;
  notes?: string;
}

export interface FacViolationDto {
  id: string;
  inspectionId: string;
  description: string;
  severity: FacViolationSeverity;
  dueDate: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolutionNotes: string | null;
  linkedWorkOrderId: string | null;
}

export interface FacCreateViolationPayload {
  description: string;
  severity: FacViolationSeverity;
  dueDate: string;
}

export interface FacResolveViolationPayload {
  resolutionNotes: string;
  linkedWorkOrderId?: string;
}

export interface FacZoneAssignmentDto {
  id: string;
  zoneId: string;
  employeeId: string;
  employeeName: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  shift: FacZoneShift;
  notes: string | null;
}

export interface FacZoneDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  color: string | null;
  assignments: FacZoneAssignmentDto[];
}

export interface FacCreateZonePayload {
  name: string;
  description?: string;
  color?: string;
}

export interface FacCreateZoneAssignmentPayload {
  employeeId: string;
  effectiveFrom: string;
  effectiveTo?: string;
  shift: FacZoneShift;
  notes?: string;
}

export interface FacSupplyDto {
  id: string;
  buildingId: string;
  itemName: string;
  unit: string;
  currentQuantity: number;
  reorderThreshold: number | null;
  preferredSupplier: string | null;
  lastRestockedAt: string | null;
  belowThreshold: boolean;
}

export interface FacCreateSupplyPayload {
  buildingId: string;
  itemName: string;
  unit: string;
  currentQuantity?: number;
  reorderThreshold?: number;
  preferredSupplier?: string;
}

export interface FacAdjustSupplyPayload {
  currentQuantity: number;
  reorderThreshold?: number;
  notes?: string;
}

// ──────────────────────────────────────────────────────────────
// Cycle 22 — IT Infrastructure (M62)
// ──────────────────────────────────────────────────────────────

export type ItAssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'REPAIR' | 'LOST' | 'RETIRED';
export type ItAssetCondition = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'DAMAGED';
export type ItAssetDocumentType = 'WARRANTY' | 'INVOICE' | 'MANUAL' | 'OTHER';
export type ItDamageSeverity = 'MINOR' | 'MODERATE' | 'SEVERE' | 'TOTAL_LOSS';
export type ItRepairType = 'INTERNAL' | 'VENDOR' | 'WARRANTY_CLAIM';
export type ItRepairStatus = 'PENDING' | 'IN_REPAIR' | 'COMPLETED' | 'UNREPAIRABLE';
export type ItLicenceType = 'PER_SEAT' | 'SITE' | 'SUBSCRIPTION';
export type ItCredentialType =
  | 'VENDOR_PORTAL'
  | 'SERVICE_ACCOUNT'
  | 'API_KEY'
  | 'SSL_CERTIFICATE'
  | 'WIFI_CREDENTIAL'
  | 'ADMIN_SHARED'
  | 'OTHER';
export type ItAccessTier = 'STANDARD' | 'ELEVATED' | 'CRITICAL';
export type ItCredentialAccessType = 'VIEW' | 'COPY' | 'MODIFY' | 'CREATE' | 'DELETE';
export type ItMdmProvider = 'GOOGLE' | 'APPLE' | 'INTUNE' | 'JAMF';
export type ItMdmAlertType =
  | 'NON_COMPLIANT'
  | 'STALE_CHECKIN'
  | 'OS_OUTDATED'
  | 'POLICY_VIOLATION'
  | 'JAILBREAK_DETECTED'
  | 'OTHER';
export type ItInfraItemType =
  | 'SWITCH'
  | 'ROUTER'
  | 'ACCESS_POINT'
  | 'FIREWALL'
  | 'SERVER'
  | 'STORAGE_ARRAY'
  | 'UPS'
  | 'PRINTER'
  | 'OTHER';
export type ItProcurementStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'ORDERED'
  | 'DELIVERED'
  | 'CANCELLED';
export type ItDeviceType = 'LAPTOP' | 'DESKTOP' | 'TABLET' | 'PHONE' | 'OTHER';
export type ItSelectionContext = 'ENROLMENT' | 'REFRESH' | 'REPLACEMENT';
export type ItSelectionStatus = 'PENDING' | 'SELECTED' | 'APPROVED' | 'PROVISIONED' | 'REJECTED';

export interface ItAssetCategoryDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  depreciationYears: number | null;
  maintenanceIntervalMonths: number | null;
  isActive: boolean;
  assetCount: number;
}

export interface ItCreateAssetCategoryPayload {
  name: string;
  description?: string;
  depreciationYears?: number;
  maintenanceIntervalMonths?: number;
}

export interface ItUpdateAssetCategoryPayload {
  name?: string;
  description?: string;
  depreciationYears?: number;
  maintenanceIntervalMonths?: number;
  isActive?: boolean;
}

export interface ItAssetDto {
  id: string;
  schoolId: string;
  categoryId: string;
  categoryName: string;
  assetTag: string;
  serialNumber: string | null;
  make: string | null;
  model: string | null;
  purchaseDate: string | null;
  purchaseCost: number | null;
  warrantyExpiry: string | null;
  status: ItAssetStatus;
  notes: string | null;
  currentAssigneeId: string | null;
  currentAssigneeName: string | null;
}

export interface ItCreateAssetPayload {
  categoryId: string;
  assetTag: string;
  serialNumber?: string;
  make?: string;
  model?: string;
  purchaseDate?: string;
  purchaseCost?: number;
  warrantyExpiry?: string;
  notes?: string;
}

export interface ItUpdateAssetPayload {
  categoryId?: string;
  assetTag?: string;
  serialNumber?: string;
  make?: string;
  model?: string;
  purchaseDate?: string;
  purchaseCost?: number;
  warrantyExpiry?: string;
  status?: ItAssetStatus;
  notes?: string;
}

export interface ItAssignmentDto {
  id: string;
  assetId: string;
  assetTag: string;
  assigneeId: string;
  assigneeName: string;
  assignedBy: string;
  assignedAt: string;
  returnedAt: string | null;
  conditionAtAssign: ItAssetCondition | null;
  conditionAtReturn: ItAssetCondition | null;
  notes: string | null;
}

export interface ItAssignAssetPayload {
  assigneeId: string;
  conditionAtAssign?: ItAssetCondition;
  notes?: string;
}

export interface ItReturnAssetPayload {
  conditionAtReturn?: ItAssetCondition;
  notes?: string;
}

export interface ItAssetDocumentDto {
  id: string;
  assetId: string;
  documentType: ItAssetDocumentType;
  s3Key: string;
  fileName: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface ItCreateAssetDocumentPayload {
  documentType: ItAssetDocumentType;
  s3Key: string;
  fileName: string;
}

export interface ItDamageReportDto {
  id: string;
  assetId: string;
  assetTag: string;
  reportedBy: string;
  reportedByName: string;
  description: string;
  severity: ItDamageSeverity;
  photoS3Keys: string[];
  reportedAt: string;
  repairRecordId: string | null;
}

export interface ItCreateDamageReportPayload {
  assetId: string;
  description: string;
  severity: ItDamageSeverity;
  photoS3Keys?: string[];
}

export interface ItRepairRecordDto {
  id: string;
  assetId: string;
  assetTag: string;
  damageReportId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  repairType: ItRepairType;
  sentForRepairAt: string | null;
  estimatedReturnDate: string | null;
  returnedAt: string | null;
  costEstimate: number | null;
  finalCost: number | null;
  status: ItRepairStatus;
  notes: string | null;
}

export interface ItCreateRepairPayload {
  assetId: string;
  damageReportId?: string;
  vendorId?: string;
  repairType: ItRepairType;
  estimatedReturnDate?: string;
  costEstimate?: number;
}

export interface ItUpdateRepairPayload {
  status?: ItRepairStatus;
  estimatedReturnDate?: string;
  returnedAt?: string;
  finalCost?: number;
  notes?: string;
}

export interface ItLicenceDto {
  id: string;
  schoolId: string;
  softwareName: string;
  vendor: string | null;
  licenceType: ItLicenceType;
  totalSeats: number | null;
  usedSeats: number;
  utilisationPct: number | null;
  expiryDate: string | null;
  annualCost: number | null;
  notes: string | null;
  isActive: boolean;
}

export interface ItCreateLicencePayload {
  softwareName: string;
  vendor?: string;
  licenceType: ItLicenceType;
  totalSeats?: number;
  expiryDate?: string;
  annualCost?: number;
  notes?: string;
}

export interface ItUpdateLicencePayload {
  softwareName?: string;
  vendor?: string;
  totalSeats?: number;
  expiryDate?: string;
  annualCost?: number;
  notes?: string;
  isActive?: boolean;
}

export interface ItLicenceAssignmentDto {
  id: string;
  licenceId: string;
  softwareName: string;
  assigneeId: string;
  assigneeName: string;
  assignedBy: string;
  assignedAt: string;
  lastUsedAt: string | null;
  notes: string | null;
}

export interface ItAssignLicencePayload {
  assigneeId: string;
  notes?: string;
}

export interface ItCredentialSummaryDto {
  id: string;
  schoolId: string;
  serviceName: string;
  credentialType: ItCredentialType;
  username: string | null;
  url: string | null;
  accessTier: ItAccessTier;
  lastRotatedAt: string | null;
  rotationDueAt: string | null;
  expiryDate: string | null;
  notes: string | null;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ItCredentialDetailDto extends ItCredentialSummaryDto {
  password: string;
}

export interface ItCreateCredentialPayload {
  serviceName: string;
  credentialType: ItCredentialType;
  username?: string;
  password: string;
  url?: string;
  expiryDate?: string;
  rotationDueAt?: string;
  accessTier?: ItAccessTier;
  notes?: string;
}

export interface ItUpdateCredentialPayload {
  serviceName?: string;
  username?: string;
  password?: string;
  url?: string;
  expiryDate?: string;
  rotationDueAt?: string;
  accessTier?: ItAccessTier;
  notes?: string;
}

export interface ItCredentialAccessLogDto {
  id: string;
  credentialId: string;
  serviceName: string;
  accessedBy: string;
  accessedByName: string;
  accessType: ItCredentialAccessType;
  accessedAt: string;
}

export interface ItMdmSyncDto {
  id: string;
  assetId: string;
  assetTag: string;
  mdmProvider: ItMdmProvider;
  syncAt: string;
  deviceName: string | null;
  osVersion: string | null;
  lastCheckIn: string | null;
  isCompliant: boolean;
  complianceDetails: Record<string, unknown> | null;
}

export interface ItCreateMdmSyncPayload {
  assetId: string;
  mdmProvider: ItMdmProvider;
  deviceName?: string;
  osVersion?: string;
  lastCheckIn?: string;
  isCompliant?: boolean;
  complianceDetails?: Record<string, unknown>;
}

export interface ItMdmAlertDto {
  id: string;
  assetId: string;
  assetTag: string;
  alertType: ItMdmAlertType;
  alertDetail: string | null;
  firstDetectedAt: string;
  lastDetectedAt: string;
  isResolved: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
}

export interface ItCreateMdmAlertPayload {
  assetId: string;
  alertType: ItMdmAlertType;
  alertDetail?: string;
}

export interface ItResolveMdmAlertPayload {
  resolutionNotes?: string;
}

export interface ItInfrastructureItemDto {
  id: string;
  schoolId: string;
  itemName: string;
  itemType: ItInfraItemType;
  location: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  make: string | null;
  model: string | null;
  serialNumber: string | null;
  purchaseDate: string | null;
  warrantyExpiry: string | null;
  status: string;
  notes: string | null;
}

export interface ItCreateInfrastructureItemPayload {
  itemName: string;
  itemType: ItInfraItemType;
  location?: string;
  ipAddress?: string;
  macAddress?: string;
  make?: string;
  model?: string;
  serialNumber?: string;
  purchaseDate?: string;
  warrantyExpiry?: string;
  notes?: string;
}

export interface ItUpdateInfrastructureItemPayload {
  itemName?: string;
  location?: string;
  ipAddress?: string;
  macAddress?: string;
  status?: string;
  notes?: string;
}

export interface ItProcurementOrderDto {
  id: string;
  schoolId: string;
  orderTitle: string;
  vendorId: string | null;
  vendorName: string | null;
  purchaseOrderNumber: string | null;
  orderedBy: string | null;
  orderedByName: string | null;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  deliveredAt: string | null;
  totalCost: number | null;
  status: ItProcurementStatus;
  notes: string | null;
}

export interface ItCreateProcurementOrderPayload {
  orderTitle: string;
  vendorId?: string;
  purchaseOrderNumber?: string;
  orderDate?: string;
  expectedDeliveryDate?: string;
  totalCost?: number;
  notes?: string;
}

export interface ItUpdateProcurementOrderPayload {
  orderTitle?: string;
  status?: ItProcurementStatus;
  expectedDeliveryDate?: string;
  totalCost?: number;
  notes?: string;
}

export interface ItMarkDeliveredPayload {
  deliveredAt?: string;
  notes?: string;
}

export interface ItDeviceOptionDto {
  id: string;
  schoolId: string;
  optionName: string;
  deviceType: ItDeviceType;
  operatingSystem: string | null;
  specifications: string | null;
  softwareAvailable: string[];
  costDifference: number | null;
  isActive: boolean;
}

export interface ItCreateDeviceOptionPayload {
  optionName: string;
  deviceType: ItDeviceType;
  operatingSystem?: string;
  specifications?: string;
  softwareAvailable?: string[];
  costDifference?: number;
}

export interface ItUpdateDeviceOptionPayload {
  optionName?: string;
  operatingSystem?: string;
  specifications?: string;
  softwareAvailable?: string[];
  costDifference?: number;
  isActive?: boolean;
}

export interface ItDeviceSelectionDto {
  id: string;
  personId: string;
  personName: string;
  optionId: string;
  optionName: string;
  selectionContext: ItSelectionContext;
  selectedAt: string;
  status: ItSelectionStatus;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  assetId: string | null;
  assetTag: string | null;
  notes: string | null;
}

export interface ItCreateDeviceSelectionPayload {
  personId: string;
  optionId: string;
  selectionContext: ItSelectionContext;
  assetId?: string;
  notes?: string;
}

export interface ItApproveSelectionPayload {
  assetId?: string;
  notes?: string;
}
