import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from './auth.guard';

/**
 * @Public() decorator — marks an endpoint as publicly accessible.
 * Skips JWT validation in the AuthGuard.
 *
 * Usage:
 *   @Public()
 *   @Get('status')
 *   getStatus() { ... }
 */
export var Public = function () {
  return SetMetadata(IS_PUBLIC_KEY, true);
};
