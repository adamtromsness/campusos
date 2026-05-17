export { AuthGuard, IS_PUBLIC_KEY } from './auth.guard';
export { PermissionGuard } from './permission.guard';
export { Public } from './public.decorator';
export { RequirePermission, PERMISSIONS_KEY } from './require-permission.decorator';
export { PlatformScoped, PLATFORM_SCOPED_KEY } from './platform-scoped.decorator';
export { StudentOwned, STUDENT_OWNED_KEY } from './student-owned.decorator';
export type { StudentOwnedOptions } from './student-owned.decorator';
export { assertStudentOwnsRecord } from './student-owned.guard';
export type { StudentOwnedAssertOptions } from './student-owned.guard';
