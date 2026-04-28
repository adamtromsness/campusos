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
