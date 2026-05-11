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

// ──────────────────────────────────────────────────────────────
// Cycle 23 — Curriculum & Standards (M25)
// ──────────────────────────────────────────────────────────────

export type CurFrameworkSource = 'PLATFORM' | 'SCHOOL';
export type CurStandardSource = 'PLATFORM' | 'SCHOOL';
export type CurMapStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type CurGapType = 'NOT_STARTED' | 'PARTIAL' | 'COMPLETE';
export type CurResourceType = 'FILE' | 'URL' | 'VIDEO' | 'TEXTBOOK';

export interface CurFrameworkDto {
  id: string;
  source: CurFrameworkSource;
  name: string;
  body: string | null;
  region: string | null;
  version: string | null;
  description: string | null;
  schoolId: string | null;
  isActive: boolean;
  standardCount: number;
}

export interface CurStandardDto {
  id: string;
  source: CurStandardSource;
  frameworkId: string;
  frameworkName: string;
  code: string;
  description: string;
  gradeBand: string | null;
  domain: string | null;
  cluster: string | null;
}

export interface CurFrameworkDetailDto extends CurFrameworkDto {
  standards: CurStandardDto[];
}

export interface CurAdoptionDto {
  id: string;
  schoolId: string;
  platformFrameworkId: string;
  platformFrameworkName: string;
  academicYearId: string;
  academicYearName: string;
  adoptedAt: string;
  adoptedBy: string;
  notes: string | null;
}

export interface CurCreateAdoptionPayload {
  platformFrameworkId: string;
  academicYearId: string;
  notes?: string;
}

export interface CurCreateCustomFrameworkPayload {
  name: string;
  version?: string;
  description?: string;
}

export interface CurCreateStandardPayload {
  frameworkId: string;
  code: string;
  description: string;
  gradeBand?: string;
  domain?: string;
  cluster?: string;
}

export interface CurCreateMapPayload {
  academicYearId: string;
  frameworkId?: string;
  subject: string;
  gradeLevel: string;
  title: string;
  description?: string;
}

export interface CurUpdateMapPayload {
  title?: string;
  description?: string;
  subject?: string;
  gradeLevel?: string;
  frameworkId?: string;
  status?: CurMapStatus;
}

export interface CurMapDto {
  id: string;
  schoolId: string;
  academicYearId: string;
  academicYearName: string;
  frameworkId: string | null;
  frameworkName: string | null;
  frameworkSource: CurFrameworkSource | null;
  subject: string;
  gradeLevel: string;
  title: string;
  description: string | null;
  status: CurMapStatus;
  createdBy: string;
  publishedAt: string | null;
  archivedAt: string | null;
  unitCount: number;
  totalStandards: number;
  gapSummary: { complete: number; partial: number; notStarted: number };
}

export interface CurUnitDto {
  id: string;
  curriculumMapId: string;
  title: string;
  description: string | null;
  sequenceOrder: number;
  estimatedWeeks: number | null;
  startDate: string | null;
  endDate: string | null;
  essentialQuestions: string[];
  standardCount: number;
  lessonCount: number;
  resourceCount: number;
  gapSummary: { complete: number; partial: number; notStarted: number };
}

export interface CurUnitStandardDto {
  id: string;
  unitId: string;
  standardId: string;
  standard: CurStandardDto;
  notes: string | null;
}

export interface CurUnitLessonDto {
  id: string;
  unitId: string;
  clsLessonId: string;
  lessonTitle: string;
  lessonDate: string | null;
  lessonStatus: string;
}

export interface CurResourceDto {
  id: string;
  unitId: string;
  resourceType: CurResourceType;
  title: string;
  description: string | null;
  url: string | null;
  s3Key: string | null;
  isTeacherOnly: boolean;
  uploadedBy: string;
  createdAt: string;
}

export interface CurDeliveryGapDto {
  id: string;
  unitId: string;
  unitTitle: string;
  curriculumMapId: string;
  standardId: string;
  standardCode: string;
  standardDescription: string;
  gapType: CurGapType;
  lessonsPlanned: number;
  lessonsDelivered: number;
  lastAssessedAt: string | null;
  computedAt: string;
}

export interface CurUnitDetailDto extends CurUnitDto {
  standards: CurUnitStandardDto[];
  lessons: CurUnitLessonDto[];
  resources: CurResourceDto[];
  gaps: CurDeliveryGapDto[];
}

export interface CurCreateUnitPayload {
  title: string;
  description?: string;
  estimatedWeeks?: number;
  startDate?: string;
  endDate?: string;
  essentialQuestions?: string[];
}

export interface CurUpdateUnitPayload {
  title?: string;
  description?: string;
  estimatedWeeks?: number;
  startDate?: string;
  endDate?: string;
  essentialQuestions?: string[];
}

export interface CurReorderUnitsPayload {
  order: Array<{ unitId: string; sequenceOrder: number }>;
}

export interface CurAlignStandardPayload {
  standardId: string;
  notes?: string;
}

export interface CurLinkLessonPayload {
  clsLessonId: string;
}

export interface CurCreateResourcePayload {
  resourceType: CurResourceType;
  title: string;
  description?: string;
  url?: string;
  s3Key?: string;
  isTeacherOnly?: boolean;
}

export interface CurUpdateResourcePayload {
  title?: string;
  description?: string;
  url?: string;
  isTeacherOnly?: boolean;
}

// ── Cycle 24: Student Portfolio ────────────────────────────────────

export type PortfolioVisibility = 'PRIVATE' | 'TEACHER' | 'PARENT' | 'PUBLIC';
export type PortfolioItemType =
  | 'SUBMISSION'
  | 'GRADE'
  | 'ACHIEVEMENT'
  | 'REFLECTION'
  | 'EXTERNAL_FILE'
  | 'CERTIFICATE';
export type ShareStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type AchievementType =
  | 'ACADEMIC'
  | 'SPORTING'
  | 'MUSICAL'
  | 'LEADERSHIP'
  | 'COMMUNITY'
  | 'CUSTOM';
export type AchievementSharePlatform = 'EMAIL' | 'SOCIAL' | 'PORTFOLIO';

export interface PortfolioItemDto {
  id: string;
  portfolioId: string;
  itemType: PortfolioItemType;
  sourceRefId: string | null;
  sourceTitle: string | null;
  title: string;
  description: string | null;
  s3Key: string | null;
  isFeatured: boolean;
  addedAt: string;
}

export interface PortfolioDto {
  id: string;
  studentId: string;
  studentName: string | null;
  schoolId: string;
  title: string;
  description: string | null;
  visibility: PortfolioVisibility;
  shareLinkEnabled: boolean;
  itemCount: number;
  achievementCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioDetailDto extends PortfolioDto {
  items: PortfolioItemDto[];
}

export interface CreatePortfolioPayload {
  title: string;
  description?: string;
  visibility?: PortfolioVisibility;
}

export interface UpdatePortfolioPayload {
  title?: string;
  description?: string;
  visibility?: PortfolioVisibility;
  shareLinkEnabled?: boolean;
}

export interface CreatePortfolioItemPayload {
  itemType: PortfolioItemType;
  sourceRefId?: string;
  title: string;
  description?: string;
  s3Key?: string;
  isFeatured?: boolean;
}

export interface UpdatePortfolioItemPayload {
  title?: string;
  description?: string;
  isFeatured?: boolean;
}

export interface ItemSourceCandidateDto {
  itemType: PortfolioItemType;
  sourceRefId: string;
  title: string;
  subtitle: string | null;
}

export interface ShareDto {
  id: string;
  portfolioId: string;
  shareToken: string;
  expiresAt: string | null;
  recipientEmail: string | null;
  viewedAt: string | null;
  status: ShareStatus;
  createdAt: string;
}

export interface CreateSharePayload {
  expiresAt?: string;
  recipientEmail?: string;
}

export interface AchievementDto {
  id: string;
  studentId: string;
  studentName: string | null;
  schoolId: string;
  title: string;
  achievementType: AchievementType;
  sourceModule: string | null;
  sourceRefId: string | null;
  awardedAt: string;
  awardedById: string | null;
  awardedByName: string | null;
  description: string | null;
  badgeImageUrl: string | null;
  shareCount: number;
  createdAt: string;
}

export interface CreateAchievementPayload {
  studentId: string;
  title: string;
  achievementType: AchievementType;
  sourceModule?: string;
  sourceRefId?: string;
  awardedAt?: string;
  description?: string;
  badgeImageUrl?: string;
}

export interface UpdateAchievementPayload {
  title?: string;
  description?: string;
  badgeImageUrl?: string;
}

export interface AchievementShareDto {
  id: string;
  achievementId: string;
  sharedById: string;
  platform: AchievementSharePlatform;
  sharedAt: string;
}

export interface CreateAchievementSharePayload {
  platform: AchievementSharePlatform;
}

export interface PublicPortfolioViewDto {
  portfolioId: string;
  studentName: string | null;
  title: string;
  description: string | null;
  schoolName: string | null;
  featuredItems: PortfolioItemDto[];
  items: PortfolioItemDto[];
  achievements: AchievementDto[];
}

// ── Cycle 25: Publications ────────────────────────────────────────

export type PubPublicationType =
  | 'NEWSLETTER'
  | 'BULLETIN'
  | 'ANNOUNCEMENT'
  | 'MAGAZINE'
  | 'PROGRAM'
  | 'REPORT';

export type PubFrequency =
  | 'DAILY'
  | 'WEEKLY'
  | 'FORTNIGHTLY'
  | 'MONTHLY'
  | 'TERMLY'
  | 'ANNUAL'
  | 'IRREGULAR';

export type PubStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';

export type PubCollaboratorRole = 'EDITOR' | 'CONTRIBUTOR' | 'REVIEWER' | 'VIEWER';

export type PubSectionType = 'ARTICLE' | 'ANNOUNCEMENT' | 'PHOTO_GALLERY' | 'CALENDAR' | 'CUSTOM';

export type PubRuleType = 'ROLE' | 'GRADE' | 'CLASS' | 'GROUP_MEMBERSHIP';

export type PubDeliveryStatus = 'PENDING' | 'DELIVERED' | 'OPENED' | 'BOUNCED';

export type PubSubscriptionStatus = 'SUBSCRIBED' | 'UNSUBSCRIBED';

export interface PubSeriesDto {
  id: string;
  schoolId: string;
  title: string;
  description: string | null;
  publicationType: PubPublicationType;
  frequency: PubFrequency;
  seriesLogoS3Key: string | null;
  isActive: boolean;
  createdById: string | null;
  createdByName: string | null;
  editionCount: number;
  subscriberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePubSeriesPayload {
  title: string;
  description?: string;
  publicationType: PubPublicationType;
  frequency: PubFrequency;
}

export interface PubEditionDto {
  id: string;
  seriesId: string;
  editionNumber: number;
  editionLabel: string | null;
  theme: string | null;
  coverImageS3Key: string | null;
  editorialNote: string | null;
  status: PubStatus;
  scheduledPublishAt: string | null;
  publishedAt: string | null;
  editorId: string | null;
  editorName: string | null;
  approvalRequestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePubEditionPayload {
  editionLabel?: string;
  theme?: string;
  editorialNote?: string;
}

export interface PubCollaboratorDto {
  id: string;
  publicationId: string;
  userId: string;
  userName: string | null;
  role: PubCollaboratorRole;
  invitedById: string | null;
  invitedAt: string;
  acceptedAt: string | null;
}

export interface PubPublicationDto {
  id: string;
  schoolId: string;
  title: string;
  publicationType: PubPublicationType;
  seriesId: string | null;
  seriesTitle: string | null;
  editionId: string | null;
  editionNumber: number | null;
  createdById: string | null;
  createdByName: string | null;
  status: PubStatus;
  scheduledPublishAt: string | null;
  publishedAt: string | null;
  approvalRequestId: string | null;
  sectionCount: number;
  pendingSectionCount: number;
  recipientCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PubPublicationDetailDto extends PubPublicationDto {
  collaborators: PubCollaboratorDto[];
}

export interface PubSectionContributorDto {
  id: string;
  sectionId: string;
  contributorId: string;
  contributorName: string | null;
  contributionNote: string | null;
  contributedAt: string;
}

export interface PubSectionDto {
  id: string;
  publicationId: string;
  title: string;
  body: string | null;
  sectionType: PubSectionType;
  ownerId: string | null;
  ownerName: string | null;
  sortOrder: number;
  isApproved: boolean;
  contributors: PubSectionContributorDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreatePubSectionPayload {
  title: string;
  body?: string;
  sectionType?: PubSectionType;
  ownerEmployeeId?: string;
  sortOrder?: number;
}

export interface UpdatePubSectionPayload {
  title?: string;
  body?: string;
  sortOrder?: number;
}

export interface PubSectionCommentDto {
  id: string;
  sectionId: string;
  authorId: string;
  authorName: string | null;
  body: string;
  isResolved: boolean;
  resolvedById: string | null;
  resolvedAt: string | null;
  parentCommentId: string | null;
  createdAt: string;
}

export interface PubDistributionRuleDto {
  id: string;
  distributionListId: string;
  ruleType: PubRuleType;
  ruleValue: string;
}

export interface PubDistributionListDto {
  id: string;
  publicationId: string;
  listName: string;
  isActive: boolean;
  rules: PubDistributionRuleDto[];
}

export interface CreatePubDistributionListPayload {
  listName: string;
  rules?: { ruleType: PubRuleType; ruleValue: string }[];
}

export interface PubDistributionStatusDto {
  publicationId: string;
  totalRecipients: number;
  pending: number;
  delivered: number;
  opened: number;
  bounced: number;
}

export interface PubAudiencePreviewDto {
  totalRecipients: number;
  excludedUnsubscribed: number;
  sampleNames: string[];
}

export interface PubSubscriptionDto {
  id: string;
  seriesId: string;
  seriesTitle: string | null;
  subscriberId: string;
  subscriberName: string | null;
  status: PubSubscriptionStatus;
  subscribedAt: string;
  unsubscribedAt: string | null;
}

export interface PubDistributeResultDto {
  totalRecipients: number;
  alreadyExisted: number;
  status: 'PUBLISHED';
}

// ─── Cycle 26 — Finance & Accounting (M83) ───

export type FinAccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type FinNormalBalance = 'DEBIT' | 'CREDIT';
export type FinFundType =
  | 'GENERAL'
  | 'SPECIAL_REVENUE'
  | 'CAPITAL_PROJECTS'
  | 'DEBT_SERVICE'
  | 'PERMANENT'
  | 'ENTERPRISE';
export type FinPeriodStatus = 'FUTURE' | 'OPEN' | 'CLOSED' | 'LOCKED';
export type FinBatchType =
  | 'MANUAL'
  | 'AUTO_PAYMENT'
  | 'AUTO_INVOICE'
  | 'AUTO_REFUND'
  | 'ADJUSTMENT';
export type FinBatchStatus = 'DRAFT' | 'POSTED' | 'VOIDED';
export type FinSupplierType = 'VENDOR' | 'CONTRACTOR' | 'UTILITY' | 'OTHER';
export type FinBudgetStatus = 'DRAFT' | 'APPROVED' | 'AMENDED';
export type FinAPStatus = 'PENDING' | 'APPROVED' | 'PAID' | 'VOIDED' | 'ON_HOLD';
export type FinPaymentMethod = 'CHECK' | 'ACH' | 'WIRE' | 'CREDIT_CARD';
export type FinReconStatus = 'IN_PROGRESS' | 'RECONCILED' | 'VARIANCE_FLAGGED';
export type FinReportType = 'BALANCE_SHEET' | 'INCOME_STATEMENT' | 'BUDGET_VS_ACTUAL' | 'CASH_FLOW';
export type FinGrantStatus = 'ACTIVE' | 'CLOSED' | 'REPORTING';

export interface FinFundDto {
  id: string;
  schoolId: string;
  fundCode: string;
  fundName: string;
  fundType: FinFundType;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FinAccountDto {
  id: string;
  schoolId: string;
  accountCode: string;
  accountName: string;
  accountType: FinAccountType;
  normalBalance: FinNormalBalance;
  parentAccountId: string | null;
  parentAccountCode: string | null;
  fundId: string | null;
  fundCode: string | null;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  runningBalance: number;
  createdAt: string;
  updatedAt: string;
}

export interface FinPeriodDto {
  id: string;
  schoolId: string;
  fiscalYear: string;
  periodNumber: number;
  periodName: string;
  startDate: string;
  endDate: string;
  status: FinPeriodStatus;
  closedAt: string | null;
  closedBy: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinTrialBalanceLineDto {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: FinAccountType;
  normalBalance: FinNormalBalance;
  debitTotal: number;
  creditTotal: number;
  balance: number;
}

export interface FinTrialBalanceDto {
  lines: FinTrialBalanceLineDto[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

export interface FinGLEntryDto {
  id: string;
  batchId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  fundId: string;
  fundCode: string;
  debit: number;
  credit: number;
  description: string | null;
  referenceType: string | null;
  referenceId: string | null;
  lineOrder: number;
}

export interface FinJournalBatchDto {
  id: string;
  schoolId: string;
  batchNumber: string;
  description: string;
  batchType: FinBatchType;
  sourceModule: string | null;
  sourceEventId: string | null;
  accountingPeriodId: string;
  periodName: string;
  postedBy: string | null;
  postedByName: string | null;
  postedAt: string | null;
  status: FinBatchStatus;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  totalDebit: number;
  totalCredit: number;
  entries: FinGLEntryDto[];
  createdAt: string;
  updatedAt: string;
}

export interface FinSupplierDto {
  id: string;
  schoolId: string;
  supplierCode: string;
  supplierName: string;
  supplierType: FinSupplierType;
  taxId: string | null;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  paymentTerms: string | null;
  isActive: boolean;
  notes: string | null;
  contacts: Array<{
    id: string;
    contactName: string;
    email: string | null;
    phone: string | null;
    role: string | null;
    isPrimary: boolean;
  }>;
}

export interface FinBudgetLineDto {
  id: string;
  budgetId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  budgetedAmount: number;
  actualAmount: number;
  encumberedAmount: number;
  remainingAmount: number;
  notes: string | null;
}

export interface FinBudgetDto {
  id: string;
  schoolId: string;
  fiscalYear: string;
  fundId: string;
  fundCode: string;
  name: string;
  totalRevenue: number;
  totalExpense: number;
  status: FinBudgetStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  lines: FinBudgetLineDto[];
}

export interface FinAPVoucherDto {
  id: string;
  schoolId: string;
  supplierId: string;
  supplierName: string;
  voucherNumber: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  dueDate: string;
  totalAmount: number;
  description: string | null;
  glAccountId: string | null;
  glAccountCode: string | null;
  fundId: string | null;
  status: FinAPStatus;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  amountPaid: number;
  balanceDue: number;
}

export interface FinAPPaymentDto {
  id: string;
  voucherId: string;
  paymentMethod: FinPaymentMethod;
  paymentReference: string | null;
  amount: number;
  paidAt: string;
  paidBy: string;
  paidByName: string | null;
  journalBatchId: string | null;
  notes: string | null;
}

export interface FinReconciliationDto {
  id: string;
  schoolId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  periodId: string;
  periodName: string;
  glBalance: number;
  bankBalance: number;
  difference: number;
  outstandingItems: unknown;
  status: FinReconStatus;
  reconciledBy: string | null;
  reconciledAt: string | null;
  notes: string | null;
}

export interface FinBoardReportDto {
  id: string;
  schoolId: string;
  reportType: FinReportType;
  periodId: string | null;
  periodName: string | null;
  generatedAt: string;
  generatedBy: string;
  generatedByName: string | null;
  reportData: unknown;
  s3Key: string | null;
}

export interface FinGrantDto {
  id: string;
  schoolId: string;
  fundId: string | null;
  fundCode: string | null;
  grantName: string;
  grantor: string;
  grantNumber: string | null;
  awardAmount: number;
  drawnAmount: number;
  remainingAmount: number;
  startDate: string;
  endDate: string;
  status: FinGrantStatus;
  reportingDueDate: string | null;
  notes: string | null;
}

// ─── Cycle 27 — Procurement (M86) ───

export type PrcUrgency = 'ROUTINE' | 'URGENT' | 'EMERGENCY';
export type PrcReqStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'DEPT_APPROVED'
  | 'ADMIN_APPROVED'
  | 'DISTRICT_APPROVED'
  | 'ORDERED'
  | 'RECEIVED'
  | 'DISTRIBUTED'
  | 'CLOSED'
  | 'REJECTED';
export type PrcDestinationModule =
  | 'tech'
  | 'trn'
  | 'fds'
  | 'lib'
  | 'ath'
  | 'ext'
  | 'fac'
  | 'str'
  | 'general';
export type PrcDistDestinationModule = Exclude<PrcDestinationModule, 'general'>;
export type PrcPOStatus =
  | 'DRAFT'
  | 'ISSUED'
  | 'ACKNOWLEDGED'
  | 'SHIPPED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED';
export type PrcInspectionOutcome = 'ACCEPTED' | 'ACCEPTED_WITH_DISCREPANCY' | 'REJECTED';
export type PrcReceiptCondition = 'GOOD' | 'DAMAGED' | 'DEFECTIVE';
export type PrcCommitmentStatus = 'COMMITTED' | 'PARTIALLY_RELEASED' | 'RELEASED';
export type PrcReturnType = 'DAMAGED' | 'DEFECTIVE' | 'WARRANTY_CLAIM';
export type PrcReturnStatus = 'INITIATED' | 'SHIPPED_TO_VENDOR' | 'RESOLVED' | 'CANCELLED';
export type PrcReturnResolution = 'REPLACED' | 'REFUNDED' | 'CREDITED';

export interface PrcRequisitionLineDto {
  id: string;
  requisitionId: string;
  itemDescription: string;
  quantity: number;
  unit: string | null;
  estimatedUnitCost: number | null;
  specifications: string | null;
  preferredVendorId: string | null;
  preferredVendorName: string | null;
  destinationModule: PrcDestinationModule;
  lineOrder: number;
}

export interface PrcRequisitionDto {
  id: string;
  schoolId: string;
  requestingPersonId: string;
  requestingPersonName: string | null;
  requestingDepartment: string | null;
  urgency: PrcUrgency;
  status: PrcReqStatus;
  approvalRequestId: string | null;
  totalEstimatedCost: number;
  budgetLineId: string | null;
  budgetAccountCode: string | null;
  justification: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  rejectionReason: string | null;
  lines: PrcRequisitionLineDto[];
  createdAt: string;
  updatedAt: string;
}

export interface PrcCreateRequisitionLine {
  itemDescription: string;
  quantity: number;
  unit?: string;
  estimatedUnitCost?: number;
  specifications?: string;
  preferredVendorId?: string;
  destinationModule: PrcDestinationModule;
}

export interface PrcCreateRequisitionPayload {
  requestingDepartment?: string;
  urgency?: PrcUrgency;
  budgetLineId?: string;
  justification: string;
  lines: PrcCreateRequisitionLine[];
}

export interface PrcPurchaseOrderLineDto {
  id: string;
  purchaseOrderId: string;
  requisitionLineId: string | null;
  itemDescription: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: number;
  lineTotal: number;
  glAccountId: string | null;
  glAccountCode: string | null;
  destinationModule: PrcDestinationModule;
  lineOrder: number;
}

export interface PrcBudgetCommitmentDto {
  id: string;
  purchaseOrderId: string;
  budgetLineId: string;
  budgetAccountCode: string | null;
  committedAmount: number;
  releasedAmount: number;
  status: PrcCommitmentStatus;
  releasedAt: string | null;
}

export interface PrcPurchaseOrderDto {
  id: string;
  schoolId: string;
  poNumber: string;
  vendorId: string;
  vendorName: string | null;
  requisitionId: string | null;
  deliveryAddress: string;
  expectedDeliveryDate: string | null;
  paymentTerms: string | null;
  status: PrcPOStatus;
  totalAmount: number;
  notes: string | null;
  issuedBy: string | null;
  issuedByName: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lines: PrcPurchaseOrderLineDto[];
  commitments: PrcBudgetCommitmentDto[];
  createdAt: string;
  updatedAt: string;
}

export interface PrcCreatePOLine {
  requisitionLineId?: string;
  itemDescription: string;
  quantityOrdered: number;
  unitCost: number;
  glAccountId?: string;
  destinationModule: PrcDestinationModule;
}

export interface PrcCreatePurchaseOrderPayload {
  vendorId: string;
  requisitionId?: string;
  deliveryAddress: string;
  expectedDeliveryDate?: string;
  paymentTerms?: string;
  notes?: string;
  budgetLineId?: string;
  lines: PrcCreatePOLine[];
}

export interface PrcReceiptLineDto {
  id: string;
  receiptId: string;
  poLineId: string;
  poItemDescription: string;
  quantityReceived: number;
  quantityAccepted: number;
  quantityRejected: number;
  condition: PrcReceiptCondition;
  discrepancyNotes: string | null;
}

export interface PrcGoodsReceiptDto {
  id: string;
  purchaseOrderId: string;
  poNumber: string;
  receivedBy: string;
  receivedByName: string | null;
  receivedAt: string;
  inspectionOutcome: PrcInspectionOutcome;
  notes: string | null;
  lines: PrcReceiptLineDto[];
}

export interface PrcCreateReceiptLine {
  poLineId: string;
  quantityReceived: number;
  quantityAccepted: number;
  quantityRejected: number;
  condition: PrcReceiptCondition;
  discrepancyNotes?: string;
}

export interface PrcCreateGoodsReceiptPayload {
  inspectionOutcome: PrcInspectionOutcome;
  notes?: string;
  lines: PrcCreateReceiptLine[];
}

export interface PrcDistributionLineDto {
  id: string;
  distributionId: string;
  receiptLineId: string;
  quantityDistributed: number;
  itemDescription: string;
  unitCost: number | null;
}

export interface PrcDistributionDto {
  id: string;
  receiptId: string;
  distributedBy: string;
  distributedByName: string | null;
  distributedAt: string;
  destinationModule: PrcDistDestinationModule;
  destinationDepartment: string | null;
  notes: string | null;
  lines: PrcDistributionLineDto[];
}

export interface PrcCreateDistributionLine {
  receiptLineId: string;
  quantityDistributed: number;
  itemDescription: string;
  unitCost?: number;
}

export interface PrcCreateDistributionPayload {
  destinationModule: PrcDistDestinationModule;
  destinationDepartment?: string;
  notes?: string;
  lines: PrcCreateDistributionLine[];
}

export interface PrcReturnDto {
  id: string;
  receiptLineId: string;
  returnType: PrcReturnType;
  quantityReturned: number;
  returnReference: string | null;
  vendorRmaNumber: string | null;
  status: PrcReturnStatus;
  resolution: PrcReturnResolution | null;
  resolutionNotes: string | null;
  initiatedBy: string;
  initiatedByName: string | null;
  initiatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface PrcCreateReturnPayload {
  returnType: PrcReturnType;
  quantityReturned: number;
  returnReference?: string;
  vendorRmaNumber?: string;
}

export interface PrcUpdateReturnPayload {
  action: 'SHIP' | 'RESOLVE' | 'CANCEL';
  resolution?: PrcReturnResolution;
  resolutionNotes?: string;
}

export interface PrcVendorPerformanceDto {
  id: string;
  vendorId: string;
  vendorName: string | null;
  schoolId: string;
  totalOrders: number;
  onTimeDeliveries: number;
  lateDeliveries: number;
  acceptedCount: number;
  rejectedCount: number;
  averageQualityScore: number | null;
  averageDeliveryScore: number | null;
  lastUpdatedAt: string;
}

export interface PrcProcurementSettingsDto {
  id: string;
  schoolId: string;
  autoPoThreshold: number | null;
  defaultPaymentTerms: string;
  poNumberPrefix: string;
  poNumberNextSeq: number;
  requireThreeQuotesAbove: number | null;
}

export interface PrcUpdateSettingsPayload {
  autoPoThreshold?: number;
  defaultPaymentTerms?: string;
  poNumberPrefix?: string;
  requireThreeQuotesAbove?: number;
}

// ─── Cycle 28 — School Store (M67) ───

export type StrStoreType = 'STUDENT' | 'PUBLIC';
export type StrOrderType = 'STUDENT' | 'PARENT' | 'EXTERNAL';
export type StrOrderStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PROCESSING'
  | 'READY_FOR_PICKUP'
  | 'SHIPPED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'BACKORDERED';
export type StrShippingMethod = 'PICKUP' | 'SHIPPED';
export type StrPaymentStatus = 'PENDING' | 'CHARGED' | 'DEFERRED_BACKORDER' | 'REFUNDED';
export type StrLineStatus = 'IN_STOCK' | 'BACKORDERED' | 'FULFILLED' | 'CANCELLED';
export type StrApprovalStatus = 'PENDING' | 'APPROVED' | 'DECLINED';
export type StrLocationType = 'BUILDING' | 'DISTRICT';

export interface StrStoreDto {
  id: string;
  schoolId: string;
  storeType: StrStoreType;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StrInventoryRowDto {
  id: string;
  productId: string;
  locationType: StrLocationType;
  locationId: string;
  quantityOnHand: number;
  quantityReserved: number;
  reorderPoint: number;
  reorderQuantity: number;
}

export interface StrProductDto {
  id: string;
  storeId: string;
  name: string;
  description: string | null;
  sku: string | null;
  category: string | null;
  price: number;
  cost: number | null;
  imageS3Keys: string[];
  isActive: boolean;
  backorderAllowed: boolean;
  preferredSupplierId: string | null;
  inventory: StrInventoryRowDto[];
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
  createdAt: string;
  updatedAt: string;
}

export interface StrOrderLineDto {
  id: string;
  orderId: string;
  productId: string;
  productName: string | null;
  productSku: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  lineStatus: StrLineStatus;
}

export interface StrOrderApprovalDto {
  id: string;
  orderId: string;
  parentPersonId: string;
  parentName: string | null;
  status: StrApprovalStatus;
  requestedAt: string;
  respondedAt: string | null;
  declineReason: string | null;
}

export interface StrOrderDto {
  id: string;
  storeId: string;
  storeName: string | null;
  orderType: StrOrderType;
  customerPersonId: string | null;
  customerName: string | null;
  externalCustomerId: string | null;
  externalCustomerName: string | null;
  studentId: string | null;
  studentName: string | null;
  orderNumber: string;
  orderDate: string;
  status: StrOrderStatus;
  subtotal: number;
  shippingCost: number;
  total: number;
  shippingMethod: StrShippingMethod;
  shippingOptionId: string | null;
  shippingOptionName: string | null;
  trackingNumber: string | null;
  paymentStatus: StrPaymentStatus;
  notes: string | null;
  lines: StrOrderLineDto[];
  approval: StrOrderApprovalDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface StrCreateOrderLine {
  productId: string;
  quantity: number;
}

export interface StrCreateOrderPayload {
  storeId: string;
  orderType: StrOrderType;
  studentId?: string;
  externalCustomerId?: string;
  shippingOptionId?: string;
  shippingMethod: StrShippingMethod;
  notes?: string;
  lines: StrCreateOrderLine[];
}

export interface StrFulfilOrderPayload {
  toStatus: 'READY_FOR_PICKUP' | 'SHIPPED';
  trackingNumber?: string;
}

export interface StrAdjustInventoryPayload {
  quantityOnHand: number;
  reorderPoint?: number;
  reorderQuantity?: number;
}

export interface StrCreateProductPayload {
  storeId: string;
  name: string;
  description?: string;
  sku?: string;
  category?: string;
  price: number;
  cost?: number;
  imageS3Keys?: string[];
  backorderAllowed?: boolean;
  preferredSupplierId?: string;
}

export interface StrUpdateProductPayload {
  name?: string;
  description?: string;
  sku?: string;
  category?: string;
  price?: number;
  cost?: number;
  imageS3Keys?: string[];
  isActive?: boolean;
  backorderAllowed?: boolean;
  preferredSupplierId?: string;
}

export interface StrShippingOptionDto {
  id: string;
  storeId: string;
  methodName: string;
  estimatedDays: number | null;
  flatRate: number;
  isActive: boolean;
}

export interface StrCreateShippingOptionPayload {
  storeId: string;
  methodName: string;
  estimatedDays?: number;
  flatRate: number;
}

export interface StrExternalCustomerDto {
  id: string;
  schoolId: string;
  name: string;
  email: string;
  phone: string | null;
  shippingAddress: string | null;
  notes: string | null;
  createdAt: string;
}

export interface StrCreateExternalCustomerPayload {
  name: string;
  email: string;
  phone?: string;
  shippingAddress?: string;
  notes?: string;
}

export interface StrInventoryDashboardRow {
  productId: string;
  productName: string;
  sku: string | null;
  storeName: string;
  storeType: StrStoreType;
  locationType: StrLocationType;
  locationId: string;
  quantityOnHand: number;
  quantityReserved: number;
  reorderPoint: number;
  reorderQuantity: number;
  atOrBelowReorder: boolean;
}

export interface StrRevenueRowDto {
  id: string;
  storeId: string;
  storeName: string | null;
  periodStart: string;
  periodEnd: string;
  totalOrders: number;
  totalRevenue: number;
  totalCost: number;
  grossMargin: number;
  computedAt: string;
}

export interface StrMaterialiseRevenuePayload {
  storeId: string;
  periodStart: string;
  periodEnd: string;
}

// ─── Cycle 29: Analytics & Reporting (M110) ────────────────────────────

export interface RptAttendanceSummaryDto {
  id: string;
  schoolId: string;
  classId: string;
  className: string | null;
  summaryDate: string;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  totalEnrolled: number;
  attendanceRate: number | null;
  generatedAt: string;
}

export interface RptStudentAcademicDto {
  id: string;
  studentId: string;
  studentName: string | null;
  gradeLevel: string | null;
  academicYearId: string;
  schoolId: string;
  currentGpa: number | null;
  creditsEarned: number;
  creditsAttempted: number;
  attendanceRate: number | null;
  totalAssignments: number;
  completedAssignments: number;
  atRiskFlags: Record<string, unknown>;
  generatedAt: string;
}

export interface RptClassPerformanceDto {
  id: string;
  classId: string;
  className: string | null;
  termId: string;
  schoolId: string;
  avgGrade: number | null;
  medianGrade: number | null;
  gradeDistribution: Record<string, number>;
  assignmentCompletionRate: number | null;
  studentCount: number;
  generatedAt: string;
}

export interface RptStaffSummaryDto {
  id: string;
  employeeId: string;
  employeeName: string | null;
  academicYearId: string;
  schoolId: string;
  classesTaught: number;
  totalStudents: number;
  leaveDaysTaken: number;
  avgClassPerformance: number | null;
  generatedAt: string;
}

export interface RptSchoolSummaryDto {
  id: string;
  schoolId: string;
  schoolName: string | null;
  academicYearId: string;
  totalEnrolled: number;
  totalStaff: number;
  avgAttendanceRate: number | null;
  avgGpa: number | null;
  atRiskCount: number;
  incidentCount: number;
  generatedAt: string;
}

export interface RptDistrictSummaryDto {
  id: string;
  organisationId: string;
  academicYearId: string;
  schoolCount: number;
  totalEnrolled: number;
  totalStaff: number;
  avgAttendanceRate: number | null;
  avgGpa: number | null;
  totalAtRisk: number;
  totalIncidents: number;
  generatedAt: string;
}

export interface RptDistrictSchoolComparisonDto {
  id: string;
  organisationId: string;
  academicYearId: string;
  schoolId: string;
  schoolName: string | null;
  rankByAttendance: number | null;
  rankByPerformance: number | null;
  metrics: Record<string, unknown>;
  generatedAt: string;
}

export interface RptWellbeingTrendsDto {
  id: string;
  schoolId: string;
  gradeLevel: string;
  periodStart: string;
  periodEnd: string;
  avgWellbeingScore: number | null;
  responseCount: number;
  wantsToTalkCount: number;
  flaggedCount: number;
  generatedAt: string;
}

export interface RptAgedDebtorDto {
  id: string;
  schoolId: string;
  familyAccountId: string;
  accountHolderName: string | null;
  totalOutstanding: number;
  currentBucket: number;
  days30: number;
  days60: number;
  days90Plus: number;
  lastPaymentDate: string | null;
  generatedAt: string;
}

export interface RptAtRiskStudentDto {
  studentId: string;
  studentName: string | null;
  gradeLevel: string | null;
  academicYearId: string;
  currentGpa: number | null;
  attendanceRate: number | null;
  totalAssignments: number;
  completedAssignments: number;
  atRiskFlags: Record<string, unknown>;
  flaggedConfigs: string[];
}

export interface RptAtRiskConfigDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  triggerConditions: Record<string, unknown>;
  alertRecipients: string[];
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RptCreateAtRiskConfigPayload {
  name: string;
  description?: string;
  triggerConditions: Record<string, unknown>;
  alertRecipients?: string[];
  isActive?: boolean;
}

export interface RptUpdateAtRiskConfigPayload {
  name?: string;
  description?: string;
  triggerConditions?: Record<string, unknown>;
  alertRecipients?: string[];
  isActive?: boolean;
}

export interface RptWorkerStatusDto {
  consumerGroup: string;
  topic: string;
  partition: number;
  committedOffset: number;
  logEndOffset: number | null;
  lag: number | null;
  recordedAt: string;
}

export interface RptWorkerRunSummaryDto {
  worker: string;
  status: 'OK' | 'FAILED' | 'SKIPPED';
  rowsWritten: number;
  durationMs: number;
  errorMessage?: string | null;
}

export type RptReportRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED';
export type RptOutputFormat = 'CSV' | 'PDF' | 'XLSX';
export type RptDeliveryChannel = 'EMAIL' | 'IN_APP' | 'BOTH';

export interface RptReportDefinitionDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  reportType: string;
  templateConfig: Record<string, unknown>;
  isStateReport: boolean;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RptCreateReportDefinitionPayload {
  name: string;
  description?: string;
  reportType: string;
  templateConfig: Record<string, unknown>;
  isActive?: boolean;
}

export interface RptUpdateReportDefinitionPayload {
  name?: string;
  description?: string;
  reportType?: string;
  templateConfig?: Record<string, unknown>;
  isActive?: boolean;
}

export interface RptReportRunDto {
  id: string;
  reportDefinitionId: string;
  reportName: string | null;
  runBy: string | null;
  runByName: string | null;
  status: RptReportRunStatus;
  outputFormat: RptOutputFormat;
  outputS3Key: string | null;
  rowCount: number | null;
  errorMessage: string | null;
  startedAt: string;
  generatedAt: string | null;
}

export interface RptScheduledReportDto {
  id: string;
  schoolId: string;
  reportName: string;
  templateName: string;
  reportParams: Record<string, unknown>;
  scheduleCron: string;
  timezone: string;
  deliveryChannel: RptDeliveryChannel;
  recipientIds: string[];
  outputFormat: RptOutputFormat;
  isActive: boolean;
  lastRunAt: string | null;
  lastRunStatus: 'SUCCESS' | 'FAILED' | null;
  nextRunAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RptCreateScheduledReportPayload {
  reportName: string;
  templateName: string;
  reportParams?: Record<string, unknown>;
  scheduleCron: string;
  timezone?: string;
  deliveryChannel?: RptDeliveryChannel;
  recipientIds?: string[];
  outputFormat?: RptOutputFormat;
  isActive?: boolean;
}

export interface RptStateReportTemplateDto {
  id: string;
  stateCode: string;
  reportType: string;
  schemaVersion: string;
  templateConfig: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── P2C1 Visitor Management ─────────────────────────────────────

export type VisitorBadgeColor = 'blue' | 'green' | 'amber' | 'rose' | 'purple' | 'gray';
export type SafeguardingStatus = 'PASSED' | 'FLAGGED' | 'BYPASSED_BY_ADMIN' | 'NOT_REQUIRED';
export type BanType =
  | 'COURT_ORDER'
  | 'SCHOOL_DECISION'
  | 'SAFEGUARDING'
  | 'RESTRAINING_ORDER'
  | 'OTHER';
export type DrillType =
  | 'FIRE_DRILL'
  | 'LOCKDOWN'
  | 'EVACUATION'
  | 'BOMB_THREAT'
  | 'WEATHER'
  | 'OTHER';
export type MusterEntryStatus = 'UNKNOWN' | 'ACCOUNTED_FOR' | 'EVACUATED' | 'ASSISTANCE_NEEDED';
export type ScheduleDay = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

export interface VisitorTypeDto {
  id: string;
  schoolId: string;
  name: string;
  description?: string | null;
  requiresSafeguardingCheck: boolean;
  badgeColor: VisitorBadgeColor;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVisitorTypePayload {
  name: string;
  description?: string;
  requiresSafeguardingCheck?: boolean;
  badgeColor?: VisitorBadgeColor;
}

export interface UpdateVisitorTypePayload {
  name?: string;
  description?: string;
  requiresSafeguardingCheck?: boolean;
  badgeColor?: VisitorBadgeColor;
  isActive?: boolean;
}

export interface VisitorDto {
  id: string;
  schoolId: string;
  visitorTypeId: string;
  visitorTypeName?: string;
  badgeColor?: VisitorBadgeColor;
  requiresSafeguardingCheck?: boolean;
  firstName: string;
  lastName: string;
  company?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VisitorDetailDto extends VisitorDto {
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export interface SignInDto {
  id: string;
  schoolId: string;
  visitorId: string;
  visitorName: string;
  visitorCompany?: string | null;
  visitorTypeName: string;
  badgeColor: VisitorBadgeColor;
  signedInAt: string;
  signedOutAt?: string | null;
  hostId?: string | null;
  hostName?: string | null;
  purpose?: string | null;
  buildingId?: string | null;
  preRegistrationId?: string | null;
  badgeNumber?: string | null;
  safeguardingCheckStatus: SafeguardingStatus;
  safeguardingCheckRef?: string | null;
  bypassAdminId?: string | null;
  bypassAdminName?: string | null;
  bypassReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSignInPayload {
  visitorId?: string;
  visitorTypeId?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  hostId?: string;
  purpose?: string;
  buildingId?: string;
  badgeNumber?: string;
  safeguardingCheckRef?: string;
}

export interface BypassSafeguardingPayload {
  reason: string;
}

export interface PreRegistrationDto {
  id: string;
  schoolId: string;
  visitorId: string;
  visitorName: string;
  visitorCompany?: string | null;
  expectedAt: string;
  purpose?: string | null;
  hostId?: string | null;
  hostName?: string | null;
  qrCodeToken: string;
  expiresAt: string;
  usedAt?: string | null;
  createdBy: string;
  createdAt: string;
}

export interface CreatePreRegistrationPayload {
  visitorId?: string;
  visitorTypeId?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  email?: string;
  phone?: string;
  expectedAt: string;
  purpose?: string;
  hostId?: string;
  expiresInDays?: number;
}

export interface AccessSchedule {
  days: ScheduleDay[];
  timeStart: string;
  timeEnd: string;
}

export interface RecurringVisitorDto {
  id: string;
  schoolId: string;
  visitorId: string;
  visitorName: string;
  visitorCompany?: string | null;
  accessSchedule: AccessSchedule;
  validFrom: string;
  validTo?: string | null;
  approvedBy: string;
  approvedByName?: string | null;
  notes?: string | null;
  isActive: boolean;
}

export interface CreateRecurringVisitorPayload {
  visitorId: string;
  accessSchedule: AccessSchedule;
  validFrom: string;
  validTo?: string;
  notes?: string;
}

export interface BannedPersonDto {
  id: string;
  schoolId: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string | null;
  photoS3Key?: string | null;
  banReason: string;
  banType: BanType;
  banOrderS3Key?: string | null;
  addedBy: string;
  addedByName?: string | null;
  reviewedBy?: string | null;
  reviewedByName?: string | null;
  lastReviewedAt?: string | null;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface CreateBannedPersonPayload {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  banReason: string;
  banType: BanType;
  banOrderS3Key?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  notes?: string;
}

export interface UpdateBannedPersonPayload {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string | null;
  banReason?: string;
  banType?: BanType;
  banOrderS3Key?: string | null;
  isActive?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  notes?: string | null;
  markReviewed?: boolean;
}

export interface MusterDto {
  id: string;
  schoolId: string;
  drillType: DrillType;
  description?: string | null;
  incidentId?: string | null;
  createdBy: string;
  createdByName?: string | null;
  totalOnSiteAtSnapshot: number;
  closedAt?: string | null;
  closedBy?: string | null;
  createdAt: string;
}

export interface MusterEntryDto {
  id: string;
  musterId: string;
  signInId: string;
  visitorName: string;
  visitorType: string;
  visitorCompany?: string | null;
  building?: string | null;
  status: MusterEntryStatus;
  notes?: string | null;
  markedBy?: string | null;
  markedByName?: string | null;
  markedAt?: string | null;
  createdAt: string;
}

export interface MusterSummaryDto {
  total: number;
  unknown: number;
  accountedFor: number;
  evacuated: number;
  assistanceNeeded: number;
}

export interface MusterDetailDto {
  muster: MusterDto;
  entries: MusterEntryDto[];
  summary: MusterSummaryDto;
}

export interface CreateMusterPayload {
  drillType?: DrillType;
  description?: string;
  incidentId?: string;
}

export interface UpdateMusterEntryPayload {
  status: MusterEntryStatus;
  notes?: string;
}

export interface SignInSettingsDto {
  id: string;
  schoolId: string;
  requirePhotoId: boolean;
  requirePurpose: boolean;
  autoSignOutHours: number;
  safeguardingProvider?: string | null;
  badgeTemplate: 'STANDARD' | 'COMPACT' | 'PHOTO';
  kioskWelcomeMessage?: string | null;
  updatedAt: string;
}

export interface UpdateSignInSettingsPayload {
  requirePhotoId?: boolean;
  requirePurpose?: boolean;
  autoSignOutHours?: number;
  safeguardingProvider?: string;
  badgeTemplate?: 'STANDARD' | 'COMPACT' | 'PHOTO';
  kioskWelcomeMessage?: string;
}

// ----- P2C2 Incident & Emergency DTOs ---------------------------------------

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type EmergencyIncidentStatus = 'ACTIVE' | 'RESOLVED' | 'CANCELLED';
export type ProcedureType =
  | 'FIRE_EVACUATION'
  | 'LOCKDOWN'
  | 'SHELTER_IN_PLACE'
  | 'MEDICAL_EMERGENCY'
  | 'BOMB_THREAT'
  | 'HAZMAT'
  | 'MISSING_STUDENT'
  | 'SAFEGUARDING_CRISIS'
  | 'GENERAL';
export type AccountabilityPersonType = 'STUDENT' | 'STAFF' | 'VISITOR';
export type AccountabilityStatus =
  | 'UNKNOWN'
  | 'ACCOUNTED_FOR'
  | 'EVACUATED'
  | 'MEDICAL_ASSISTANCE'
  | 'MISSING';
export type DrillStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
export type NonDisciplineIncidentType =
  | 'STUDENT_INJURY'
  | 'STAFF_INJURY'
  | 'MEDICAL_EPISODE'
  | 'PROPERTY_DAMAGE'
  | 'ENVIRONMENTAL'
  | 'SECURITY'
  | 'OTHER';
export type NonDisciplineSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export type NonDisciplineStatus = 'OPEN' | 'UNDER_REVIEW' | 'CLOSED';

export interface IncidentTypeDto {
  id: string;
  schoolId: string | null;
  code: string;
  name: string;
  severity: IncidentSeverity;
  requiresLockdown: boolean;
  notificationTemplate: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIncidentTypePayload {
  code: string;
  name: string;
  severity: IncidentSeverity;
  requiresLockdown?: boolean;
  notificationTemplate?: string;
}

export interface UpdateIncidentTypePayload {
  name?: string;
  severity?: IncidentSeverity;
  requiresLockdown?: boolean;
  notificationTemplate?: string;
  isActive?: boolean;
}

export interface ProcedureStepDto {
  stepNumber: number;
  action: string;
  responsibleRole?: string;
  timeTargetSeconds?: number;
}

export interface ExternalContactDto {
  agency: string;
  phone: string;
  notes?: string;
}

export interface AssemblyPointDto {
  name: string;
  priority: number;
  capacity?: number;
}

export interface ProcedureDto {
  id: string;
  schoolId: string;
  procedureType: ProcedureType;
  title: string;
  procedureSteps: ProcedureStepDto[];
  primaryContactId: string;
  secondaryContactId: string | null;
  externalContacts: ExternalContactDto[] | null;
  assemblyPoints: AssemblyPointDto[] | null;
  lastReviewedAt: string;
  reviewedBy: string;
  nextReviewDate: string;
  isActive: boolean;
  procedureDocumentS3Key: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProcedurePayload {
  procedureType: ProcedureType;
  title: string;
  procedureSteps: ProcedureStepDto[];
  primaryContactId: string;
  secondaryContactId?: string;
  externalContacts?: ExternalContactDto[];
  assemblyPoints?: AssemblyPointDto[];
  lastReviewedAt: string;
  nextReviewDate: string;
  reviewedBy: string;
  procedureDocumentS3Key?: string;
}

export interface UpdateProcedurePayload extends Partial<CreateProcedurePayload> {
  isActive?: boolean;
}

export interface OutboxStatusDto {
  id: string;
  incidentId: string;
  declaredAt: string;
  tasksCreatedAt: string | null;
  musterTakenAt: string | null;
  alertSentAt: string | null;
  lastAttemptAt: string | null;
  attemptCount: number;
  lastError: string | null;
}

export interface IncidentDto {
  id: string;
  schoolId: string;
  incidentTypeId: string | null;
  incidentTypeCode: string | null;
  incidentTypeName: string | null;
  severity: IncidentSeverity | null;
  declaredBy: string;
  declaredByName: string | null;
  declaredAt: string;
  title: string | null;
  description: string | null;
  status: EmergencyIncidentStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  updatedAt: string;
  requiresLockdown: boolean | null;
  outboxStatus: OutboxStatusDto | null;
}

export interface DeclareIncidentPayload {
  incidentTypeId: string;
  title?: string;
  description?: string;
}

export interface ResolveIncidentPayload {
  resolutionNotes?: string;
}

export interface TimelineEntryDto {
  id: string;
  incidentId: string;
  recordedBy: string;
  recordedByName: string | null;
  eventType: string;
  description: string;
  metadata: Record<string, unknown> | null;
  recordedAt: string;
}

export interface CreateTimelineEntryPayload {
  eventType: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface AccountabilityRecordDto {
  id: string;
  incidentId: string;
  personId: string;
  personType: AccountabilityPersonType;
  status: AccountabilityStatus;
  lastUpdatedBy: string | null;
  lastUpdatedAt: string | null;
  notes: string | null;
  createdAt: string;
  personName: string | null;
}

export interface AccountabilitySummaryDto {
  incidentId: string;
  totalPeople: number;
  accountedFor: number;
  unknown: number;
  evacuated: number;
  medicalAssistance: number;
  missing: number;
  lastUpdatedAt: string;
}

export interface UpdateAccountabilityPayload {
  status: AccountabilityStatus;
  notes?: string;
}

export interface BulkUpdateAccountabilityPayload {
  recordIds: string[];
  status: AccountabilityStatus;
  notes?: string;
}

export interface ReunificationCorrectionDto {
  id: string;
  reunificationRecordId: string;
  correctedBy: string;
  correctedByName: string | null;
  correctionReason: string;
  correctedAt: string;
}

export interface ReunificationRecordDto {
  id: string;
  incidentId: string;
  studentId: string;
  studentName: string | null;
  releasedToId: string;
  releasedToName: string | null;
  releasedBy: string;
  releasedByName: string | null;
  releasedAt: string;
  notes: string | null;
  corrections: ReunificationCorrectionDto[];
}

export interface CreateReunificationPayload {
  studentId: string;
  releasedToId: string;
  notes?: string;
}

export interface CorrectReunificationPayload {
  correctionReason: string;
}

export interface DrillDto {
  id: string;
  schoolId: string;
  incidentTypeId: string | null;
  procedureType: ProcedureType;
  scheduledAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
  participationRate: number | null;
  notes: string | null;
  status: DrillStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OverdueDrillDto {
  procedureType: ProcedureType;
  lastCompletedAt: string | null;
  daysSinceLastDrill: number;
}

export interface CreateDrillPayload {
  procedureType: ProcedureType;
  incidentTypeId?: string;
  scheduledAt: string;
  notes?: string;
}

export interface CompleteDrillPayload {
  completedAt: string;
  durationSeconds: number;
  participationRate: number;
  notes?: string;
}

export interface CancelDrillPayload {
  notes?: string;
}

export interface NonDisciplineIncidentDto {
  id: string;
  schoolId: string;
  incidentType: NonDisciplineIncidentType;
  location: string | null;
  incidentDate: string;
  description: string;
  studentsInvolved: string[];
  staffInvolved: string[];
  witnesses: string | null;
  reportedBy: string;
  reportedByName: string | null;
  severity: NonDisciplineSeverity;
  followUpTicketId: string | null;
  resolution: string | null;
  status: NonDisciplineStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNonDisciplinePayload {
  incidentType: NonDisciplineIncidentType;
  location?: string;
  incidentDate: string;
  description: string;
  studentsInvolved?: string[];
  staffInvolved?: string[];
  witnesses?: string;
  severity: NonDisciplineSeverity;
  followUpTicketId?: string;
}

export interface UpdateNonDisciplinePayload {
  status?: NonDisciplineStatus;
  resolution?: string;
  followUpTicketId?: string;
}

// ----- P2C3 Health Advanced DTOs -------------------------------------------

export type TelehealthSessionStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'NO_SHOW'
  | 'CANCELLED';
export type TelehealthDocumentType =
  | 'SESSION_NOTES'
  | 'TREATMENT_PLAN'
  | 'REFERRAL_LETTER'
  | 'CONSENT'
  | 'OTHER';

export interface TelehealthProviderDto {
  id: string;
  schoolId: string | null;
  providerName: string;
  speciality: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  bookingUrl: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTelehealthProviderPayload {
  providerName: string;
  speciality?: string;
  contactEmail?: string;
  contactPhone?: string;
  bookingUrl?: string;
}

export interface UpdateTelehealthProviderPayload extends Partial<CreateTelehealthProviderPayload> {
  isActive?: boolean;
}

export interface TelehealthSessionDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  providerId: string;
  providerName: string | null;
  providerSpeciality: string | null;
  scheduledAt: string;
  durationMinutes: number | null;
  status: TelehealthSessionStatus;
  meetingUrl: string | null;
  sessionNotesS3Key: string | null;
  consentSignatureId: string | null;
  consentReceivedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTelehealthSessionPayload {
  studentId: string;
  providerId: string;
  scheduledAt: string;
  durationMinutes?: number;
  meetingUrl?: string;
  requestParentConsent?: boolean;
}

export interface UpdateTelehealthSessionPayload {
  status?: TelehealthSessionStatus;
  meetingUrl?: string;
  cancellationReason?: string;
  sessionNotesS3Key?: string;
}

export interface TelehealthDocumentDto {
  id: string;
  sessionId: string;
  documentType: TelehealthDocumentType;
  s3Key: string;
  fileSizeBytes: number | null;
  signatureRequestId: string | null;
  uploadedBy: string;
  uploadedByName: string | null;
  uploadedAt: string;
}

export type ComplianceStatus = 'COMPLIANT' | 'NON_COMPLIANT' | 'EXEMPT' | 'PROVISIONAL';
export type ExemptionType = 'MEDICAL' | 'RELIGIOUS' | 'PHILOSOPHICAL';

export interface ImmunisationRequirementDto {
  id: string;
  schoolId: string | null;
  stateCode: string;
  vaccineName: string;
  requiredDoses: number;
  requiredByGrade: string;
  allowsExemption: boolean;
  exemptionTypes: string[] | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MissingVaccineDto {
  vaccineName: string;
  dosesReceived: number;
  dosesRequired: number;
}

export interface ImmunisationComplianceDto {
  id: string;
  studentId: string;
  studentName: string | null;
  studentGrade: string | null;
  schoolId: string;
  academicYearId: string | null;
  status: ComplianceStatus;
  missingVaccines: MissingVaccineDto[];
  exemptionType: string | null;
  exemptionDocumentS3Key: string | null;
  lastComputedAt: string;
  parentNotifiedAt: string | null;
}

export interface ComplianceDashboardDto {
  schoolId: string;
  totalStudents: number;
  compliant: number;
  nonCompliant: number;
  exempt: number;
  provisional: number;
  compliancePercent: number;
  lastComputedAt: string | null;
}

// P2C3 Health Advanced — namespaced to avoid clash with Cycle 11 Counselling
// referrals (ReferralStatus/ReferralType already defined upstream for that
// domain). The HTTP wire shape is unchanged; only the TS aliases are scoped.
export type ScreeningReferralType = 'VISION' | 'HEARING' | 'SCOLIOSIS' | 'OTHER';
export type ScreeningReferralOutcome =
  | 'NORMAL'
  | 'TREATMENT_REQUIRED'
  | 'GLASSES_PRESCRIBED'
  | 'HEARING_AID'
  | 'OTHER';
export type ScreeningReferralStatus = 'REFERRED' | 'FOLLOW_UP_COMPLETE' | 'LOST_TO_FOLLOW_UP';

export interface ScreeningReferralDto {
  id: string;
  screeningId: string;
  studentId: string;
  studentName: string | null;
  schoolId: string;
  referralType: ScreeningReferralType;
  reason: string;
  referredTo: string | null;
  referralDate: string;
  followUpDate: string | null;
  followUpOutcome: ScreeningReferralOutcome | null;
  followUpNotes: string | null;
  status: ScreeningReferralStatus;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScreeningReferralPayload {
  referralType: ScreeningReferralType;
  reason: string;
  referredTo?: string;
  referralDate: string;
  followUpDate?: string;
}

export interface UpdateScreeningReferralPayload {
  status?: ScreeningReferralStatus;
  followUpOutcome?: ScreeningReferralOutcome;
  followUpDate?: string;
  followUpNotes?: string;
  referredTo?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// P2-4c — Training + Appraisals + Expense Claims
// ─────────────────────────────────────────────────────────────────────────

export type EventStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
export type CertificationStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface TrainingProgrammeDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  isMandatory: boolean;
  renewalMonths: number | null;
  isActive: boolean;
  createdAt: string;
}

export interface CreateTrainingProgrammePayload {
  name: string;
  description?: string;
  isMandatory?: boolean;
  renewalMonths?: number;
}

export interface UpdateTrainingProgrammePayload {
  name?: string;
  description?: string | null;
  isMandatory?: boolean;
  renewalMonths?: number | null;
  isActive?: boolean;
}

export interface TrainingEventDto {
  id: string;
  programmeId: string;
  programmeName: string | null;
  schoolId: string;
  title: string;
  scheduledAt: string;
  durationMinutes: number | null;
  location: string | null;
  facilitator: string | null;
  maxParticipants: number | null;
  status: EventStatus;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  notes: string | null;
  completionCount: number;
  createdAt: string;
}

export interface CreateTrainingEventPayload {
  programmeId: string;
  title: string;
  scheduledAt: string;
  durationMinutes?: number;
  location?: string;
  facilitator?: string;
  maxParticipants?: number;
  notes?: string;
}

export interface UpdateTrainingEventPayload {
  title?: string;
  scheduledAt?: string;
  durationMinutes?: number;
  location?: string;
  facilitator?: string;
  maxParticipants?: number;
  status?: EventStatus;
  cancellationReason?: string;
  notes?: string;
}

export interface TrainingCompletionDto {
  id: string;
  eventId: string;
  eventTitle: string | null;
  programmeId: string | null;
  programmeName: string | null;
  employeeId: string;
  employeeName: string | null;
  schoolId: string;
  completedAt: string;
  score: number | null;
  passed: boolean;
  notes: string | null;
  createdAt: string;
}

export interface RecordCompletionPayload {
  employeeId: string;
  completedAt?: string;
  score?: number;
  passed?: boolean;
  notes?: string;
}

export interface CertificationTypeDto {
  id: string;
  schoolId: string;
  name: string;
  issuingBody: string | null;
  description: string | null;
  validityMonths: number | null;
  isRequired: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface EmployeeCertificationDto {
  id: string;
  employeeId: string;
  employeeName: string | null;
  certificationTypeId: string;
  certificationTypeName: string | null;
  schoolId: string;
  issuedAt: string;
  expiresAt: string | null;
  documentS3Key: string | null;
  referenceNumber: string | null;
  status: CertificationStatus;
  revokedAt: string | null;
  revokedReason: string | null;
  daysUntilExpiry: number | null;
  createdAt: string;
}

// Appraisals

export type AppraisalRating = 'OUTSTANDING' | 'GOOD' | 'REQUIRES_IMPROVEMENT' | 'INADEQUATE';
export type AppraisalStatus = 'DRAFT' | 'IN_REVIEW' | 'SIGNED_OFF';
export type CycleType = 'ANNUAL' | 'MID_YEAR' | 'PROBATIONARY';
export type CycleStatus = 'OPEN' | 'CLOSED' | 'ARCHIVED';
// Renamed AppraisalGoalProgress to avoid colliding with the
// Cycle 11 counselling GoalProgress (different enum values).
export type AppraisalGoalProgress = 'NOT_STARTED' | 'IN_PROGRESS' | 'ACHIEVED' | 'NOT_ACHIEVED';
export type ExpenseStatus = 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'PAID';

export interface AppraisalFrameworkDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  criteria: unknown;
  isActive: boolean;
  createdAt: string;
}

export interface AppraisalCycleDto {
  id: string;
  schoolId: string;
  academicYearId: string;
  frameworkId: string;
  frameworkName: string | null;
  cycleType: CycleType;
  name: string;
  startsOn: string;
  endsOn: string;
  status: CycleStatus;
  closedAt: string | null;
  createdAt: string;
}

export interface AppraisalGoalDto {
  id: string;
  appraisalId: string;
  goalText: string;
  successCriteria: string | null;
  targetDate: string | null;
  progress: AppraisalGoalProgress;
  progressNotes: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface AppraisalCommentDto {
  id: string;
  appraisalId: string;
  authorId: string;
  authorName: string | null;
  commentText: string;
  isVisibleToEmployee: boolean;
  createdAt: string;
}

export interface LessonObservationDto {
  id: string;
  appraisalId: string | null;
  schoolId: string;
  observerId: string;
  observerName: string | null;
  observedEmployeeId: string;
  observedEmployeeName: string | null;
  observationDate: string;
  observedClassLabel: string;
  observedClassId: string | null;
  durationMinutes: number | null;
  overallGrade: AppraisalRating | null;
  strengths: string | null;
  areasForDevelopment: string | null;
  notes: string | null;
  isLocked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  createdAt: string;
}

export interface AppraisalDto {
  id: string;
  cycleId: string;
  cycleName: string | null;
  cycleType: CycleType | null;
  employeeId: string;
  employeeName: string | null;
  appraiserId: string | null;
  appraiserName: string | null;
  schoolId: string;
  overallRating: AppraisalRating | null;
  selfReview: string | null;
  appraiserReview: string | null;
  developmentPlan: string | null;
  status: AppraisalStatus;
  signedOffAt: string | null;
  signedOffBy: string | null;
  signedOffByName: string | null;
  linkedApprovalId: string | null;
  goals: AppraisalGoalDto[];
  observations: LessonObservationDto[];
  comments: AppraisalCommentDto[];
  createdAt: string;
}

export interface UpdateAppraisalPayload {
  appraiserId?: string;
  overallRating?: AppraisalRating;
  selfReview?: string;
  appraiserReview?: string;
  developmentPlan?: string;
  status?: AppraisalStatus;
}

export interface CreateAppraisalGoalPayload {
  goalText: string;
  successCriteria?: string;
  targetDate?: string;
  sortOrder?: number;
}

export interface UpdateAppraisalGoalPayload {
  goalText?: string;
  successCriteria?: string;
  targetDate?: string;
  progress?: AppraisalGoalProgress;
  progressNotes?: string;
}

export interface CreateAppraisalCommentPayload {
  commentText: string;
  isVisibleToEmployee?: boolean;
}

export interface CreateLessonObservationPayload {
  appraisalId?: string;
  observedEmployeeId: string;
  observationDate: string;
  observedClassLabel: string;
  observedClassId?: string;
  durationMinutes?: number;
  overallGrade?: AppraisalRating;
  strengths?: string;
  areasForDevelopment?: string;
  notes?: string;
}

// Expense claims

export interface ExpenseClaimDto {
  id: string;
  employeeId: string;
  employeeName: string | null;
  schoolId: string;
  claimTitle: string;
  description: string | null;
  incurredOn: string;
  totalAmount: number;
  receiptS3Keys: string[];
  status: ExpenseStatus;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface CreateExpenseClaimPayload {
  claimTitle: string;
  description?: string;
  incurredOn: string;
  totalAmount: number;
  receiptS3Keys?: string[];
}

export interface DecideExpenseClaimPayload {
  decision: 'APPROVED' | 'REJECTED';
  rejectionReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// P2-5 Enrolment Advanced — tours, withdrawal, re-enrolment, mid-year
// ─────────────────────────────────────────────────────────────────────────

export type TourType =
  | 'GENERAL_OPEN_DAY'
  | 'INDIVIDUAL_FAMILY_TOUR'
  | 'VIRTUAL_TOUR'
  | 'SPECIALIST_TOUR';

export type BookingStatus = 'CONFIRMED' | 'CANCELLED' | 'NO_SHOW' | 'COMPLETED';

export type GuestType = 'ADULT' | 'CHILD' | 'PROSPECTIVE_STUDENT';

export interface TourSlotResponseDto {
  id: string;
  schoolId: string;
  tourDate: string;
  startTime: string;
  endTime: string;
  maxBookings: number;
  currentBookings: number;
  availableSpots: number;
  tourType: TourType;
  ledByEmployeeId: string | null;
  ledByName: string | null;
  meetingPoint: string | null;
  notes: string | null;
  isPublished: boolean;
  isCancelled: boolean;
  isFull: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTourSlotPayload {
  tourDate: string;
  startTime: string;
  endTime: string;
  maxBookings?: number;
  tourType?: TourType;
  ledByEmployeeId?: string | null;
  meetingPoint?: string | null;
  notes?: string | null;
  isPublished?: boolean;
}

export interface UpdateTourSlotPayload {
  isPublished?: boolean;
  isCancelled?: boolean;
  meetingPoint?: string | null;
  notes?: string | null;
  ledByEmployeeId?: string | null;
}

export interface TourGuestInputDto {
  guestType: GuestType;
  firstName: string;
  lastName: string;
  age?: number | null;
  notes?: string | null;
}

export interface TourGuestResponseDto extends TourGuestInputDto {
  id: string;
  bookingId: string;
}

export interface CreateTourBookingPayload {
  familyName: string;
  contactEmail: string;
  contactPhone?: string | null;
  notes?: string | null;
  guests?: TourGuestInputDto[];
}

export interface PublicTourBookingPayload extends CreateTourBookingPayload {
  firstName: string;
  lastName: string;
}

export interface UpdateTourBookingPayload {
  status?: BookingStatus;
  cancellationReason?: string | null;
  notes?: string | null;
}

export interface LinkApplicationPayload {
  applicationId: string;
}

export interface TourBookingResponseDto {
  id: string;
  slotId: string;
  schoolId: string;
  bookedBy: string;
  familyName: string;
  contactEmail: string;
  contactPhone: string | null;
  status: BookingStatus;
  bookedAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  linkedApplicationId: string | null;
  notes: string | null;
  guests: TourGuestResponseDto[];
}

export type WithdrawalReason =
  | 'FAMILY_RELOCATION'
  | 'TRANSFER_TO_OTHER_SCHOOL'
  | 'HOME_EDUCATION'
  | 'EXCLUSION'
  | 'MEDICAL'
  | 'FEE_DEFAULT'
  | 'SAFEGUARDING'
  | 'GRADUATION'
  | 'DECEASED'
  | 'OTHER';

export type InitiatedBy = 'FAMILY' | 'SCHOOL';

export type WithdrawalStatus = 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export type ExitTaskCategory =
  | 'ADMINISTRATIVE'
  | 'FINANCE'
  | 'IT'
  | 'FACILITIES'
  | 'TRANSPORT'
  | 'RECORDS';

export type ExitTaskStatus = 'PENDING' | 'COMPLETED' | 'WAIVED' | 'NOT_APPLICABLE';

export type MidYearReason =
  | 'FAMILY_RELOCATION'
  | 'TRANSFER_FROM_OTHER_SCHOOL'
  | 'RETURNING_FROM_ABROAD'
  | 'HOME_EDUCATION_ENDING'
  | 'LOOKED_AFTER_CHILD'
  | 'OTHER';

export type MidYearStatus =
  | 'RECEIVED'
  | 'CAPACITY_CHECKED'
  | 'OFFER_MADE'
  | 'ENROLLED'
  | 'DECLINED'
  | 'WITHDRAWN';

export interface CreateWithdrawalPayload {
  studentId: string;
  initiatedBy: InitiatedBy;
  withdrawalReasonCategory: WithdrawalReason;
  withdrawalReasonDetail?: string;
  lastAttendanceDate: string;
  destinationSchoolName?: string;
  destinationSchoolCountry?: string;
  recordsReleaseConsented?: boolean;
  notes?: string;
}

export interface CompleteWithdrawalPayload {
  notes?: string;
}

export interface CancelWithdrawalPayload {
  reason: string;
}

export interface PlaceReenrolHoldPayload {
  hold: boolean;
  reason?: string;
}

export interface UpdateExitTaskPayload {
  status: ExitTaskStatus;
  notes?: string;
}

export interface ExitTaskResponseDto {
  id: string;
  withdrawalId: string;
  taskName: string;
  taskCategory: ExitTaskCategory;
  status: ExitTaskStatus;
  completedBy: string | null;
  completedByName: string | null;
  completedAt: string | null;
  notes: string | null;
  sortOrder: number;
}

export interface WithdrawalResponseDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  initiatedBy: InitiatedBy;
  requestedBy: string;
  requestedByName: string | null;
  withdrawalReasonCategory: WithdrawalReason;
  withdrawalReasonDetail: string | null;
  lastAttendanceDate: string;
  requestedAt: string;
  destinationSchoolName: string | null;
  destinationSchoolCountry: string | null;
  recordsReleaseConsented: boolean;
  recordsSentAt: string | null;
  status: WithdrawalStatus;
  completedAt: string | null;
  completedBy: string | null;
  completedByName: string | null;
  reEnrollmentHoldPlaced: boolean;
  reEnrollmentHoldReason: string | null;
  notes: string | null;
  exitTasks: ExitTaskResponseDto[];
  exitTaskSummary: {
    pending: number;
    completed: number;
    waived: number;
    notApplicable: number;
    total: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CreateReenrolPayload {
  studentId: string;
  academicYearId: string;
  confirmedContinuing: boolean;
  withdrawalReason?: string;
  notes?: string;
}

export interface ReenrolResponseDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  academicYearId: string;
  academicYearName: string | null;
  submittedBy: string;
  submittedByName: string | null;
  confirmedContinuing: boolean;
  withdrawalReason: string | null;
  submittedAt: string;
  processedBy: string | null;
  processedByName: string | null;
  processedAt: string | null;
  linkedWithdrawalId: string | null;
  notes: string | null;
}

export interface ReenrolSummaryDto {
  academicYearId: string;
  academicYearName: string | null;
  totalStudents: number;
  totalConfirmed: number;
  continuing: number;
  departing: number;
  outstanding: number;
  perGrade: Array<{
    gradeLevel: string;
    continuing: number;
    departing: number;
    outstanding: number;
    total: number;
  }>;
}

export interface CreateMidYearAdmissionPayload {
  studentFirstName: string;
  studentLastName: string;
  studentDateOfBirth: string;
  applyingForGradeLevel: string;
  requestedStartDate: string;
  admissionReason: MidYearReason;
  admissionReasonDetail?: string;
  previousSchoolName?: string;
  previousSchoolCountry?: string;
  recordsRequested?: boolean;
  notes?: string;
}

export interface UpdateMidYearAdmissionPayload {
  status?: MidYearStatus;
  capacityAvailable?: boolean;
  linkedApplicationId?: string;
  notes?: string;
}

export interface MidYearAdmissionResponseDto {
  id: string;
  schoolId: string;
  requestedBy: string;
  requestedByName: string | null;
  studentFirstName: string;
  studentLastName: string;
  studentDateOfBirth: string;
  applyingForGradeLevel: string;
  requestedStartDate: string;
  admissionReason: MidYearReason;
  admissionReasonDetail: string | null;
  previousSchoolName: string | null;
  previousSchoolCountry: string | null;
  recordsRequested: boolean;
  status: MidYearStatus;
  capacityAvailable: boolean | null;
  capacityCheckedAt: string | null;
  capacityCheckedBy: string | null;
  capacityCheckedByName: string | null;
  linkedApplicationId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTemplateRowPayload {
  taskName: string;
  taskCategory: ExitTaskCategory;
  isRequired?: boolean;
  isActive?: boolean;
}

export interface UpsertTaskTemplatePayload {
  tasks: TaskTemplateRowPayload[];
}

export interface TaskTemplateResponseDto {
  id: string;
  schoolId: string;
  templateName: string;
  taskName: string;
  taskCategory: ExitTaskCategory;
  sortOrder: number;
  isActive: boolean;
  isRequired: boolean;
}

// ────────── P2-6 — Payments Advanced ──────────

export type ReductionType = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type AwardStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type FinancialAidApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'WITHDRAWN';
export type IncomeBand = 'BAND_A' | 'BAND_B' | 'BAND_C' | 'BAND_D' | 'BAND_E';

export interface FinancialAidProgramDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  reductionType: ReductionType;
  reductionValue: number;
  totalFundAmount: number | null;
  fundRemaining: number | null;
  academicYearId: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFinancialAidProgramPayload {
  name: string;
  description?: string;
  reductionType: ReductionType;
  reductionValue: number;
  totalFundAmount?: number;
  academicYearId?: string;
  isActive?: boolean;
}

export interface UpdateFinancialAidProgramPayload {
  name?: string;
  description?: string;
  isActive?: boolean;
  totalFundAmount?: number;
}

export interface FinancialAidApplicationDocument {
  s3Key: string;
  label: string;
}

export interface FinancialAidApplicationDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  programId: string;
  programName: string | null;
  guardianId: string;
  guardianName: string | null;
  academicYearId: string;
  householdIncomeBand: IncomeBand | null;
  supportingDocuments: FinancialAidApplicationDocument[];
  applicationStatement: string | null;
  status: FinancialAidApplicationStatus;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  awardId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFinancialAidApplicationPayload {
  studentId: string;
  programId: string;
  academicYearId: string;
  householdIncomeBand?: IncomeBand;
  supportingDocuments?: FinancialAidApplicationDocument[];
  applicationStatement?: string;
  submit?: boolean;
}

export interface UpdateFinancialAidApplicationPayload {
  householdIncomeBand?: IncomeBand;
  supportingDocuments?: FinancialAidApplicationDocument[];
  applicationStatement?: string;
}

export interface ReviewFinancialAidApplicationPayload {
  action: 'APPROVE' | 'REJECT' | 'UNDER_REVIEW';
  awardAmount?: number;
  awardEffectiveFrom?: string;
  reviewerNotes?: string;
}

export interface FinancialAidAwardDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  programId: string;
  programName: string | null;
  academicYearId: string;
  awardAmount: number;
  approvedBy: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: AwardStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Discount rules ──

export type DiscountType =
  | 'SIBLING'
  | 'EARLY_PAYMENT'
  | 'LOYALTY'
  | 'BURSARY'
  | 'STAFF_CHILD'
  | 'CUSTOM';
export type CalculationMethod = 'PERCENTAGE' | 'FIXED_AMOUNT';

export interface DiscountRuleDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  discountType: DiscountType;
  calculationMethod: CalculationMethod;
  value: number;
  appliesToFeeCategoryId: string | null;
  appliesToFeeCategoryName: string | null;
  siblingOrder: number | null;
  minimumInvoiceAmount: number | null;
  academicYearId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDiscountRulePayload {
  name: string;
  description?: string;
  discountType: DiscountType;
  calculationMethod: CalculationMethod;
  value: number;
  appliesToFeeCategoryId?: string;
  siblingOrder?: number;
  minimumInvoiceAmount?: number;
  academicYearId?: string;
  isActive?: boolean;
}

export interface UpdateDiscountRulePayload {
  name?: string;
  description?: string;
  value?: number;
  isActive?: boolean;
  minimumInvoiceAmount?: number;
}

// ── Auto-invoice rules + generation runs ──

export type TriggerType =
  | 'ENROLMENT_CONFIRMED'
  | 'TERM_START'
  | 'DATE_OF_MONTH'
  | 'ACADEMIC_YEAR_START';
export type InvoiceGenerationRunType = 'MANUAL_BATCH' | 'AUTO_RULE_TRIGGERED' | 'FEE_SCHEDULE_BULK';
export type InvoiceGenerationRunStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface AutoInvoiceRuleDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  triggerType: TriggerType;
  feeScheduleId: string;
  feeScheduleName: string | null;
  triggerDayOfMonth: number | null;
  triggerTermOffsetDays: number | null;
  appliesToGradeLevel: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAutoInvoiceRulePayload {
  name: string;
  description?: string;
  triggerType: TriggerType;
  feeScheduleId: string;
  triggerDayOfMonth?: number;
  triggerTermOffsetDays?: number;
  appliesToGradeLevel?: string;
  isActive?: boolean;
}

export interface UpdateAutoInvoiceRulePayload {
  name?: string;
  description?: string;
  isActive?: boolean;
  triggerDayOfMonth?: number;
  triggerTermOffsetDays?: number;
  appliesToGradeLevel?: string;
}

export interface InvoiceGenerationRunDto {
  id: string;
  schoolId: string;
  runType: InvoiceGenerationRunType;
  feeScheduleId: string | null;
  feeScheduleName: string | null;
  autoRuleId: string | null;
  academicYearId: string | null;
  initiatedBy: string | null;
  totalFamiliesTargeted: number;
  invoicesCreated: number;
  invoicesSkipped: number;
  invoicesFailed: number;
  status: InvoiceGenerationRunStatus;
  errorSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerAutoInvoiceRulePayload {
  academicYearId?: string;
}

// ── Lunch accounts ──

export type LunchTransactionType = 'MEAL_CHARGE' | 'DEPOSIT' | 'REFUND' | 'ADJUSTMENT';
export type LunchTransferType = 'SIBLING_TRANSFER' | 'NEXT_YEAR_ROLLOVER' | 'REFUND_TO_FAMILY';

export interface LunchAccountDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  balance: number;
  lowBalanceThreshold: number;
  autoReplenishEnabled: boolean;
  autoReplenishAmount: number | null;
  lastLowBalanceAlertAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LunchTransactionDto {
  id: string;
  schoolId: string;
  lunchAccountId: string;
  amount: number;
  transactionType: LunchTransactionType;
  mealDate: string | null;
  posDeviceId: string | null;
  sourceEventId: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface LunchTransferDto {
  id: string;
  schoolId: string;
  fromAccountId: string;
  toAccountId: string | null;
  transferType: LunchTransferType;
  amount: number;
  reason: string;
  refundId: string | null;
  processedBy: string;
  processedAt: string;
}

export interface LunchAccountWithTransactionsDto {
  account: LunchAccountDto;
  transactions: LunchTransactionDto[];
  lowBalance: boolean;
}

export interface DepositLunchAccountPayload {
  amount: number;
  notes?: string;
}

export interface TransferLunchBalancePayload {
  fromAccountId: string;
  toAccountId?: string;
  transferType: LunchTransferType;
  amount: number;
  reason: string;
  refundId?: string;
}

export interface UpdateLunchAccountPayload {
  lowBalanceThreshold?: number;
  autoReplenishEnabled?: boolean;
  autoReplenishAmount?: number;
}

// ── Billing operations ──

export type CreditCategory =
  | 'GOODWILL'
  | 'BILLING_ERROR'
  | 'PROGRAMME_CANCELLED'
  | 'OVERPAYMENT'
  | 'OTHER';
export type ReversalType =
  | 'BOUNCED_CHEQUE'
  | 'RECALLED_TRANSFER'
  | 'CHARGEBACK'
  | 'DUPLICATE_PAYMENT'
  | 'OTHER';
export type LateFeeType = 'FIXED' | 'PERCENTAGE_MONTHLY';
export type SavedPaymentMethodType = 'CARD' | 'BANK_ACCOUNT';

export interface CreditNoteDto {
  id: string;
  schoolId: string;
  invoiceId: string;
  lineItemId: string | null;
  familyAccountId: string;
  creditAmount: number;
  creditCategory: CreditCategory;
  reason: string;
  ledgerEntryId: string | null;
  issuedBy: string;
  issuedAt: string;
}

export interface IssueCreditNotePayload {
  creditAmount: number;
  creditCategory?: CreditCategory;
  reason: string;
  lineItemId?: string;
}

export interface PaymentReversalDto {
  id: string;
  schoolId: string;
  paymentId: string;
  familyAccountId: string;
  invoiceId: string;
  reversalType: ReversalType;
  reversalReason: string;
  bankReference: string | null;
  reversedAmount: number;
  ledgerEntryId: string | null;
  reversedBy: string;
  reversedAt: string;
}

export interface ReversePaymentPayload {
  reversalType: ReversalType;
  reversalReason: string;
  bankReference?: string;
}

export interface PaymentAllocationItemPayload {
  invoiceId: string;
  allocatedAmount: number;
}

export interface AllocatePaymentPayload {
  allocations: PaymentAllocationItemPayload[];
}

export interface PaymentAllocationDto {
  id: string;
  schoolId: string;
  paymentId: string;
  invoiceId: string;
  invoiceTitle: string | null;
  allocatedAmount: number;
  allocatedBy: string | null;
  allocatedAt: string;
}

export interface LatePaymentPolicyDto {
  id: string;
  schoolId: string;
  isActive: boolean;
  gracePeriodDays: number;
  feeType: LateFeeType;
  feeAmount: number | null;
  feePercentage: number | null;
  maxLateFeeAmount: number | null;
  appliesToFeeCategoryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertLatePaymentPolicyPayload {
  isActive?: boolean;
  gracePeriodDays?: number;
  feeType: LateFeeType;
  feeAmount?: number;
  feePercentage?: number;
  maxLateFeeAmount?: number;
  appliesToFeeCategoryId?: string;
}

export interface LateFeesScanResponseDto {
  invoicesEvaluated: number;
  lateFeesApplied: number;
  invoicesSkipped: number;
  totalLateFeeAmount: number;
}

export interface SavedPaymentMethodDto {
  id: string;
  schoolId: string;
  familyAccountId: string;
  stripePaymentMethodId: string;
  methodType: SavedPaymentMethodType;
  cardLastFour: string | null;
  cardBrand: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  bankLastFour: string | null;
  isDefault: boolean;
  addedAt: string;
}

export interface CreateSavedPaymentMethodPayload {
  familyAccountId: string;
  stripePaymentMethodId: string;
  methodType?: SavedPaymentMethodType;
  cardLastFour?: string;
  cardBrand?: string;
  cardExpMonth?: number;
  cardExpYear?: number;
  bankLastFour?: string;
  isDefault?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// P2-9 Sub Marketplace (M82)
// ──────────────────────────────────────────────────────────────────────

// ── Profile + Search ──

export type SubCredentialType =
  | 'TEACHING_LICENSE'
  | 'SAFEGUARDING'
  | 'FIRST_AID'
  | 'BACKGROUND_CHECK'
  | 'SPECIALIST_QUALIFICATION'
  | 'OTHER';
export type SubVerificationStatus = 'PENDING' | 'VERIFIED' | 'EXPIRED';
export type AvailabilityType = 'RECURRING' | 'SPECIFIC' | 'BLOCKED';
export type PreferenceType = 'PREFERRED' | 'BLOCKED';
export type PoolStatus = 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
export type SubJobType = 'FULL_DAY' | 'HALF_DAY' | 'SPECIFIC_PERIODS';
export type SubJobStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'UNFILLED';
export type NotificationTier = 'POOL' | 'MARKETPLACE';
export type NotificationResponse = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';
export type SubAssignmentStatus =
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'CHECKED_OUT'
  | 'NO_SHOW'
  | 'CANCELLED';
export type SubRaterType = 'SCHOOL_RATES_SUB' | 'SUB_RATES_SCHOOL';
export type SubRateType = 'HOURLY' | 'DAILY' | 'HALF_DAY';
export type SubCancelConsequence =
  | 'WARNING_ONLY'
  | 'TEMPORARY_POOL_SUSPENSION'
  | 'PERMANENT_POOL_REMOVAL'
  | 'RATING_PENALTY';

export interface SubstituteProfileDto {
  id: string;
  personId: string;
  displayName: string | null;
  bio: string | null;
  gradeLevels: string[];
  subjectAreas: string[];
  yearsExperience: number | null;
  maxTravelMiles: number | null;
  isAvailable: boolean;
  overallRating: string | null;
  totalAssignments: number;
  isActive: boolean;
}

export interface CreateSubstituteProfilePayload {
  personId: string;
  displayName: string;
  bio?: string;
  gradeLevels: string[];
  subjectAreas?: string[];
  yearsExperience?: number;
  maxTravelMiles?: number;
}

export interface SubstituteSearchArgs {
  gradeLevels?: string[];
  subjectAreas?: string[];
  schoolId?: string;
  availableOn?: string;
  verifiedOnly?: boolean;
}

// ── Pool ──

export interface SchoolPoolMemberDto {
  id: string;
  substituteId: string;
  substituteName: string | null;
  overallRating: string | null;
  status: PoolStatus;
  suspendedUntil: string | null;
  suspensionReason: string | null;
  addedAt: string;
}

export interface AddToPoolPayload {
  substituteId: string;
  notes?: string;
}

export interface UpdatePoolMemberPayload {
  status?: PoolStatus;
  suspendedUntil?: string;
  suspensionReason?: string;
}

// ── Job + Notifications ──

export interface SubJobClassDto {
  id: string;
  timetableSlotId: string;
  className: string;
  roomName: string | null;
  periodLabel: string | null;
}

export interface SubJobNotificationDto {
  id: string;
  substituteId: string;
  response: NotificationResponse;
  notifiedAt: string;
  respondedAt: string | null;
  acceptanceWindowExpiresAt: string;
  notificationTier: NotificationTier;
}

export interface SubJobPostingDto {
  id: string;
  schoolId: string;
  absentTeacherId: string;
  absentTeacherName: string | null;
  jobDate: string;
  startTime: string;
  endTime: string;
  jobType: SubJobType;
  gradeLevel: string | null;
  subject: string | null;
  status: SubJobStatus;
  notificationTier: NotificationTier;
  acceptanceWindowMinutes: number;
  escalateToMarketplaceAt: string | null;
  filledAt: string | null;
  createdAt: string;
  classes: SubJobClassDto[];
  notifications: SubJobNotificationDto[];
}

export interface PostJobPayload {
  absentTeacherId: string;
  jobDate: string;
  startTime: string;
  endTime: string;
  jobType?: SubJobType;
  gradeLevel?: string;
  subject?: string;
  specialRequirements?: string;
  acceptanceWindowMinutes?: number;
  timetableSlotIds?: string[];
}

// ── Assignment + Ratings + Notes ──

export interface SubAssignmentDto {
  id: string;
  jobId: string;
  substituteId: string;
  confirmedAt: string;
  status: SubAssignmentStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  isLateCancellation: boolean;
  cancelledAt: string | null;
  cancelledByType: 'SCHOOL' | 'SUBSTITUTE' | null;
  cancellationReason: string | null;
}

export interface CancelAssignmentPayload {
  cancelledByType: 'SCHOOL' | 'SUBSTITUTE';
  cancellationReason: string;
}

export interface SubRatingDto {
  id: string;
  assignmentId: string;
  raterType: SubRaterType;
  overallScore: string | null;
  professionalism: string | null;
  punctuality: string | null;
  comments: string | null;
  ratedAt: string;
  ratedBy: string | null;
}

export interface CreateRatingPayload {
  raterType: SubRaterType;
  overallScore?: number;
  professionalism?: number;
  punctuality?: number;
  comments?: string;
}

export interface SubSessionNoteDto {
  id: string;
  assignmentId: string;
  notesText: string;
  homeworkSet: string | null;
  isVisibleToTeacher: boolean;
  submittedAt: string;
}

export interface CreateSessionNotePayload {
  notesText: string;
  homeworkSet?: string;
  isVisibleToTeacher?: boolean;
}

// ── Availability + Preferences ──

export interface SubAvailabilityDto {
  id: string;
  substituteId: string;
  availabilityType: AvailabilityType;
  dayOfWeek: number | null;
  specificDate: string | null;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
}

export interface CreateAvailabilityPayload {
  availabilityType: AvailabilityType;
  dayOfWeek?: number;
  specificDate?: string;
  startTime?: string;
  endTime?: string;
  notes?: string;
}

export interface SubPreferenceDto {
  id: string;
  substituteId: string;
  schoolId: string;
  preferenceType: PreferenceType;
  reason: string | null;
}

export interface CreatePreferencePayload {
  schoolId: string;
  preferenceType: PreferenceType;
  reason?: string;
}

// ── Pay Rates ──

export interface SubPayRateDto {
  id: string;
  schoolId: string;
  substituteId: string;
  jobType: SubJobType;
  rate: string;
  rateType: SubRateType;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
}

export interface CreatePayRatePayload {
  substituteId?: string;
  jobType?: SubJobType;
  rate: number;
  rateType?: SubRateType;
  effectiveFrom: string;
  effectiveTo?: string;
  notes?: string;
}

export interface AssignmentPayDto {
  assignmentId: string;
  rate: string;
  rateType: SubRateType;
  rateSource: 'PER_SUBSTITUTE' | 'SCHOOL_DEFAULT';
  payRateId: string | null;
}

// ── Cancellation Policy ──

export interface SubCancellationPolicyDto {
  id: string;
  schoolId: string;
  lateWindowHours: number;
  consequence: SubCancelConsequence;
  suspensionDurationDays: number | null;
  repeatOffenceThreshold: number;
  ratingPenaltyAmount: string | null;
  notes: string | null;
  updatedAt: string;
}

export interface UpsertCancellationPolicyPayload {
  lateWindowHours?: number;
  consequence?: SubCancelConsequence;
  suspensionDurationDays?: number;
  repeatOffenceThreshold?: number;
  ratingPenaltyAmount?: number;
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────
// Phase 2 Cycle 12 — M101 Events & Ticketing.
// Atomic ticket sale: UPDATE evt_ticket_tiers SET quantity_sold +=
// $qty WHERE quantity_sold + $qty <= quantity. 0 rows = 409 Sold Out.
// ─────────────────────────────────────────────────────────────────

export type EvtEventType =
  | 'ATHLETIC_GAME'
  | 'PERFORMANCE'
  | 'DANCE'
  | 'FUNDRAISER'
  | 'GRADUATION'
  | 'ASSEMBLY'
  | 'COMMUNITY'
  | 'OTHER';

export type EvtEventStatus = 'DRAFT' | 'ON_SALE' | 'SOLD_OUT' | 'COMPLETED' | 'CANCELLED';
export type EvtOrderStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'REFUNDED';
export type EvtTicketStatus = 'VALID' | 'USED' | 'CANCELLED' | 'REFUNDED';
export type EvtScanResult = 'VALID' | 'ALREADY_SCANNED' | 'INVALID' | 'EXPIRED';
export type EvtPassStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type EvtCompType =
  | 'ATHLETE'
  | 'COACH'
  | 'OFFICIAL'
  | 'MEDIA'
  | 'STAFF'
  | 'STUDENT'
  | 'VIP'
  | 'OTHER';
export type EvtVolunteerStatus = 'SIGNED_UP' | 'CONFIRMED' | 'CANCELLED';

export interface EvtTierDto {
  id: string;
  eventId: string;
  name: string;
  price: number;
  quantity: number;
  quantitySold: number;
  remaining: number;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  isActive: boolean;
}

export interface EvtEventDto {
  id: string;
  schoolId: string;
  title: string;
  description: string | null;
  eventType: EvtEventType;
  eventDate: string;
  startTime: string;
  endTime: string | null;
  venueId: string | null;
  venueName: string | null;
  totalCapacity: number | null;
  totalTierQuantity: number;
  linkedGameId: string | null;
  status: EvtEventStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  tiers?: EvtTierDto[];
}

export interface EvtTicketDto {
  id: string;
  orderId: string;
  tierId: string;
  tierName: string | null;
  holderName: string | null;
  qrCodeToken: string;
  status: EvtTicketStatus;
  scannedAt: string | null;
}

export interface EvtOrderDto {
  id: string;
  eventId: string;
  eventTitle: string | null;
  purchaserId: string;
  purchaserName: string | null;
  status: EvtOrderStatus;
  totalAmount: number;
  stripePaymentIntentId: string | null;
  expiresAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  tickets: EvtTicketDto[];
}

export interface EvtRefundDto {
  id: string;
  orderId: string;
  refundAmount: number;
  reason: string;
  stripeRefundId: string | null;
  refundedBy: string;
  refundedAt: string;
}

export interface EvtSeasonPassDto {
  id: string;
  schoolId: string;
  personId: string;
  personName: string | null;
  passType: string;
  eventsIncluded: string[] | null;
  price: number;
  purchasedAt: string | null;
  stripePaymentIntentId: string | null;
  status: EvtPassStatus;
  academicYear: string;
  notes: string | null;
}

export interface EvtCompEntryDto {
  id: string;
  eventId: string;
  compType: EvtCompType;
  personId: string;
  personName: string | null;
  notes: string | null;
  addedBy: string;
  addedByName: string | null;
  addedAt: string;
}

export interface EvtVolunteerDto {
  id: string;
  eventId: string;
  personId: string;
  personName: string | null;
  role: string | null;
  status: EvtVolunteerStatus;
  checkInAt: string | null;
  notes: string | null;
}

export interface EvtGateScanResultDto {
  scanResult: EvtScanResult;
  ticketId: string | null;
  holderName: string | null;
  tierName: string | null;
  eventTitle: string | null;
  scannedAt: string;
  message: string;
}

export interface EvtSeasonPassGateResultDto {
  admitted: boolean;
  reason: string;
}

export interface EvtCompCheckResultDto {
  admitted: boolean;
  compType: EvtCompType | null;
  personName: string | null;
}

// Step 10 — Revenue report
export interface EvtTierRevenueDto {
  tierId: string;
  tierName: string;
  price: number;
  quantitySold: number;
  ticketsScanned: number;
  grossRevenue: number;
}

export interface EvtRevenueReportDto {
  eventId: string;
  eventTitle: string;
  eventDate: string;
  status: EvtEventStatus;
  grossTicketSales: number;
  refundsIssued: number;
  netRevenue: number;
  estimatedStripeFees: number;
  ordersConfirmed: number;
  ordersRefunded: number;
  totalTicketsSold: number;
  totalTicketsScanned: number;
  seasonPassAdmissions: number;
  compAdmissions: number;
  tiers: EvtTierRevenueDto[];
}

export interface EvtRevenueRowDto {
  eventType: EvtEventType;
  ordersConfirmed: number;
  ticketsSold: number;
  grossRevenue: number;
  refundsIssued: number;
  netRevenue: number;
}

export interface EvtRevenueSummaryDto {
  schoolId: string;
  from: string | null;
  to: string | null;
  byEventType: EvtRevenueRowDto[];
  totals: {
    grossRevenue: number;
    refundsIssued: number;
    netRevenue: number;
    ordersConfirmed: number;
    ticketsSold: number;
  };
}

// Payloads
export interface CreateEvtEventPayload {
  title: string;
  description?: string;
  eventType: EvtEventType;
  eventDate: string;
  startTime: string;
  endTime?: string;
  venueId?: string;
  venueName?: string;
  totalCapacity?: number;
  linkedGameId?: string;
}

export interface UpdateEvtEventPayload {
  title?: string;
  description?: string;
  eventDate?: string;
  startTime?: string;
  endTime?: string;
  venueName?: string;
  totalCapacity?: number;
  status?: EvtEventStatus;
}

export interface CreateEvtTierPayload {
  name: string;
  price: number;
  quantity: number;
  saleStartsAt?: string;
  saleEndsAt?: string;
  isActive?: boolean;
}

export interface UpdateEvtTierPayload {
  name?: string;
  price?: number;
  quantity?: number;
  saleStartsAt?: string;
  saleEndsAt?: string;
  isActive?: boolean;
}

export interface EvtPurchaseLine {
  tierId: string;
  quantity: number;
  holderNames?: string[];
}

export interface EvtPurchasePayload {
  lines: EvtPurchaseLine[];
}

export interface EvtRefundPayload {
  refundAmount: number;
  reason: string;
}

export interface EvtScanPayload {
  qrCodeToken: string;
  eventId?: string;
  scanSource?: string;
}

export interface CreateEvtSeasonPassPayload {
  personId: string;
  passType: string;
  eventsIncluded?: string[];
  price: number;
  academicYear: string;
  notes?: string;
}

export interface EvtSeasonPassGateCheckPayload {
  passId: string;
  eventId: string;
}

export interface AddEvtCompEntryPayload {
  compType: EvtCompType;
  personId: string;
  notes?: string;
}

export interface EvtCompCheckPayload {
  eventId: string;
  personId: string;
}

export interface CreateEvtVolunteerPayload {
  personId: string;
  role?: string;
  notes?: string;
}

export interface UpdateEvtVolunteerPayload {
  status?: EvtVolunteerStatus;
  role?: string;
  checkIn?: boolean;
}
