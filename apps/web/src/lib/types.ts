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
