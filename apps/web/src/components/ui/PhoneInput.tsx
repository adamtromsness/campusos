'use client';

import { useEffect, useState } from 'react';
import { formatPhoneInput, stripPhone } from '@/lib/phone-format';
import { cn } from '@/components/ui/cn';

interface PhoneInputProps {
  id?: string;
  /**
   * The current stored value (raw digits OR any historical format).
   * The input displays a formatted `(XXX) XXX-XXXX` view; onChange
   * fires with the raw-digit string the API expects.
   */
  value: string;
  onChange: (raw: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  className?: string;
  /** Add a thicker blue left border when the field is modified. */
  dirty?: boolean;
  ariaInvalid?: boolean;
}

/**
 * Auto-formatting phone input.
 *
 *   - The visible value is always `(XXX) XXX-XXXX` (US shape) — we
 *     reformat the input on every keystroke via formatPhoneInput.
 *   - The stored value the parent receives via onChange is digits
 *     only (stripPhone), so the API never sees the parens or dash.
 *   - Backspace works naturally: dropping a digit re-flows the parens
 *     and dash automatically because we re-derive from the digits.
 *   - Pasting "620-423-9355" or "(620) 423.9355" or "16204239355"
 *     all converge to the same canonical 10-digit shape.
 *
 * For international numbers (anything beyond 10 digits or non-US),
 * use a plain text input — this component caps at 10 digits.
 */
export function PhoneInput({
  id,
  value,
  onChange,
  placeholder = '(620) 423-9355',
  required,
  disabled,
  autoComplete = 'tel',
  className,
  dirty,
  ariaInvalid,
}: PhoneInputProps) {
  // The visible value is derived from the parent's stored digits.
  // Keep a local display string so a mid-typing reformat doesn't
  // throw the user off (e.g. backspacing through ") " gracefully).
  const [display, setDisplay] = useState(() => formatPhoneInput(value));
  useEffect(() => {
    setDisplay(formatPhoneInput(value));
  }, [value]);

  function onInput(next: string) {
    const formatted = formatPhoneInput(next);
    setDisplay(formatted);
    onChange(stripPhone(formatted));
  }

  return (
    <input
      id={id}
      type="tel"
      inputMode="tel"
      value={display}
      onChange={(e) => onInput(e.target.value)}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      autoComplete={autoComplete}
      aria-invalid={ariaInvalid}
      className={cn(
        'mt-1 block w-full rounded-md bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-campus-500 focus:outline-none focus:ring-2 focus:ring-campus-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
        dirty
          ? 'border border-l-[3px] border-gray-300 border-l-blue-400'
          : 'border border-gray-300',
        className,
      )}
    />
  );
}
