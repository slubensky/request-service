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

// Attaches the fetch-submit enhancement to every data-confirm-form under `root`.
// Called once for the initial page, and again after each in-place DOM swap below --
// swapping keeps this script's own execution context alive, so re-running this same
// function is all a freshly-rendered form needs (no script re-execution required).
function enhance(root) {
  root.querySelectorAll('form[data-confirm-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitForm(form).catch((error) => {
        window.alert(`Request error: ${String(error)}`);
      });
    });
  });
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

  // Swap the result page in as this document's own body -- NOT via document.write(),
  // which does not reliably re-execute <script type="module"> in the newly-written
  // document (a real browser-verified gap, not spec-guaranteed either way). That silently
  // dropped this very enhancement on the page that follows, so the next submit (e.g.
  // "Authorize hold" right after "Add a payment method") fell back to the form's native,
  // un-enhanced POST and failed the server's CSRF gate. Parsing and swapping keeps this
  // script's execution context alive, so re-running `enhance` on the new body is enough.
  const html = await response.text();
  const nextDoc = new DOMParser().parseFromString(html, 'text/html');
  document.title = nextDoc.title;
  document.body.replaceWith(nextDoc.body);
  enhance(document.body);
}

enhance(document);
