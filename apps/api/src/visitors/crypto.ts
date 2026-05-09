import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'crypto';

/**
 * P2C1 Visitor Management — encryption + HMAC blind index helpers.
 *
 * Two distinct primitives:
 *
 * 1. AES-256-GCM at-rest encryption for vis_visitors.email_encrypted
 *    and phone_encrypted. Wire format mirrors Cycle 22 IT vault:
 *    base64(iv).base64(authTag).base64(ciphertext). 12-byte iv,
 *    16-byte auth tag.
 *
 * 2. HMAC-SHA256 blind index for vis_visitors.email_hash /
 *    phone_hash + vis_banned_persons.name_hash. Equality lookup
 *    only — kiosk computes HMAC of input and matches against the
 *    indexed column. Never reveals plaintext.
 *
 * Production deployments MUST set both env vars. Dev/test fall
 * back to deterministic seed strings so the seeded ciphertext +
 * blind indexes decrypt / match cleanly through the same module.
 * The fail-closed check below mirrors REVIEW-CYCLE22 BLOCKING 5
 * for the credential vault.
 */

const NODE_ENV = process.env.NODE_ENV || 'development';
if (
  NODE_ENV === 'production' &&
  (!process.env.VISITOR_PII_KEY || !process.env.VISITOR_HMAC_SECRET)
) {
  throw new Error(
    'VISITOR_PII_KEY and VISITOR_HMAC_SECRET are both required in production — falling back to deterministic seed material would defeat ADR-015 PII protection.',
  );
}

const KEY_MATERIAL = process.env.VISITOR_PII_KEY || 'campusos-demo-visitor-pii-key-2026';
const KEY_SALT = 'campusos-demo-visitor-salt';
const HMAC_SECRET = process.env.VISITOR_HMAC_SECRET || 'campusos-demo-visitor-hmac-secret-2026';

function deriveKey(): Buffer {
  return scryptSync(KEY_MATERIAL, KEY_SALT, 32);
}

export function encryptPII(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptPII(wire: string | null | undefined): string | null {
  if (wire == null) return null;
  const parts = wire.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid visitor PII ciphertext format');
  }
  const iv = Buffer.from(parts[0]!, 'base64');
  const tag = Buffer.from(parts[1]!, 'base64');
  const enc = Buffer.from(parts[2]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * REVIEW-P2C1 MAJOR 1 — every blind index now binds to schoolId.
 *
 * The HMAC material includes the schoolId UUID so the same email /
 * phone / name in two different schools (within or across tenants)
 * produces two different hashes. Defends against cross-school
 * correlation by anyone who reads the hash columns directly (a
 * compromised replica reader, a leaked logical backup, an analytics
 * pipeline that copies the hash into a less-secured store).
 *
 * Material shape:
 *   email_hash = HMAC_SHA256(secret, schoolId + '|' + lowercase(trim(email)))
 *   phone_hash = HMAC_SHA256(secret, schoolId + '|' + e164ish(phone))
 *   name_hash  = HMAC_SHA256(secret, schoolId + '|' + normalised + (dob ? '|' + dob : ''))
 *
 * The schoolId is supplied by the caller (always pulled from
 * getCurrentTenant() at the service layer) so the hash function
 * remains pure.
 */

/**
 * Email blind index. Lower-case + trim before hashing so case +
 * whitespace variants resolve to the same returning visitor within
 * a school. Cross-school the same email produces a different hash.
 */
export function emailHash(schoolId: string, email: string): string {
  const normalised = email.toLowerCase().trim();
  return createHmac('sha256', HMAC_SECRET)
    .update(schoolId + '|' + normalised)
    .digest('hex');
}

/**
 * Phone blind index. Strip everything that is not a digit or `+`
 * so different formatting (spaces, dashes, parens) of the same
 * number collapse to the same hash. Returns null when input is
 * blank.
 */
export function phoneHash(schoolId: string, phone: string | null | undefined): string | null {
  if (phone == null || phone.trim() === '') return null;
  const normalised = phone.replace(/[^0-9+]/g, '');
  if (normalised === '') return null;
  return createHmac('sha256', HMAC_SECRET)
    .update(schoolId + '|' + normalised)
    .digest('hex');
}

/**
 * Banned-persons name hash. SAFETY KEYSTONE — used by the kiosk on
 * every sign-in to detect a banned person.
 *
 * REVIEW-P2C1 MAJOR 3 — stronger normalisation than first-pass:
 *   1. NFKD Unicode normalize — composed → decomposed form.
 *   2. Strip diacritics — combining marks dropped (José → Jose).
 *   3. Lowercase.
 *   4. Strip non-letter / non-digit / non-space characters
 *      (punctuation, dashes, apostrophes — O'Brien → o brien).
 *   5. Collapse whitespace runs to a single space + trim.
 *
 * Both first + last names go through the pipeline before the join.
 * The DOB (when supplied) is appended after a `|` separator. The
 * schoolId is the first segment to bind the hash to a school.
 *
 * Trade-off: the canonical hash is exact-match on the normalised
 * string. Aliases / phonetic / fuzzy matching are out of scope —
 * the admin workflow handles aliases by recording multiple
 * banned-person rows (one per alias). Unicode normalisation alone
 * closes the trivial bypass paths (accents, case, punctuation).
 */
export function normaliseNameComponent(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameHash(
  schoolId: string,
  firstName: string,
  lastName: string,
  dob?: string | null,
): string {
  const first = normaliseNameComponent(firstName);
  const last = normaliseNameComponent(lastName);
  const fullName = (first + ' ' + last).trim();
  const material = schoolId + '|' + fullName + (dob ? '|' + dob : '');
  return createHmac('sha256', HMAC_SECRET).update(material).digest('hex');
}

/**
 * 32-byte hex token for vis_pre_registrations.qr_code_token.
 * Cryptographically unguessable; the kiosk POST /pre-register/scan
 * is the only resolver. crypto.randomBytes is the same primitive
 * Cycle 24 portfolio share links use.
 */
export function generateQrToken(): string {
  return randomBytes(32).toString('hex');
}
