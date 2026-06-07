const CACHE_NAME = 'novel-reader-static-v1';
const DATA_CACHE_NAME = 'novel-reader-chapters-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&display=swap',
  'https://fonts.gstatic.com/s/materialicons/v140/flUhRq6tzZclQEJ-Vdg-IuiaDsNcIhQ8tQ.woff2'
];

// Install Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching static assets...');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Service Worker
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME && key !== DATA_CACHE_NAME) {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Intercept Network Requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Check if this is an API call for a chapter reader page
  // Route matches: /api/novels/:slug/:chapter (e.g. /api/novels/supreme-magus/1)
  const isChapterApi = url.pathname.startsWith('/api/novels/') && 
                       url.pathname.split('/').filter(Boolean).length === 4;

  if (isChapterApi) {
    event.respondWith(
      caches.open(DATA_CACHE_NAME).then((cache) => {
        return fetch(event.request)
          .then((response) => {
            // If response is good, clone it and put in cache
            if (response.status === 200) {
              cache.put(event.request.url, response.clone());
            }
            return response;
          })
          .catch(() => {
            // Network failed, try to serve from cache
            console.log('[SW] Serving cached chapter offline:', url.pathname);
            return cache.match(event.request.url).then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              // If not found in cache, return an error json
              return new Response(
                JSON.stringify({
                  error: 'Offline mode active',
                  details: 'Bu bölüm henüz indirilmemiş ve internet bağlantısı yok.',
                  isOfflineError: true
                }),
                {
                  status: 503,
                  headers: { 'Content-Type': 'application/json' }
                }
              );
            });
          });
      })
    );
  } else {
    // Strategy for other requests (static assets, images, details): Network-first falling back to Cache
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache proxy image calls too
          if (url.pathname.includes('/api/proxy-image') && response.status === 200) {
            const cacheClone = response.clone();
            caches.open(DATA_CACHE_NAME).then(cache => cache.put(event.request.url, cacheClone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            // If index.html fallback is needed
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
          });
        })
    );
  }
});
