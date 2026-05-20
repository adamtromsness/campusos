import { describe, it, expect } from 'vitest';

import {
  isUniqueViolation,
  isCheckViolation,
} from '@modules/m63-food-service/food-service.errors';

describe('integration:m63-food-service/error-helpers', () => {
  describe('isUniqueViolation', () => {
    it('returns false for null / undefined / non-object', () => {
      expect(isUniqueViolation(null)).toBe(false);
      expect(isUniqueViolation(undefined)).toBe(false);
      expect(isUniqueViolation('string')).toBe(false);
      expect(isUniqueViolation(42)).toBe(false);
    });

    it('returns true for Prisma P2002 (typed unique violation)', () => {
      expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    });

    it('returns true for P2010 raw envelope with meta.code 23505', () => {
      expect(isUniqueViolation({ code: 'P2010', meta: { code: '23505' } })).toBe(true);
    });

    it('returns true for direct 23505 code', () => {
      expect(isUniqueViolation({ code: '23505' })).toBe(true);
    });

    it('returns true when message includes 23505', () => {
      expect(isUniqueViolation({ message: 'duplicate key value violates ... 23505' })).toBe(true);
    });

    it('returns false for P2010 with non-23505 meta.code (e.g. CHECK)', () => {
      expect(isUniqueViolation({ code: 'P2010', meta: { code: '23514' } })).toBe(false);
    });

    it('returns false for other Prisma codes', () => {
      expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
    });
  });

  describe('isCheckViolation', () => {
    it('returns false for null / undefined / non-object', () => {
      expect(isCheckViolation(null)).toBe(false);
      expect(isCheckViolation(undefined)).toBe(false);
      expect(isCheckViolation('foo')).toBe(false);
    });

    it('returns true for direct 23514 code', () => {
      expect(isCheckViolation({ code: '23514' })).toBe(true);
    });

    it('returns true for meta.code 23514', () => {
      expect(isCheckViolation({ meta: { code: '23514' } })).toBe(true);
    });

    it('returns true when message includes 23514', () => {
      expect(isCheckViolation({ message: 'CHECK constraint violation 23514' })).toBe(true);
    });

    it('returns false for unique violations and unrelated codes', () => {
      expect(isCheckViolation({ code: '23505' })).toBe(false);
      expect(isCheckViolation({ code: 'P2002' })).toBe(false);
      expect(isCheckViolation({ code: 'random' })).toBe(false);
    });
  });
});
