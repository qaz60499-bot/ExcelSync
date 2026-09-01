const CACHE = 'personal-cloud-shell-v3'
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/media-metadata.js', '/manifest.webmanifest']
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/photos') || url.pathname.startsWith('/files') || url.pathname.startsWith('/auth') || url.pathname.startsWith('/storage') || url.pathname.startsWith('/settings') || url.pathname.startsWith('/activity')) return
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)))
})
