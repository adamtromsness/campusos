'use client';

import { cn } from '@/components/ui/cn';

// Common country options for address dropdowns. The underlying DB
// columns are free text, so an unrecognised stored value is appended
// to keep it selectable (no silent data loss on save).
export const COUNTRY_OPTIONS = [
  'United States',
  'Canada',
  'Mexico',
  'United Kingdom',
  'Australia',
  'India',
  'Germany',
  'France',
  'Other',
];

export function CountryField({
  id,
  value,
  onChange,
  disabled,
  dirty,
  required,
  error,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  dirty?: boolean;
  required?: boolean;
  error?: string;
}) {
  const options =
    COUNTRY_OPTIONS.includes(value) || !value ? COUNTRY_OPTIONS : [value, ...COUNTRY_OPTIONS];
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        Country
        {required && (
          <span className="ml-0.5 text-red-500" aria-hidden>
            *
          </span>
        )}
        {dirty && (
          <span
            aria-label="Modified"
            title="Modified — save to keep this change"
            className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle"
          />
        )}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className={cn(
          'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
          error
            ? 'border border-red-400 focus:ring-red-400'
            : dirty
              ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
              : 'border border-gray-300',
        )}
      >
        {options.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * One-line address formatter shared by the read-only "same as
 * physical address" display on the family-settings + child Contact
 * address sections. Returns '' when nothing is filled in.
 *
 *   "317 Chestnut St · Galesburg, KS, 66740-6200 · United States"
 */
export function formatAddressOneLine(parts: {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): string {
  const street = [parts.line1, parts.line2].filter(Boolean).join(', ');
  const cityLine = [parts.city, parts.state, parts.postalCode].filter(Boolean).join(', ');
  return [street, cityLine, parts.country].filter(Boolean).join(' · ');
}
