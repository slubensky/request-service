// Combines the country-code + national-number pair rendered by
// src/render/templates/phone-field.ts into a single E.164-ish `phone` value
// before a form submits. Shared by admin.js and manager.js. A no-op on any
// form that doesn't have the two fields (e.g. the bathroom-label form).
export function combinePhoneFields(formData) {
  const country = formData.get('phone_country');
  const number = formData.get('phone_number');
  if (country === null || number === null) {
    return;
  }
  formData.delete('phone_country');
  formData.delete('phone_number');
  const digits = String(number).replace(/[^0-9]/g, '');
  formData.set('phone', `${country}${digits}`);
}
