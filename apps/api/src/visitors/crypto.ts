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
 * Email blind index. Lower-case + trim before hashing so case +
 * whitespace variants resolve to the same returning visitor.
 */
export function emailHash(email: string): string {
  const normalised = email.toLowerCase().trim();
  return createHmac('sha256', HMAC_SECRET).update(normalised).digest('hex');
}

/**
 * Phone blind index. Strip everything that is not a digit or `+`
 * so different formatting (spaces, dashes, parens) of the same
 * number collapse to the same hash. Returns null when input is
 * blank.
 */
export function phoneHash(phone: string | null | undefined): string | null {
  if (phone == null || phone.trim() === '') return null;
  const normalised = phone.replace(/[^0-9+]/g, '');
  if (normalised === '') return null;
  return createHmac('sha256', HMAC_SECRET).update(normalised).digest('hex');
}

/**
 * Banned-persons name hash. SAFETY KEYSTONE — used by the kiosk
 * on every sign-in to detect a banned person. Normalisation:
 * lowercase + trim each part, join with a single space, optionally
 * append the DOB ISO string after a `|` separator. The DOB is
 * optional because some bans are name-only.
 *
 * The kiosk computes this hash from the entered name + DOB and
 * SELECTs WHERE name_hash = $computed AND is_active = true. A
 * match BLOCKS sign-in, never reveals why, and emits
 * vis.banned_person.detected to alert the safeguarding officer.
 */
export function nameHash(firstName: string, lastName: string, dob?: string | null): string {
  const normalised = (firstName.trim().toLowerCase() + ' ' + lastName.trim().toLowerCase()).trim();
  const material = dob ? normalised + '|' + dob : normalised;
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
