'use client';

import { cn } from '@/components/ui/cn';

export type FamilyCustomValue = 'FAMILY' | 'CUSTOM';

/**
 * Pill-style two-button switcher for family-inheritance sections
 * (home address, emergency contacts, doctor & insurance, …). One
 * canonical look across every section that offers a "use the family
 * default vs. override for this record" choice.
 *
 *   Active   → dark fill (bg-gray-800 text-white)
 *   Inactive → outline (border-gray-300 text-gray-600)
 *
 * `disabled` covers the in-flight-mutation case (the toggles that
 * persist immediately disable while the PATCH is pending).
 */
export function FamilyCustomToggle({
  value,
  onChange,
  familyLabel = 'Use family',
  customLabel = 'Use custom',
  disabled = false,
}: {
  value: FamilyCustomValue;
  onChange: (value: FamilyCustomValue) => void;
  familyLabel?: string;
  customLabel?: string;
  disabled?: boolean;
}) {
  const options: Array<{ key: FamilyCustomValue; label: string }> = [
    { key: 'FAMILY', label: familyLabel },
    { key: 'CUSTOM', label: customLabel },
  ];
  return (
    <div className="inline-flex gap-1.5">
      {options.map((opt) => {
        const active = value === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            disabled={disabled}
            aria-pressed={active}
            className={cn(
              'rounded-lg border px-3 py-1 text-xs font-medium transition-colors',
              active
                ? 'border-gray-800 bg-gray-800 text-white'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
