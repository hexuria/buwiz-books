/**
 * Service worker — installability and shell caching only.
 *
 * This is accounting software, so the caching policy is deliberately timid. The server is the
 * only authority on balances, periods and tenancy, and a stale figure served from a cache is
 * indistinguishable from a real one. The rules that follow exist to make that impossible:
 *
 *   • Only same-origin GETs for *static build assets* are cached.
 *   • Navigations are network-first, falling back to cache only when the network actually fails,
 *     and then to an offline notice.
 *   • Anything else — every non-GET, every server function, every API route, anything
 *     cross-origin — is passed straight through and never stored.
 *
 * There is no background sync and no offline write queue. A mutation attempted offline must fail
 * loudly rather than be replayed later against a ledger that has moved on.
 */

const VERSION = "v1";
const ASSET_CACHE = `buwiz-assets-${VERSION}`;
const SHELL_CACHE = `buwiz-shell-${VERSION}`;

const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/favicon.svg", "/logo192.png", "/logo512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // A single missing file must not fail the whole install, or the worker never activates.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("buwiz-") && !key.endsWith(VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Paths that must always hit the network. Kept broad on purpose. */
function isDataRequest(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_server") ||
    url.pathname.startsWith("/webhooks/") ||
    url.searchParams.has("_serverFn")
  );
}

/** Build output and static files — safe to cache because their contents are immutable per build. */
function isStaticAsset(request, url) {
  if (url.pathname.startsWith("/_build/") || url.pathname.startsWith("/assets/")) return true;
  return ["script", "style", "font", "image"].includes(request.destination);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never interfere with writes. Letting a POST fall through untouched is what keeps an offline
  // mutation an honest error instead of a silent no-op.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isDataRequest(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(request);
        return cached ?? (await caches.match(OFFLINE_URL)) ?? Response.error();
      }),
    );
    return;
  }

  if (isStaticAsset(request, url)) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        // Stale-while-revalidate: assets are content-hashed, so a stale hit is still correct.
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached ?? network;
      }),
    );
  }
});
