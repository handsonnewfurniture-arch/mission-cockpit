// Service Worker — OpenStreetMap Tile Caching
// Cache-first strategy for map tiles, passthrough for everything else

var TILE_CACHE = 'cockpit-tiles-v1';

self.addEventListener('install', function(event) {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {
    var url = event.request.url;

    // Only cache OpenStreetMap tile requests
    if (url.indexOf('tile.openstreetmap.org') !== -1) {
        event.respondWith(
            caches.open(TILE_CACHE).then(function(cache) {
                return cache.match(event.request).then(function(cached) {
                    if (cached) return cached;
                    return fetch(event.request).then(function(response) {
                        if (response.ok) {
                            cache.put(event.request, response.clone());
                        }
                        return response;
                    }).catch(function() {
                        // Offline and not cached — return empty transparent PNG
                        return new Response(
                            atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='),
                            { headers: { 'Content-Type': 'image/png' } }
                        );
                    });
                });
            })
        );
        return;
    }

    // All other requests — pass through normally
});
