// Site Manager console enhancement. Vanilla ES module, no bundler, no
// framework. Mirrors public/js/admin.js: it intercepts invite form
// submissions and replays them via fetch so the session-bound CSRF token can
// travel in the `x-csrf-token` header (HTML forms cannot set headers).

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

  // A no-content mutation; reload to reflect the new pending invite.
  window.location.reload();
}

document.querySelectorAll('form[data-manager-form]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(form).catch((error) => {
      window.alert(`Request error: ${String(error)}`);
    });
  });
});
