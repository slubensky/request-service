/**
 * Shared phone-entry fragment for invite forms (src/render/templates/admin.ts,
 * manager.ts). Splits country code from the national number -- like Cognito's
 * own Hosted UI sign-in field -- because a bare national number with no `+`
 * country code fails silently at SNS/Cognito send time (SDD §11.1/§11.4's SMS
 * invites need real E.164). public/js/{admin,manager}.js recombines the two
 * fields into a single `phone` value before the form is submitted.
 */
const COUNTRY_CODES: ReadonlyArray<{ code: string; label: string }> = [
  { code: '+1', label: 'United States / Canada (+1)' },
  { code: '+44', label: 'United Kingdom (+44)' },
  { code: '+61', label: 'Australia (+61)' },
  { code: '+91', label: 'India (+91)' },
  { code: '+52', label: 'Mexico (+52)' },
  { code: '+49', label: 'Germany (+49)' },
  { code: '+33', label: 'France (+33)' },
  { code: '+353', label: 'Ireland (+353)' },
];

// Doesn't depend on labelText, so it's built once here rather than on every
// renderPhoneField() call (one per site per admin/manager page render).
const COUNTRY_OPTIONS_HTML = COUNTRY_CODES.map(
  ({ code, label }) => `<option value="${code}">${label}</option>`,
).join('');

export function renderPhoneField(labelText: string): string {
  return `
          <label>${labelText}
            <span class="phone-field">
              <select name="phone_country" required aria-label="Country code">${COUNTRY_OPTIONS_HTML}</select>
              <input name="phone_number" required maxlength="20" inputmode="tel" autocomplete="off" placeholder="Phone number" />
            </span>
          </label>`;
}
