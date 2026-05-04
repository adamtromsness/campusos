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
