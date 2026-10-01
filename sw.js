// ============================================================
// MicoHunter — service worker
// ============================================================
//
// Por qué existe esto: GitHub Pages sirve los ficheros con
// `cache-control: max-age=600`, o sea, diez minutos de caché. Con eso el
// móvil puede descargar el index.html nuevo y, de la caché, un styles.css
// viejo, y la página queda descuadrada. La solución habitual es poner un
// parámetro de versión en cada URL, pero eso obliga a editar el HTML a mano
// en cada subida, que es un paso que se acaba olvidando.
//
// Este service worker elimina ese paso. Estrategia RED PRIMERO: siempre se
// pregunta a la red y sólo si falla se usa la copia guardada. Como la copia
// guardada nunca se sirve mientras haya red, no puede haber versiones
// mezcladas, y no hace falta tocar nada al publicar.
//
// Lo que NO se cachea: nada externo (los datos de Open-Meteo, SoilGrids,
// Nominatim y los mosaicos de OpenStreetMap). Cachear eso daría resultados
// meteorológicos viejos, que es justo lo que no queremos en una app de
// predicciones.

const CACHE = 'micohunter-v1';

self.addEventListener('install', event => {
  // No se precachea nada: la app tiene cuatro ficheros y todos se piden
  // igualmente. Se activa de inmediato para no esperar a la siguiente visita.
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Borra cualquier caché de versiones anteriores de este worker.
    const claves = await caches.keys();
    await Promise.all(
      claves.filter(k => k !== CACHE).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Sólo los ficheros de la propia aplicación. Todo lo demás (las APIs
  // meteorológicas, el suelo, los nombres de lugar y los tiles del mapa) pasa
  // directo a la red, sin caché y sin intervención: son datos vivos.
  if (url.origin !== self.location.origin) return;
  if (!/\.(?:html|css|js)$/.test(url.pathname)) return;

  event.respondWith((async () => {
    try {
      const respuesta = await fetch(req, { cache: 'no-store' });
      if (respuesta && respuesta.ok) {
        const copia = respuesta.clone();
        const c = await caches.open(CACHE);
        c.put(req, copia);
      }
      return respuesta;
    } catch (e) {
      // Sin red: se sirve la última copia conocida.
      const guardada = await caches.match(req);
      if (guardada) return guardada;
      return new Response(
        'Sin conexión y sin copia guardada de este recurso.',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }
  })());
});
