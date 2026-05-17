/**
 * Shared error-shape helpers for the food-service module.
 *
 * isUniqueViolation / isCheckViolation peer at Prisma's
 * P2010 envelope around raw SQL exceptions so service
 * code can translate SQLSTATE 23505 (unique violation) and
 * 23514 (check violation) into BadRequestException with a
 * friendly message instead of leaking the raw Postgres error.
 */

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

export function isCheckViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.meta?.code === '23514' || e.code === '23514') return true;
  return typeof e.message === 'string' && e.message.includes('23514');
}
