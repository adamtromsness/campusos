/**
 * Substitute {placeholder} tokens in a template against a flat key/value
 * lookup. Used by the Step 4 TaskWorker to render auto-task title and
 * description templates from the inbound Kafka event payload.
 *
 *   renderTemplate('Complete: {assignment_title}', { assignment_title: 'Quadratics HW' })
 *     // → 'Complete: Quadratics HW'
 *
 * Placeholders missing from the lookup are left as-is so a surface bug is
 * loud (the user sees `{assignment_title}` rather than a silently-empty
 * string). Null and undefined values are treated as missing for the same
 * reason.
 */
export function renderTemplate(
  template: string,
  values: Record<string, unknown>,
): string {
  return template.replace(/\{(\w+)\}/g, function (match, key: string) {
    const v = values[key];
    if (v === undefined || v === null) return match;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  });
}

/**
 * Build a placeholder lookup from an event payload. Flattens common
 * camelCase fields into snake_case so the templates can use either form
 * (`{studentId}` and `{student_id}` both resolve). The seed templates
 * use the snake_case form per ADR-057 wire convention.
 */
export function buildPlaceholderValues(
  payload: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = v;
    out[camelToSnake(k)] = v;
  }
  for (const [k, v] of Object.entries(extras)) {
    out[k] = v;
    out[camelToSnake(k)] = v;
  }
  return out;
}

function camelToSnake(s: string): string {
  return s.replace(/([A-Z])/g, function (_m, ch: string) {
    return '_' + ch.toLowerCase();
  });
}
