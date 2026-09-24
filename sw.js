/* TERM (telefon) — service worker
   Uygulama kabuğunu önbelleğe alır: internet yokken de açılır.
   Veri senkronu Firestore'un kendi çevrimdışı önbelleğiyle çalışır. */

const CACHE = 'izo-takip-v78';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './rehber.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Firebase / Google Fonts gibi dış istekleri araya girmeden geçir
  if (url.origin !== self.location.origin) return;

  // Sayfa açılışı: önce ağ, olmazsa önbellek
  if (req.mode === 'navigate'){
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Diğer yerel dosyalar: önce ağ (her zaman güncel sürüm), internet yoksa önbellek
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
