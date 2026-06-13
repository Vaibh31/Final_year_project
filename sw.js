// 🔥 FIX START — OBJECTIVE 9: Bump cache version to clear stale assets
const CACHE_NAME = 'brainify-v4';
// 🔥 FIX END
const ASSETS = [
  '/',
  '/landing.html',
  '/brainify.html',
  '/script.js',
  '/style.css',
  '/supabaseClient.js',
  '/manifest.json'
];

// Install Event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching static assets');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate Event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // CRITICAL: Bypassing cache for API calls and Supabase
  if (
    url.hostname.includes('supabase.co') || 
    url.hostname.includes('workers.dev') ||
    event.request.method !== 'GET'
  ) {
    return; // Let the browser handle these normally via network
  }

  // Stale-While-Revalidate for static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const cacheCopy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, cacheCopy);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Return cached version if network fails
        return cachedResponse;
      });

      return cachedResponse || fetchPromise;
    })
  );
});
