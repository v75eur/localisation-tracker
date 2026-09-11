const CACHE = 'tracker-v1';
const URLS = ['/', '/index.html', '/style.css', '/app.js'];
self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(URLS)));
    self.skipWaiting();
});
self.addEventListener('fetch', e => {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
