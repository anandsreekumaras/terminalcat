// Minimal pass-through service worker.
//
// Why this file exists at all: Chrome's PWA installability criteria
// require a registered service worker that has a `fetch` event handler.
// Without that, Android Chrome won't show the install prompt (the
// "Install" icon in the URL bar). iOS Safari uses the manifest +
// apple-mobile-web-app-* meta tags and doesn't need a SW for "Add to
// Home Screen", but it also doesn't mind that we have one.
//
// Why it does nothing useful: the project spec says "service worker NOT
// required for v1 — actively avoid stale-cache". So our `fetch` handler
// does NOT call event.respondWith — by leaving the event untouched, the
// browser handles every request normally (no caching, no rewrites,
// no offline). We just register a listener so Chrome counts us as a PWA.
//
// To remove the SW entirely:
//   1. delete this file
//   2. delete the navigator.serviceWorker.register('sw.js') call in
//      index.html
//   3. visit DevTools > Application > Service Workers > Unregister

self.addEventListener('install', () => {
  // Take over immediately — don't wait for tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim any open clients (so the new SW controls existing tabs without
  // requiring a refresh).
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Intentionally do not call event.respondWith. The browser handles the
  // request through its normal network path. The listener exists ONLY to
  // satisfy the "PWA must have a fetch handler" install rule.
});
