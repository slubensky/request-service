/**
 * Shared form-field validation for onboarding / console routes (see
 * src/admin/routes.ts, src/manager/routes.ts). Nothing here is trusted
 * unvalidated -- every field is length-capped and shape-checked before any
 * service call.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Requires a non-empty, length-capped field, trimmed of surrounding whitespace. */
export function requireField(
  fields: Record<string, string>,
  name: string,
  max: number,
): ParseResult<string> {
  const value = (fields[name] ?? '').trim();
  if (value.length === 0) {
    return { ok: false, error: `Missing ${name}` };
  }
  if (value.length > max) {
    return { ok: false, error: `${name} is too long` };
  }
  return { ok: true, value };
}

/**
 * Validates an invited user's phone: a lenient E.164-ish shape, length-capped.
 * Requires a leading `+` -- SNS/Cognito silently fail to deliver to a bare
 * national number with no country code, and the invite forms' client-side
 * country-code selector (src/render/templates/phone-field.ts) is the only
 * thing that guaranteed one before this; enforcing it here too protects any
 * other caller (JS-disabled clients, a direct API post).
 */
export function parsePhone(
  fields: Record<string, string>,
  fieldName = 'phone',
): ParseResult<string> {
  const field = requireField(fields, fieldName, 32);
  if (!field.ok) return field;
  if (!/^\+[0-9()\-\s]{3,31}$/.test(field.value)) {
    return { ok: false, error: `${fieldName} must include a leading + country code` };
  }
  return { ok: true, value: field.value };
}
