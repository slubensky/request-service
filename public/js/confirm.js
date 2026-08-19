// Price-confirmation page enhancement. Vanilla ES module, no bundler, no
// framework. Mirrors public/js/admin.js: it intercepts the authorize-hold /
// add-payment-method form submissions and replays them via fetch so the
// session-bound CSRF token can travel in the `x-csrf-token` header (HTML
// forms cannot set headers). This script loads only on the authenticated
// confirm page -- the neutral public visitor page ships no JS at all.

function csrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

async function submitForm(form) {
  const body = new URLSearchParams(new FormData(form)).toString();
  const response = await fetch(form.action, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': csrfToken() ?? '',
    },
    body,
  });

  if (response.status === 401) {
    // Step-up re-authentication required (SDD §6.4): send the browser through login and
    // back to this same page, rather than a dead-end alert.
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/auth/login?next=${next}`;
    return;
  }

  if (!response.ok) {
    const detail = await response.text();
    window.alert(`Action failed (${response.status}): ${detail}`);
    return;
  }

  // The result page is rendered in place, same as the admin console's QR-issued result.
  const html = await response.text();
  document.open();
  document.write(html);
  document.close();
}

document.querySelectorAll('form[data-confirm-form]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(form).catch((error) => {
      window.alert(`Request error: ${String(error)}`);
    });
  });
});
