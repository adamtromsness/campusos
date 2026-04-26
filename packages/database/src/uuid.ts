/**
 * UUIDv7 Generator — ADR-002
 *
 * All CampusOS primary keys use UUIDv7, which embeds a millisecond
 * timestamp in the first 48 bits. This provides:
 * - Chronological ordering within each table
 * - No DB-level sequence coordination (critical for partitioned tables)
 * - Globally unique without a central authority
 *
 * Generated in the application layer, never by the database.
 */

import { v7 as uuidv7 } from 'uuid';

/**
 * Generate a new UUIDv7.
 * Time-ordered: UUIDs generated later sort after earlier ones.
 */
export function generateId(): string {
  return uuidv7();
}

/**
 * Extract the timestamp from a UUIDv7.
 * Useful for debugging and audit trails.
 */
export function extractTimestamp(id: string): Date {
  const hex = id.replace(/-/g, '');
  const timestampMs = parseInt(hex.substring(0, 12), 16);
  return new Date(timestampMs);
}
