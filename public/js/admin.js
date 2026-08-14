// Company-Admin console enhancement. Vanilla ES module, no bundler, no
// framework. It intercepts onboarding form submissions and replays them via
// fetch so the session-bound CSRF token can travel in the `x-csrf-token`
// header (HTML forms cannot set headers). This script is required only for the
// internal admin console; the public visitor page loads no JS at all.

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

  if (!response.ok) {
    const detail = await response.text();
    window.alert(`Action failed (${response.status}): ${detail}`);
    return;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    // A page result (e.g. the issued QR); render it in place.
    const html = await response.text();
    document.open();
    document.write(html);
    document.close();
    return;
  }

  // A no-content mutation; reload to reflect the new state.
  window.location.reload();
}

document.querySelectorAll('form[data-admin-form]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(form).catch((error) => {
      window.alert(`Request error: ${String(error)}`);
    });
  });
});
