/**
 * Phone-number formatting helpers.
 *
 * Display: `(620) 423-9355`
 * Input  : auto-formats as the user types so the visible value
 *          always matches the display shape.
 *
 * We keep raw digits as the storage form on the wire — the
 * formatting only lives at the UI boundary. Callers strip back to
 * digits via `stripPhone` before passing to the API, and the read
 * path calls `formatPhone` on whatever the API returns (which may
 * be digits, dashed, dotted, or anything else seeded historically).
 *
 * US-centric for now — international support would need a libphonenumber-
 * style library; deferred. Non-US-shaped numbers fall through as-is
 * so a `+44 …` value still renders without being mangled.
 */

const DIGITS = /\D/g;

/** Strip everything that isn't a digit. Used before API writes. */
export function stripPhone(raw: string): string {
  return raw.replace(DIGITS, '');
}

/**
 * Format a stored or just-typed value as `(XXX) XXX-XXXX`.
 *
 *   10 digits → strict US shape
 *   11 digits leading 1 → US with country code (drop the 1)
 *   anything else → return as-is so non-US numbers survive a round trip
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = String(raw).replace(DIGITS, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return String(raw);
}

/**
 * Format the in-progress value of a text input. Caps at 10 digits
 * so the user can't accidentally type past the US shape. Returns
 * partial shapes (`(620`, `(620) 423`, …) so the parens + dash
 * appear naturally as digits are added.
 */
export function formatPhoneInput(value: string): string {
  const digits = value.replace(DIGITS, '').slice(0, 10);
  if (digits.length === 0) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
