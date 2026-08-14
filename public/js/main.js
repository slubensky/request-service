// Progressive-enhancement entry point. Vanilla ES module, no bundler, no
// framework: loaded directly by the browser via <script type="module">.
// The public/no-auth pages must keep working with this script absent, so
// enhancements here are additive only (never required for core content).

document.body.dataset.enhanced = 'true';
