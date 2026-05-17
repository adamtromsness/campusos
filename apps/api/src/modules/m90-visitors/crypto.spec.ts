import { describe, it, expect } from 'vitest';
import {
  decryptPII,
  emailHash,
  encryptPII,
  generateQrToken,
  nameHash,
  normaliseNameComponent,
  phoneHash,
} from './crypto';

const SCHOOL_A = '019e03f8-cf0b-7444-92d2-85e2c67b549a';
const SCHOOL_B = '019e03f8-cf0b-7444-92d2-85e2c67b549b';

describe('visitor crypto', () => {
  describe('encryptPII / decryptPII', () => {
    it('round-trips plaintext through AES-256-GCM', () => {
      const plain = 'david.chen@example.com';
      const wire = encryptPII(plain);
      expect(wire).not.toBeNull();
      expect(wire).not.toBe(plain);
      // Wire format is base64(iv).base64(tag).base64(ciphertext) — three parts.
      expect(wire!.split('.').length).toBe(3);
      expect(decryptPII(wire)).toBe(plain);
    });

    it('returns null on null/empty input', () => {
      expect(encryptPII(null)).toBeNull();
      expect(encryptPII(undefined)).toBeNull();
      expect(encryptPII('')).toBeNull();
      expect(decryptPII(null)).toBeNull();
      expect(decryptPII(undefined)).toBeNull();
    });

    it('produces a fresh ciphertext every call (random IV)', () => {
      const a = encryptPII('foo@bar.com');
      const b = encryptPII('foo@bar.com');
      expect(a).not.toBe(b);
      // But both decrypt to the same plaintext.
      expect(decryptPII(a)).toBe('foo@bar.com');
      expect(decryptPII(b)).toBe('foo@bar.com');
    });

    it('throws on tampered ciphertext', () => {
      const wire = encryptPII('secret@example.com');
      // Flip one character in the ciphertext — GCM auth tag should reject.
      const parts = wire!.split('.');
      const tampered = [parts[0]!, parts[1]!, parts[2]!.slice(0, -2) + 'AA'].join('.');
      expect(() => decryptPII(tampered)).toThrow();
    });

    it('throws on malformed wire format', () => {
      expect(() => decryptPII('not-a-valid-wire')).toThrow();
      expect(() => decryptPII('only.two')).toThrow();
    });
  });

  describe('emailHash — REVIEW-P2C1 MAJOR 1 tenant binding', () => {
    it('produces the same hash for the same (school, email)', () => {
      const a = emailHash(SCHOOL_A, 'David.Chen@example.com');
      const b = emailHash(SCHOOL_A, 'david.chen@example.com');
      const c = emailHash(SCHOOL_A, '  DAVID.CHEN@example.com  ');
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('produces a DIFFERENT hash for the same email in two schools', () => {
      const a = emailHash(SCHOOL_A, 'david.chen@example.com');
      const b = emailHash(SCHOOL_B, 'david.chen@example.com');
      expect(a).not.toBe(b);
    });

    it('returns 64-char hex (sha256)', () => {
      const h = emailHash(SCHOOL_A, 'a@b.com');
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('phoneHash — tenant binding + normalisation', () => {
    it('collapses formatting into the same hash within a school', () => {
      const a = phoneHash(SCHOOL_A, '+1 (217) 555-0101');
      const b = phoneHash(SCHOOL_A, '+12175550101');
      const c = phoneHash(SCHOOL_A, '+1-217-555-0101');
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('returns null for blank / missing phone', () => {
      expect(phoneHash(SCHOOL_A, null)).toBeNull();
      expect(phoneHash(SCHOOL_A, undefined)).toBeNull();
      expect(phoneHash(SCHOOL_A, '')).toBeNull();
      expect(phoneHash(SCHOOL_A, '   ')).toBeNull();
      expect(phoneHash(SCHOOL_A, '---')).toBeNull();
    });

    it('produces a DIFFERENT hash for the same phone in two schools', () => {
      const a = phoneHash(SCHOOL_A, '+12175550101');
      const b = phoneHash(SCHOOL_B, '+12175550101');
      expect(a).not.toBe(b);
    });
  });

  describe('normaliseNameComponent — REVIEW-P2C1 MAJOR 3', () => {
    it('lowercases', () => {
      expect(normaliseNameComponent('JOHN')).toBe('john');
    });

    it('strips diacritics via NFKD', () => {
      expect(normaliseNameComponent('José')).toBe('jose');
      expect(normaliseNameComponent('Müller')).toBe('muller');
      expect(normaliseNameComponent('Renée')).toBe('renee');
    });

    it('strips punctuation (apostrophes, hyphens, dots)', () => {
      expect(normaliseNameComponent("O'Brien")).toBe('o brien');
      expect(normaliseNameComponent('Smith-Jones')).toBe('smith jones');
      expect(normaliseNameComponent('St. James')).toBe('st james');
    });

    it('collapses whitespace runs', () => {
      expect(normaliseNameComponent('John   Paul')).toBe('john paul');
      expect(normaliseNameComponent('  John\tPaul  ')).toBe('john paul');
    });

    it('handles empty input', () => {
      expect(normaliseNameComponent('')).toBe('');
      expect(normaliseNameComponent('   ')).toBe('');
    });
  });

  describe('nameHash — banned-persons SAFETY KEYSTONE', () => {
    it('matches case + accent + punctuation variants of the same name', () => {
      const canonical = nameHash(SCHOOL_A, 'John', 'Doe', '1985-03-12');
      // All of these should match the canonical hash.
      expect(nameHash(SCHOOL_A, 'JOHN', 'DOE', '1985-03-12')).toBe(canonical);
      expect(nameHash(SCHOOL_A, 'john', 'doe', '1985-03-12')).toBe(canonical);
      expect(nameHash(SCHOOL_A, '  John  ', '  Doe  ', '1985-03-12')).toBe(canonical);
    });

    it('matches a diacritic variant (José vs Jose) within a school', () => {
      const canonical = nameHash(SCHOOL_A, 'Jose', 'Garcia', '1990-01-01');
      expect(nameHash(SCHOOL_A, 'José', 'García', '1990-01-01')).toBe(canonical);
    });

    it('matches a punctuation variant (O’Brien vs O Brien)', () => {
      const canonical = nameHash(SCHOOL_A, 'Sean', "O'Brien", null);
      expect(nameHash(SCHOOL_A, 'sean', 'o brien', null)).toBe(canonical);
      expect(nameHash(SCHOOL_A, 'Sean', 'O-Brien', null)).toBe(canonical);
    });

    it('produces a DIFFERENT hash for the same name in two schools', () => {
      const a = nameHash(SCHOOL_A, 'John', 'Doe', '1985-03-12');
      const b = nameHash(SCHOOL_B, 'John', 'Doe', '1985-03-12');
      expect(a).not.toBe(b);
    });

    it('produces a DIFFERENT hash when DOB differs', () => {
      const a = nameHash(SCHOOL_A, 'John', 'Doe', '1985-03-12');
      const b = nameHash(SCHOOL_A, 'John', 'Doe', '1985-03-13');
      const c = nameHash(SCHOOL_A, 'John', 'Doe', null);
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
    });

    it('does NOT match a different name (no fuzzy / phonetic matching)', () => {
      // The reviewer flagged this as a known limitation — alias hashes
      // are out of scope. Document the boundary in code so a future
      // change does not silently relax it.
      const canonical = nameHash(SCHOOL_A, 'John', 'Doe', null);
      expect(nameHash(SCHOOL_A, 'Jon', 'Doe', null)).not.toBe(canonical);
      expect(nameHash(SCHOOL_A, 'Johnny', 'Doe', null)).not.toBe(canonical);
      expect(nameHash(SCHOOL_A, 'John', 'Doh', null)).not.toBe(canonical);
    });

    it('returns 64-char hex (sha256)', () => {
      expect(nameHash(SCHOOL_A, 'a', 'b', null)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('generateQrToken', () => {
    it('produces 64 hex chars (32 bytes)', () => {
      const t = generateQrToken();
      expect(t).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces a different token every call (cryptographically random)', () => {
      const a = generateQrToken();
      const b = generateQrToken();
      expect(a).not.toBe(b);
    });
  });
});
