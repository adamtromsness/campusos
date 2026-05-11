import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * P2-13c Locker combination encryption.
 *
 * AES-256-GCM at-rest encryption for sis_lockers.combination_encrypted.
 * Wire format mirrors P2C1 visitor PII plus Cycle 22 IT vault:
 *   base64(iv).base64(authTag).base64(ciphertext)
 * 12-byte iv, 16-byte auth tag.
 *
 * Production deployments MUST set SIS_LOCKER_KEY. Dev/test fall back
 * to the deterministic seed string so the seeded ciphertext decrypts
 * cleanly through the same module. Fail-closed in production mirrors
 * REVIEW-CYCLE22 BLOCKING 5 and P2C1.
 */

const NODE_ENV = process.env.NODE_ENV || 'development';
if (NODE_ENV === 'production' && !process.env.SIS_LOCKER_KEY) {
  throw new Error(
    'SIS_LOCKER_KEY is required in production — falling back to deterministic seed material would defeat at-rest encryption of locker combinations.',
  );
}

const KEY_MATERIAL = process.env.SIS_LOCKER_KEY || 'campusos-demo-locker-combination-key-2026';
const KEY_SALT = 'campusos-demo-locker-salt';

function deriveKey(): Buffer {
  return scryptSync(KEY_MATERIAL, KEY_SALT, 32);
}

export function encryptCombination(plaintext: string): string {
  if (plaintext == null || plaintext === '') {
    throw new Error('encryptCombination requires a non-empty plaintext combination.');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptCombination(wire: string | null | undefined): string | null {
  if (wire == null || wire === '') return null;
  const parts = wire.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid locker combination ciphertext format');
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
 * Generate a random 3-section combination of the shape NN-NN-NN.
 * Each segment is 2 digits 00..49 — matches the common school locker
 * combination range.
 */
export function generateCombination(): string {
  const a = Math.floor(Math.random() * 50)
    .toString()
    .padStart(2, '0');
  const b = Math.floor(Math.random() * 50)
    .toString()
    .padStart(2, '0');
  const c = Math.floor(Math.random() * 50)
    .toString()
    .padStart(2, '0');
  return `${a}-${b}-${c}`;
}
