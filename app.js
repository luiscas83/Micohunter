// ============================================================
// MicoHunter — Lógica de aplicación
// ============================================================
// ============================================================
// MicoHunter — Lógica de aplicación
// ============================================================

/**
 * Punto inicial: pinares de Soria, en torno a Vinuesa (sierra de Pina).
 * Elegido porque es pinar de *Pinus* puro sobre suelo ácido, con ~1050 m, que
 * es donde el modelo da valores representativos: a 711 m y con el suelo a
 * 22 °C en octubre, casi todas las especies salen a cero y el arranque no
 * dice nada útil.
 */
const INICIO = { lat: 41.76, lng: -2.53 };

/**
 * Vista inicial del mapa: toda la España peninsular, sin zoom.
 * El marcador se sitúa aparte, en el punto de análisis, así que se ve dónde
 * está el setal dentro del país. Al pulsar en el mapa o elegir un setal, la
 * vista salta al detalle.
 */
const VISTA_ESPANA = { lat: 39.9, lng: -3.4, zoom: 5 };

let selectedLat = INICIO.lat;
let selectedLng = INICIO.lng;
let favorites = [];
let selectedMushrooms = SPECIES.map(sp => sp.key);   // todas, por orden de prioridad
let currentCtx = null;      // lo que consume el modelo: historial, lluvia, altitud, suelo
let currentMeteo = null;    // meteorología completa: aire, humedad, fechas
let lugarActual = null;     // topónimo resuelto, para nombrar al guardar
let peticionActual = 0;     // testigo: descarta respuestas de puntos viejos
let puntoCargado = null;    // {lat, lng} de lo que hay ahora en pantalla
let currentRanking = [];
let map = null;
let marker = null;

const FAV_KEY = 'micohunter_favorites';
const MUSH_KEY = 'micohunter_selected_mushrooms';

// ------------------------------------------------------------
// Inicialización
// ------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  loadFavorites();
  loadSelectedMushrooms();
  initNavigation();
  initMap();
  initFavorites();
  initMushroomSelector();
  initSearch();
  initGeoSelect();
  refresh();
});

function initNavigation() {
  const btns = document.querySelectorAll('.nav-btn');
  const secs = document.querySelectorAll('.section');

  btns.forEach(b => b.addEventListener('click', () => {
    btns.forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    secs.forEach(s => s.classList.remove('active'));
    document.getElementById(b.dataset.section).classList.add('active');
  }));
}

// ------------------------------------------------------------
// Mapa
// ------------------------------------------------------------

function initMap() {
  map = L.map('dashboardMap').setView([VISTA_ESPANA.lat, VISTA_ESPANA.lng], VISTA_ESPANA.zoom);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 18,
  }).addTo(map);

  moveMarker(selectedLat, selectedLng, false);

  map.on('click', async e => {
    await setLocation(e.latlng.lat, e.latlng.lng);
  });

  /*
   * Leaflet se guarda el tamaño del contenedor en el momento de crearse y no
   * lo vuelve a mirar: sólo escucha el redimensionado de la VENTANA. Como aquí
   * el mapa crece cuando la ficha de suelo y clima marca la altura, se quedaba
   * con la medida antigua y pasaba algo muy gordo: al convertir la posición del
   * ratón en coordenadas usaba una altura equivocada, así que un clic en el
   * centro del mapa caía a kilómetros del sitio que se veía, y además quedaban
   * 100 px de mapa sin teselas.
   *
   * Por eso se le avisa a mano en los puntos donde la ficha cambia de alto
   * (ajustarMapa) y al redimensionar la ventana. No se usa ResizeObserver ni
   * requestAnimationFrame a propósito: el primero no llega a dispararse y el
   * segundo se congela en las pestañas que están en segundo plano, que es
   * justo cuando el mapa se queda con la medida equivocada.
   */
  let temporizador = null;
  window.addEventListener('resize', () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(ajustarMapa, 150);
  });
}

/**
 * Le dice a Leaflet que mida otra vez el contenedor del mapa.
 *
 * Es barato (una medición) y hay que llamarla después de cualquier cambio que
 * altere el alto de la ficha de suelo y clima, porque de él depende el alto
 * del mapa.
 */
function ajustarMapa() {
  if (map) map.invalidateSize({ animate: false });
}

function moveMarker(lat, lng, recentrar = true) {
  if (marker) map.removeLayer(marker);
  const icon = L.divIcon({
    className: 'custom-marker',
    html: '🍄',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
  marker = L.marker([lat, lng], { icon }).addTo(map);
  if (recentrar) map.setView([lat, lng], 11);
}

// ------------------------------------------------------------
// Cambio de ubicación
// ------------------------------------------------------------

/**
 * Separación aproximada entre dos puntos, en metros.
 *
 * No hace falta precisión geodésica: sólo se usa para decidir si dos clics
 * están en el mismo sitio. La longitud de un grado se estrecha con la
 * latitud (en el centro de España, un grado de longitud son unos 78 km,
 * no 111), y por eso va multiplicada por el coseno.
 */
function metrosEntre(lat1, lon1, lat2, lon2) {
  const mPorGrado = 111320;
  const dLat = (lat2 - lat1) * mPorGrado;
  const dLon = (lon2 - lon1) * mPorGrado * Math.cos(lat1 * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * Margen a partir del cual dos clics se consideran el mismo punto.
 *
 * No es un capricho: es la resolución de las propias fuentes. SoilGrids
 * de 250 m y la rejilla de Open-Meteo es de unos 11 km, así que dentro de
 * medio kilómetro los números devueltos serían los mismos con total
 * seguridad. Con 500 m, además, un clic que se equivoca por unos píxeles no
 * gasta una consulta.
 */
const MISMO_PUNTO_M = 500;

async function setLocation(lat, lng) {
  const yaCargado = puntoCargado !== null
    && metrosEntre(puntoCargado.lat, puntoCargado.lng, lat, lng) < MISMO_PUNTO_M;

  selectedLat = lat;
  selectedLng = lng;
  moveMarker(lat, lng);

  // Segundo clic sobre el mismo sitio: los datos que ya están en pantalla
  // son los de este punto, así que no hay nada que pedir. Saltarse esto
  // importa, porque SoilGrids admite 5 consultas por minuto y Open-Meteo
  // es un servicio compartido.
  if (yaCargado) {
    notify('Ya tienes los datos de este punto');
    return;
  }

  await refresh();
}

/**
 * Carga los datos del punto elegido y repinta, en dos fases.
 *
 * La meteorología de Open-Meteo tarda unos 40 ms, así que se pinta de
 * inmediato. SoilGrids (ISRIC) es otra cosa: se han medido respuestas de más
 * de 40 segundos para un solo píxel, además de su límite de 5 consultas por
 * minuto. Por eso el suelo NO bloquea: la primera pasada usa el suelo vacío,
 * y cuando llega se vuelve a pintar todo.
 */
async function refresh() {
  // Testigo de petición. Antes se comparaban las coordenadas de la respuesta
  // con las actuales, pero la comprobación usaba m.lng cuando meteo() devuelve
  // la propiedad llamada "lon": m.lng era siempre undefined, la comparación
  // fallaba siempre y el suelo se descartaba el 100 % de las veces. Un
  // testigo no depende de nombres de propiedades.
  const testigo = ++peticionActual;

  showLoading(true);
  let m;
  try {
    m = await conTiempoLimite(
      meteo(selectedLat, selectedLng, 30),
      20000,
      'Open-Meteo no respondió en 20 s'
    );
  } catch (e) {
    console.error(e);
    if (testigo === peticionActual) {
      notify(String(e.message || e), 'error');
      showLoading(false);
    }
    return;
  }

  if (testigo !== peticionActual) return;   // el usuario ya se movió

  // A partir de aquí hay datos de este punto en pantalla, así que un clic
  // sobre el mismo sitio ya no tiene que volver a pedir nada.
  puntoCargado = { lat: selectedLat, lng: selectedLng };

  // Primera pasada: meteorología sí, suelo todavía no.
  aplicarDatos(m, SIN_SUELO);
  showLoading(false);

  // Segunda pasada: el suelo, cuando llegue. No bloquea nada.
  try {
    const s = await conTiempoLimite(
      suelo(selectedLat, selectedLng),
      90000,
      'SoilGrids no respondió en 90 s'
    );
    if (testigo !== peticionActual) return;   // punto cambiado: se descarta

    if (s.ok) {
      // Repintado quirúrgico: sólo cambia lo que depende del suelo. La
      // textura y el pH se escriben en sus campos y los factores de hábitat
      // se recalculan, sin tocar el mapa ni reconstruir todas las tarjetas.
      actualizarSoloSuelo(s);
      if (s.parcial) {
        setSoilHint('Faltan propiedades de SoilGrids: se muestran las disponibles');
      }
    } else {
      marcarSueloFallido(s.error || 'SoilGrids no disponible');
    }
  } catch (e) {
    console.warn(e);
    if (testigo === peticionActual) marcarSueloFallido(String(e.message || e));
  }
}

/**
 * Segunda fase: llega el suelo y sólo se actualiza lo que depende de él.
 *
 * Antes esto llamaba a aplicarDatos(), que rehacía todas las tarjetas con
 * innerHTML. Eso destruía el nodo que tenía el foco y, con ello, la posición
 * del scroll: si habías bajado a mirar las tarjetas, la página te volvía
 * arriba de golpe. Como ISRIC puede tardar 30-50 s, el salto era muy visible.
 */
function actualizarSoloSuelo(s) {
  const m = currentMeteo;
  if (!m) return;

  currentCtx.suelo = s;
  currentCtx.terreno.ph = s.ok ? s.ph : null;
  currentCtx.terreno.humedad = s.phGrupo === 'calizo' ? 'seco' : s.ok ? 'normal' : null;
  currentRanking = ranking(currentCtx);

  set('soilTypeValue', s.textura ? capitalize(s.textura) : 'no disponible');
  set('phValue', s.ph != null ? s.ph.toFixed(1) : '—');
  renderTerreno(m, s);
  renderAnalisis();
  refrescarFactoresHabitat();
  ajustarMapa();
}

/** Reescribe sólo el factor de hábitat de las tarjetas ya pintadas. */
function refrescarFactoresHabitat() {
  document.querySelectorAll('.mushroom-cards-grid .mushroom-card').forEach(card => {
    const nombre = card.querySelector('.mushroom-name');
    if (!nombre) return;
    const sp = SPECIES.find(x => x.es === nombre.textContent);
    if (!sp) return;
    const r = currentRanking.find(x => x.sp.key === sp.key);
    if (!r) return;

    // Factor de hábitat dentro de la rejilla de detalles
    const items = [...card.querySelectorAll('.mushroom-detail-item')];
    const itemHab = items.find(el => el.querySelector('.mushroom-detail-label')
      ?.textContent.startsWith('Factor hábitat'));
    if (itemHab) {
      itemHab.querySelector('.mushroom-detail-value').textContent =
        `${Math.round(r.detalle.habFactor * 100)}%${r.detalle.habConfuso ? ' (bajo)' : ''}`;
    }

    // El factor de suelo también cambia cuando llega SoilGrids, así que esta
    // actualización quirúrgica tiene que reescribirlo o se quedaría con el
    // "sin dato de pH" del primer pintado.
    const itemSuelo = items.find(el => el.querySelector('.mushroom-detail-label')
      ?.textContent.startsWith('Factor de suelo'));
    if (itemSuelo) {
      itemSuelo.querySelector('.mushroom-detail-value').textContent =
        r.detalle.sueloConocido
          ? `${Math.round(r.detalle.sueloFactor * 100)}% · ${r.detalle.sueloEtiqueta}`
          : 'sin dato de pH';
    }

    // La helada se recalcula con el mismo refresco, así que también hay que
    // reescribir su fila o se quedaría con lo del primer pintado.
    const itemHelada = items.find(el => el.querySelector('.mushroom-detail-label')
      ?.textContent.startsWith('Helada reciente'));
    if (itemHelada) {
      itemHelada.querySelector('.mushroom-detail-value').textContent =
        textoHelada(r.detalle);
    }

    // Etiqueta de hábitat estimado
    const cond = [...card.querySelectorAll('.condition-item')]
      .find(el => el.textContent.includes('Hábitat estimado'));
    if (cond) {
      const v = cond.querySelector('.condition-value');
      if (v) v.textContent = cap(r.detalle.habEtiqueta) || '—';
    }

    // El índice y el anillo cambian con el pH, así que también se actualizan
    const pctEl = card.querySelector('.percentage');
    if (pctEl) pctEl.textContent = Math.round(r.I);
    const anillo = card.querySelector('.ring-fill');
    if (anillo) {
      const C = 2 * Math.PI * 45;
      anillo.style.strokeDashoffset = C - (r.I / 100) * C;
    }
    const nivel = nivelTexto(r.I);
    const banner = card.querySelector('.prediction-banner');
    if (banner) {
      banner.className = `prediction-banner ${nivel.clase}`;
      const t = banner.querySelector('.prediction-text');
      if (t) t.textContent = nivel.texto;
    }
  });
}

/** Placeholder de suelo mientras ISRIC responde. */
const SIN_SUELO = {
  textura: null, ph: null, phGrupo: null,
  arena: null, arcilla: null, limo: null, costero: null,
  ok: false, pendiente: true, error: 'consultando SoilGrids…',
};

/** Rechaza la promesa si tarda más de `ms` milisegundos. */
function conTiempoLimite(promesa, ms, mensaje) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(mensaje)), ms);
    promesa.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

function setSoilHint(msg) {
  const e = document.getElementById('soilSummary');
  if (e) e.innerHTML = `<span class="soil-unavailable">${escaparHtml(msg)}</span>`;
  // El resumen del suelo es lo que más crece o mengua de la ficha, y de su
  // alto depende el del mapa.
  ajustarMapa();
}

/**
 * Estado terminal del suelo: no se pudo consultar.
 *
 * Antes, si SoilGrids fallaba o se agotaba el tiempo, sólo se escribía el
 * aviso en el resumen y los campos Textura y pH se quedaban frozen en
 * "consultando…" para siempre, que es peor que un fallo honesto.
 */
function marcarSueloFallido(msg) {
  set('soilTypeValue', 'no disponible');
  set('phValue', '—');
  setSoilHint(msg + ' · el resto de los datos sí son válidos');
}

/** Calcula el ranking y repinta todo con la meteorología y el suelo dados. */
function aplicarDatos(m, s) {
  // El término "sustrato leñoso" no se puede inferir de coordenadas con
  // fiabilidad. Se pasa null (desconocido) para que la penalización de
  // los saprofitas lignícolas no se aplique a ciegas.
  const terreno = {
    vegetacion: inferirVegetacion(selectedLat, selectedLng),
    exposicion: null,
    humedad: s.phGrupo === 'calizo' ? 'seco' : s.ok ? 'normal' : null,
    hayMadera: null,
    ph: s.ok ? s.ph : null,
  };

  currentCtx = {
    historial: m.historial,
    lluvia30: m.lluvia30,
    altitude: m.altitud,
    tSuelo: m.tSuelo,
    tSuelo0: m.tSuelo0,
    terreno,
    suelo: s,
  };
  currentMeteo = m;
  currentCtx.mes = m.mes;   // ventana de temporada documentada por especie
  currentRanking = ranking(currentCtx);

  updateLocationInfo(m, s);
  renderEstado();
  renderTerreno(m, s);
  renderTarjetas();
  renderAnalisis();
  renderGeoselector();

  // La ficha de suelo ya tiene su alto definitivo: el mapa se mide otra vez.
  ajustarMapa();
}

// ------------------------------------------------------------
// Ubicación / terreno
// ------------------------------------------------------------

/** Escribe texto en un elemento por id, si existe. */
function set(id, v) {
  const e = document.getElementById(id);
  if (e) e.textContent = v;
}

async function updateLocationInfo(m, s) {
  // Placeholder inmediato. El topónimo real tarda en volver de Nominatim, y
  // sin esto habría una ventana en la que `lugarActual` es null y el nombre
  // propuesto al guardar sería "Ubicación N" en vez del pueblo real.
  lugarActual = null;
  set('locationName', coordsTexto(selectedLat, selectedLng));

  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${selectedLat}&lon=${selectedLng}&zoom=10&addressdetails=1`
    );
    const j = await r.json();
    if (j?.address) {
      const a = j.address;
      const lugar = a.town || a.village || a.city || a.municipality || a.county;
      if (lugar) {
        lugarActual = lugar;
        set('locationName', lugar);
      }
    }
  } catch {
    // Nominatim caído o bloqueado: se queda con las coordenadas.
  }
  set('coordinatesValue', coordsTexto(selectedLat, selectedLng));
  set('altitudeValue', `${m.altitud} m`);
  set('soilTempValue', `${m.tSuelo.toFixed(2)} °C`);
  set('airTempValue', `${m.tAire.toFixed(2)} °C`);
  set('minTempValue', `${m.tMin7.toFixed(2)} °C`);
  set('humidityValue', `${Math.round(m.hr7)}%`);
  set('dayOfYearValue', `${m.dia} / 365`);
  set('rain7Value', `${m.lluvia30.slice(0, 7).reduce((a, b) => a + b, 0).toFixed(1)} mm`);
  set('soilTypeValue', s.ok ? capitalize(s.textura)
    : s.pendiente ? 'consultando…' : 'no disponible');
  set('phValue', s.ok && s.ph != null ? s.ph.toFixed(1) : '—');
}

function renderTerreno(m, s) {
  const e = document.getElementById('soilSummary');
  if (!e) return;
  if (!s.ok) {
    if (s.pendiente) e.innerHTML = '<span class="soil-unavailable">Consultando SoilGrids…</span>';
    return;   // si ya falló, deja el aviso de setSoilHint()
  }
  const n0 = v => (v == null ? '—' : v.toFixed(0));
  // Cada componente se muestra sólo si llegó: SoilGrids puede devolver unos
  // sí y otros no, y un "— 35% —" es más claro que inventar el que falta.
  const partes = [];
  if (s.textura) partes.push(`Textura <strong>${capitalize(s.textura)}</strong>`);
  if (s.arena != null) partes.push(`arena <strong>${n0(s.arena)}%</strong>`);
  if (s.arcilla != null) partes.push(`arcilla <strong>${n0(s.arcilla)}%</strong>`);
  if (s.limo != null) partes.push(`limo <strong>${n0(s.limo)}%</strong>`);
  if (s.ph != null) partes.push(`pH <strong>${s.ph.toFixed(1)}</strong>`);
  if (s.costero != null) partes.push(`carbono <strong>${n0(s.costero)} g/kg</strong>`);

  e.innerHTML = (partes.length ? partes.join(' · ') : 'sin datos de suelo')
    + `<br><span class="soil-note">ISRIC SoilGrids 2.0, horizonte 5-15 cm, rejilla 250 m</span>`;
}

const capitalize = s => s ? s[0].toUpperCase() + s.slice(1) : s;

/**
 * Mayúscula en la primera letra, para los hábitats.
 *
 * El modelo los guarda en minúsculas porque son claves internas con las que
 * se comparan ("pinar", "hayedo", "fresnedal"), pero mostrarlos así en la
 * interfaz queda feo: "Hábitat estimado: pinar" parece un descuido. Se
 * capitaliza sólo al pintar; el valor interno no se toca, porque forma parte
 * de la comparación de compatibilidad.
 */
function cap(s) {
  if (!s) return s;
  // Los hábitats son claves internas con guion bajo ("bosque_mixto",
  // "madera_muerta"); al pintarlos se cambian por espacios.
  const t = String(s).replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Heurística de vegetación por coordenadas.
 *
 * Es LA fuente de error más probable del modelo: cubre sólo grandes zonas
 * de España y devuelve el hábitat dominante, no la mezcla real. Por eso
 * `evaluarHabitat` la degrada en vez de vetar, y por eso la interfaz marca
 * el factor como estimado.
 */
function inferirVegetacion(lat, lng) {
  if (lat < 36.0) return ['encinar', 'dehesa', 'matorral'];
  if (lat > 42.5 && lng > -8.5 && lng < -1) return ['hayedo', 'robledal', 'pinar', 'bosque_mixto'];
  if (lat > 40.5 && lat <= 42.5 && lng > -7 && lng < -1) return ['pinar', 'hayedo', 'robledal'];
  if (lat > 40.5 && lat <= 42.5 && lng >= -1 && lng < 3.5) return ['pinar', 'robledal', 'bosque_mixto'];
  if (lat > 38.5 && lat <= 40.5 && lng > -6 && lng < -1.5) return ['robledal', 'pinar', 'encinar', 'castaneral'];
  if (lat > 38.5 && lat <= 40.5 && lng >= -1.5 && lng < 3) return ['encinar', 'pinar', 'robledal'];
  if (lat > 36.0 && lat <= 38.5 && lng > -8.5 && lng < -1) return ['dehesa', 'encinar', 'robledal', 'fresnedal'];
  if (lat > 36.0 && lat <= 38.5 && lng >= -1) return ['encinar', 'pinar', 'matorral'];
  // Corredor del Ebro y levante mediterráneo
  if (lat > 40 && lng > -1 && lng < 1) return ['pinar', 'frutal', 'ribera'];
  return ['pradera', 'pastizal', 'bosque_mixto'];
}

// ------------------------------------------------------------
// Marca de tiempo
// ------------------------------------------------------------

/**
 * Sólo la línea de "actualizado" y la fuente. La valoración global de
 * condiciones que antes estaba aquí se eliminó de la tarjeta de suelo y clima:
 * repetía lo que ya dicen los anillos de índice y ocupaba más sitio.
 */
function renderEstado() {
  const u = document.getElementById('lastUpdate');
  if (u) {
    u.textContent = `Actualizado: ${new Date().toLocaleString('es-ES')} · Fuente: Open-Meteo + SoilGrids`;
  }
}

// ------------------------------------------------------------
// Tarjetas por especie
// ------------------------------------------------------------

function renderTarjetas() {
  const cont = document.querySelector('.dashboard-grid');
  if (!cont) return;

  // El contenedor ya viene en el HTML; sólo se crea si faltara.
  let box = document.getElementById('mushroomCardsContainer');
  if (!box) {
    box = document.createElement('div');
    box.id = 'mushroomCardsContainer';
    box.className = 'mushroom-cards-grid';
    cont.appendChild(box);
  }

  // Se filtra por selección y se ordena por prioridad de especie, no por
  // puntuación: el orden en el que salen las tarjetas es fijo, para que no
  // se muevan de sitio cada vez que cambia el tiempo.
  const vis = porPrioridad(
    currentRanking.filter(r => selectedMushrooms.includes(r.sp.key))
  );
  if (!vis.length) {
    box.innerHTML = '<p class="placeholder-text">Selecciona setas en la pestaña 🍄 Especies</p>';
    return;
  }

  box.innerHTML = vis.map(r => tarjeta(r)).join('');
}

/**
 * Estado de la acumulación de calor, en palabras. Sólo se usa en la tabla de
 * Análisis, no en las tarjetas del dashboard: allí la cifra en grados-día
 * ("292 de 180") se quitó por pedido del usuario, porque un número grande sin
 * contexto asusta y no ayuda a decidir nada.
 */
function textoGDD(gdd, need) {
  if (need <= 0) return '—';
  const pct = Math.round((gdd / need) * 100);
  if (pct >= 100) return 'suficiente';
  if (pct >= 60) return `casi, ${pct} %`;
  if (pct >= 25) return `acumulando, ${pct} %`;
  return `apenas iniciado, ${pct} %`;
}

function tarjeta(r) {
  const sp = r.sp;
  const nivel = nivelTexto(r.I);
  const C = 2 * Math.PI * 45;
  const off = C - (r.I / 100) * C;
  const pct = v => Math.round(v * 100);
  const t = currentCtx.terreno;
  const suelo = currentCtx.suelo;

  const m = MUSHROOM_META[sp.key] || {};

  return `
  <div class="card mushroom-card ${r.viable ? '' : 'inviable'}">
    <div class="mushroom-title-section">
      <span class="mushroom-icon-large">${m.icon || '🍄'}</span>
      <div class="mushroom-titles">
        <h2 class="mushroom-name">${sp.es}</h2>
        <p class="mushroom-scientific">${sp.lat}</p>
        ${sp.alias ? `<p class="mushroom-alias">${escaparHtml(sp.alias)}</p>` : ''}
      </div>
    </div>

    ${sp.toxica ? `<div class="toxic-banner">
        ☠️ <strong>ESPECIE TÓXICA — NO COMER.</strong>
        <span>${escaparHtml(sp.aviso)}</span>
      </div>` : ''}

    <div class="probability-ring">
      <svg viewBox="0 0 100 100">
        <circle class="ring-bg" cx="50" cy="50" r="45"/>
        <circle class="ring-fill" cx="50" cy="50" r="45"
          style="stroke:${m.color || '#666'};stroke-dasharray:${C};stroke-dashoffset:${off}"/>
      </svg>
      <div class="ring-text">
        <span class="percentage">${Math.round(r.I)}</span>
        <span class="label">Potencial</span>
      </div>
    </div>

    ${!r.viable ? `<div class="alert-box">⛔ ${r.motivo}</div>` : ''}

    <div class="prediction-banner ${nivel.clase}">
      <span class="prediction-icon">📊</span>
      <span class="prediction-text">${nivel.texto}</span>
    </div>

    <div class="factors-grid-compact">
      ${[['S', r.S], ['H', r.H], ['A', r.A], ['T', r.T]].map(([k, v]) => `
        <div class="factor-item-compact">
          <span class="factor-label">${FACTOR_LABELS[k].icono} ${FACTOR_LABELS[k].nombre}</span>
          <span class="factor-value">${pct(v)}%</span>
        </div>`).join('')}
    </div>

    <div class="conditions-list">
      <div class="condition-item">
        <span>🌡️ T° suelo:</span>
        <span class="condition-value">${currentCtx.tSuelo.toFixed(1)}°C</span>
      </div>
      <div class="condition-item">
        <span>🎯 T° óptima:</span>
        <span class="condition-value">${sp.tOpt}°C</span>
      </div>
      <div class="condition-item">
        <span>🌲 Hábitat estimado:</span>
        <span class="condition-value">${cap(r.detalle.habEtiqueta) || '—'}</span>
      </div>
      <div class="condition-item">
        <span>💧 Lluvia efectiva:</span>
        <span class="condition-value">${r.reff.toFixed(1)} mm</span>
      </div>
    </div>

    <div class="mushroom-details">
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Rango de temperatura de suelo para fructificar:</span>
        <span class="mushroom-detail-value">${sp.tBase} / ${sp.tMax} °C</span>
      </div>
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Mínima absoluta:</span>
        <span class="mushroom-detail-value">${sp.tCrit} °C</span>
      </div>
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Ventana hídrica:</span>
        <span class="mushroom-detail-value">${sp.L} días</span>
      </div>
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Lluvia óptima:</span>
        <span class="mushroom-detail-value">${sp.Ro} mm</span>
      </div>
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Grupo:</span>
        <span class="mushroom-detail-value">${GUILD_LABELS[sp.guild]}</span>
      </div>
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Factor hábitat:</span>
        <span class="mushroom-detail-value">${pct(r.detalle.habFactor)}%${r.detalle.habConfuso ? ' (bajo)' : ''}</span>
      </div>
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Factor de suelo:</span>
        <span class="mushroom-detail-value">${
          r.detalle.sueloConocido
            ? pct(r.detalle.sueloFactor) + '% · ' + r.detalle.sueloEtiqueta
            : 'sin dato de pH'
        }</span>
      </div>
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Helada reciente:</span>
        <span class="mushroom-detail-value">${escaparHtml(textoHelada(r.detalle))}</span>
      </div>
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Factor altitud:</span>
        <span class="mushroom-detail-value">${pct(r.detalle.alt)}%${
          r.detalle.altBanda
            ? ' · banda ' + r.detalle.altBanda + (
                r.detalle.altEvidencia === 'indicado' ? ' (estimada)' : '')
          : ''
        }</span>
      </div>
    </div>

    <div class="mushroom-detail-item full">
      <span class="mushroom-detail-label">Temporada documentada:</span>
      <span class="mushroom-detail-value">${escaparHtml(temporadaTexto(sp))}</span>
    </div>
    <div class="mushroom-detail-item full">
      <span class="mushroom-detail-label">Comestibilidad:</span>
      <span class="mushroom-detail-value${sp.toxica ? ' toxica' : ''}">${escaparHtml(sp.comestible || 'no documentada')}</span>
    </div>
  </div>`;
}

// ------------------------------------------------------------
// Análisis: ranking + meteorología
// ------------------------------------------------------------

function renderAnalisis() {
  const c = document.getElementById('mushroomAnalysisContainer');
  if (!c || !currentCtx) return;

  const pct = v => Math.round(v * 100);

  const filas = currentRanking.map(r => {
    const sp = r.sp;
    const m = MUSHROOM_META[sp.key] || {};
    const n = nivelTexto(r.I);
    return `
    <tr class="${r.I >= 45 ? 'row-alta' : ''}">
      <td class="col-especie">
        <span class="sp-icon">${m.icon || '🍄'}</span>
        <div><strong>${sp.es}</strong><div class="sp-latin">${sp.lat}</div></div>
      </td>
      <td class="col-indice"><span class="indice-badge ${n.clase}">${Math.round(r.I)}</span></td>
      <td title="Estacional (T suelo)">${pct(r.S)}%</td>
      <td title="Reserva de humedad del suelo">${pct(r.H)}%</td>
      <td title="Acumulación de grados día">${pct(r.A)}%</td>
      <td title="Temporada documentada">${pct(r.T)}%</td>
      <td title="Grados día acumulados: ${Math.round(r.G)} de ${sp.gddNeed}">${textoGDD(r.G, sp.gddNeed)}</td>
      <td title="Lluvia efectiva">${r.reff.toFixed(0)}</td>
      <td title="Temp. óptima">${sp.tOpt}°C</td>
      <td title="Compatibilidad de hábitat (estimada)">${pct(r.detalle.habFactor)}%</td>
      <td title="${escaparHtml(textoHelada(r.detalle))}">${pct(r.detalle.heladaFactor)}%</td>
      <td class="col-nivel">${r.viable ? n.texto : `— (${r.motivo})`}</td>
    </tr>`;
  }).join('');

  const m = currentCtx;
  const w = currentMeteo || {};
  const n1 = v => (v == null || Number.isNaN(v) ? '—' : v.toFixed(1));
  const acum = k => m.lluvia30.slice(0, k).reduce((a, b) => a + b, 0).toFixed(1);

  c.innerHTML = `
    <div class="card">
      <h3>🌧️ Meteorología de la zona</h3>
      <div class="detail-grid">
        <div>
          <h4>Acumulados de lluvia</h4>
          <div class="analysis-item"><span class="analysis-label">Últimos 3 días</span><span class="analysis-value">${acum(3)} mm</span></div>
          <div class="analysis-item"><span class="analysis-label">Últimos 7 días</span><span class="analysis-value">${acum(7)} mm</span></div>
          <div class="analysis-item"><span class="analysis-label">Últimos 15 días</span><span class="analysis-value">${acum(15)} mm</span></div>
          <div class="analysis-item"><span class="analysis-label">Últimos 30 días</span><span class="analysis-value">${acum(30)} mm</span></div>
        </div>
        <div>
          <h4>Temperatura</h4>
          <div class="analysis-item"><span class="analysis-label">Suelo ahora</span><span class="analysis-value">${n1(m.tSuelo)}°C</span></div>
          <div class="analysis-item"><span class="analysis-label">Suelo hace 30 días</span><span class="analysis-value">${n1(m.tSuelo0)}°C</span></div>
          <div class="analysis-item"><span class="analysis-label">Aire ahora</span><span class="analysis-value">${n1(w.tAire)}°C</span></div>
          <div class="analysis-item"><span class="analysis-label">Amplitud suelo-aire</span><span class="analysis-value">${n1(m.tSuelo - w.tAire)}°C</span></div>
        </div>
        <div>
          <h4>Contexto</h4>
          <div class="analysis-item"><span class="analysis-label">Altitud</span><span class="analysis-value">${m.altitude} m</span></div>
          <div class="analysis-item"><span class="analysis-label">Humedad media relativa en 7 días</span><span class="analysis-value">${w.hr7 == null ? '—' : Math.round(w.hr7) + '%'}</span></div>
          <div class="analysis-item"><span class="analysis-label">Vegetación (est.)</span><span class="analysis-value">${escaparHtml(m.terreno.vegetacion.map(cap).join(', '))}</span></div>
          <div class="analysis-item"><span class="analysis-label">Textura suelo</span><span class="analysis-value">${m.suelo.ok ? m.suelo.textura : 'no disponible'}</span></div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>📊 Ranking de especies</h3>
      <p class="model-note">
        Modelo por ventanas: <code>I = 100 · S · H<sup>0.5</sup> · A · T · F<sub>hábitat</sub> · F<sub>suelo</sub> · F<sub>altitud</sub> · F<sub>helada</sub> · F<sub>helada</sub></code><br>
        <strong>S</strong> potencial térmico del suelo ·
        <strong>H</strong> reserva de humedad del suelo ·
        <strong>A</strong> acumulación de grados-día ·
        <strong>T</strong> temporada documentada ·
        <strong>G</strong> grados-día acumulados ·
        La estacionalidad la fija la <em>temperatura del suelo</em>, no el calendario.<br>
        La <strong>helada</strong> no pone el índice a cero: reduce el potencial y este se
        recupera conforme el episodio se aleja.
      </p>
      <div class="table-wrapper">
        <table class="ranking-table">
          <thead><tr>
            <th>Especie</th><th>Índice</th><th>S</th><th>H</th><th>A</th><th>T</th>
            <th>GDD</th><th>Lluvia efectiva</th><th>T° opt</th><th>F. hábitat</th><th>Helada</th><th>Estado</th>
          </tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
      <p class="hint-text">
        ⚠️ Parámetros por especie son valores de partida documentados, no calibrados
        con dataset propio. Requieren validación con observaciones de campo.
      </p>
    </div>`;
}

// ------------------------------------------------------------
// Favoritos
// ------------------------------------------------------------

function loadFavorites() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY));
    // Se descarta cualquier entrada corrupta en vez de romper el render entero.
    favorites = Array.isArray(raw)
      ? raw.filter(f => f
        && typeof f.name === 'string'
        && Number.isFinite(f.lat)
        && Number.isFinite(f.lng))
        .map(f => ({ id: f.id ?? Date.now(), name: f.name, lat: f.lat, lng: f.lng }))
      : [];
  } catch {
    favorites = [];
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    return true;
  } catch (e) {
    notify('No se pudo guardar: almacenamiento lleno o bloqueado', 'error');
    console.error(e);
    return false;
  }
}

/**
 * Añade una ubicación evitando duplicados por proximidad.
 * La comparación es numérica, no por cadena: los mismos 4 decimales pueden
 * diferir en el último dígito según de dónde venga la coordenada.
 */
function agregarFavorito(nombre, lat, lng) {
  const nombreLimpio = nombre.trim();
  if (!nombreLimpio) return { ok: false, motivo: 'sin nombre' };

  const existe = favorites.find(f =>
    Math.abs(f.lat - lat) < 0.0001 && Math.abs(f.lng - lng) < 0.0001
  );

  if (existe) {
    existe.name = nombreLimpio;
    return { ok: true, actualizada: true, fav: existe };
  }

  const fav = { id: Date.now(), name: nombreLimpio, lat, lng };
  favorites.push(fav);
  return { ok: true, actualizada: false, fav };
}

function initFavorites() {
  const add = document.getElementById('addFavoriteBtn');
  if (add) add.addEventListener('click', () => {
    const nameEl = document.getElementById('favoriteName');
    const latEl = document.getElementById('favoriteLat');
    const lngEl = document.getElementById('favoriteLng');

    const name = nameEl.value.trim();
    const lat = parseFloat(latEl.value);
    const lng = parseFloat(lngEl.value);

    if (!name || isNaN(lat) || isNaN(lng)) {
      return notify('Completa todos los campos', 'error');
    }
    if (lat < -90 || lat > 90) return notify('Latitud fuera de rango (−90 a 90)', 'error');
    if (lng < -180 || lng > 180) return notify('Longitud fuera de rango (−180 a 180)', 'error');

    const r = agregarFavorito(name, lat, lng);
    if (!r.ok) return;
    if (!saveFavorites()) return;

    renderFavorites();
    notify(r.actualizada ? `⭐ Actualizada: ${r.fav.name}` : `⭐ Guardada: ${r.fav.name}`, 'success');

    nameEl.value = '';
    latEl.value = '';
    lngEl.value = '';
    nameEl.focus();
  });

  const save = document.getElementById('saveFavoriteBtn');
  if (save) save.addEventListener('click', abrirPanelGuardado);

  const confirmar = document.getElementById('saveFavConfirm');
  if (confirmar) confirmar.addEventListener('click', confirmarGuardado);

  const cancelar = document.getElementById('saveFavCancel');
  if (cancelar) cancelar.addEventListener('click', cerrarPanelGuardado);

  const input = document.getElementById('saveFavName');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirmarGuardado(); }
      if (e.key === 'Escape') cerrarPanelGuardado();
    });
  }

  renderFavorites();
}

/**
 * Despliega el formulario de guardado con el nombre del lugar ya detectado.
 *
 * Antes se usaba window.prompt() para pedir el nombre. Se cambió porque los
 * navegadores pueden bloquearlo (devuelve null sin mostrar nada y el clic se
 * pierde en silencio), y porque el nombre del lugar ya está resuelto en
 * `lugarActual`, así que no hay nada que escribir desde cero.
 */
function abrirPanelGuardado() {
  const panel = document.getElementById('saveFavPanel');
  const input = document.getElementById('saveFavName');
  const coords = document.getElementById('saveFavCoords');
  if (!panel) return;

  panel.hidden = false;

  // Sin topónimo se usan las coordenadas: es un nombre mediocre, pero
  // siempre mejor que "Ubicación 3".
  const sugerido = lugarActual
    || coordsTexto(selectedLat, selectedLng)
    || `Ubicación ${favorites.length + 1}`;
  if (input) {
    input.value = sugerido;
    input.focus();
    input.select();
  }

  if (coords) {
    coords.textContent = coordsTexto(selectedLat, selectedLng);
  }
}

function cerrarPanelGuardado() {
  const panel = document.getElementById('saveFavPanel');
  if (panel) panel.hidden = true;
}

function confirmarGuardado() {
  const input = document.getElementById('saveFavName');
  const nombre = (input?.value || '').trim();

  if (!nombre) {
    notify('Ponle un nombre a la ubicación', 'error');
    if (input) input.focus();
    return;
  }

  const r = agregarFavorito(nombre, selectedLat, selectedLng);
  if (!r.ok) {
    notify('Ponle un nombre a la ubicación', 'error');
    return;
  }
  if (!saveFavorites()) return;

  renderFavorites();
  cerrarPanelGuardado();
  notify(
    r.actualizada
      ? `⭐ Actualizada: ${r.fav.name}`
      : `⭐ Guardada: ${r.fav.name} · ve a «Mis setales»`,
    'success'
  );
}

/** "42.8000° N, 7.8000° W" — el hemisferio se decide por el signo. */
function coordsTexto(lat, lng) {
  const n = (v, pos, neg) => `${Math.abs(v).toFixed(4)}° ${v < 0 ? neg : pos}`;
  return `${n(lat, 'N', 'S')}, ${n(lng, 'E', 'O')}`;
}

/** Escapa el nombre para poder inyectarlo en el innerHTML de la lista. */
function escaparHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFavorites() {
  const el = document.getElementById('favoritesList');
  if (!el) return;

  // Un solo delegado en la lista, en vez de onclick por fila.
  if (el.dataset.delegado !== '1') {
    el.dataset.delegado = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      if (btn.dataset.action === 'load') loadFav(id);
      else delFav(id);
    });
  }

  const badge = document.getElementById('favCount');
  if (badge) badge.textContent = favorites.length ? String(favorites.length) : '';

  // El desplegable de zonas incluye los setales guardados: hay que refrescarlo
  // cada vez que la lista cambia, o no aparecen hasta mover el mapa.
  renderGeoselector();

  if (!favorites.length) {
    el.innerHTML = '<p class="placeholder-text">Sin ubicaciones guardadas. Pulsa '
      + '«⭐ Guardar ubicación de setal» en el dashboard o añádela manualmente arriba.</p>';
    return;
  }
  el.innerHTML = favorites.map(f => `
    <div class="favorite-item" data-fav-id="${f.id}">
      <span class="favorite-icon">📍</span>
      <div class="favorite-info">
        <div class="favorite-name">${escaparHtml(f.name)}</div>
        <div class="favorite-coords">${coordsTexto(f.lat, f.lng)}</div>
      </div>
      <div class="favorite-actions">
        <button class="favorite-btn load" data-action="load" data-id="${f.id}">Cargar</button>
        <button class="favorite-btn delete" data-action="del" data-id="${f.id}" title="Eliminar">🗑️</button>
      </div>
    </div>`).join('');
}

window.loadFav = async id => {
  const f = favorites.find(x => x.id === id);
  if (!f) return;
  await setLocation(f.lat, f.lng);
  document.querySelector('[data-section="dashboard"]')?.click();
  notify(`📍 ${f.name}`, 'success');
};

window.delFav = id => {
  const f = favorites.find(x => x.id === id);
  favorites = favorites.filter(x => x.id !== id);
  if (!saveFavorites()) return;
  renderFavorites();
  if (f) notify(`Eliminada: ${f.name}`, 'info');
};

// ------------------------------------------------------------
// Selector de setas
// ------------------------------------------------------------

/**
 * Recupera la selección guardada. Si no hay ninguna, se quedan todas las
 * especies, que es el estado por defecto.
 *
 * Se descartan las claves que ya no corresponden a ninguna especie: si algún
 * día se cambia el catálogo, una lista vieja no debe dejar huecos.
 */
function loadSelectedMushrooms() {
  // Se parte siempre del valor por defecto (todas las especies) y sólo se
  // sobrescribe si hay una lista guardada utilizable. Así la función es
  // idempotente: llamarla sin nada guardado devuelve todas, no lo que
  // hubiera quedado de una llamada anterior.
  selectedMushrooms = SPECIES.map(sp => sp.key);
  try {
    const s = JSON.parse(localStorage.getItem(MUSH_KEY));
    if (Array.isArray(s)) {
      const validas = new Set(SPECIES.map(sp => sp.key));
      selectedMushrooms = s.filter(k => validas.has(k));
    }
  } catch { /* se mantiene el valor por defecto */ }
}

function saveSelectedMushrooms() {
  localStorage.setItem(MUSH_KEY, JSON.stringify(selectedMushrooms));
}

/**
 * Una línea que explica el episodio de helada de una especie, o que dice que
 * no ha habido ninguno. Se muestra tal cual en la tarjeta y en la tabla de
 * Análisis, para que el número del factor de helada nunca aparezca solo.
 */
function textoHelada(d) {
  if (!d || !d.heladaNoches) return 'sin heladas recientes';
  const min = d.heladaMinima == null ? '' : `, mínima ${d.heladaMinima.toFixed(0)} °C`;
  const suelo = d.heladaSuelo ? ', suelo también helado' : '';
  const n = d.heladaNoches;
  const noches = `${n} ${n === 1 ? 'noche' : 'noches'} de helada`;
  const a = d.heladaAntiguedad;
  // Una sola noche dice el desfase de una vez; varias lo dicen de la última,
  // que es la que más pesa.
  const cuando = n === 1
    ? (a === 0 ? 'anoche' : a === 1 ? 'hace una noche' : `hace ${a} noches`)
    : (a === 0 ? 'la última anoche' : a === 1 ? 'la última hace una noche'
      : `la última hace ${a} noches`);
  return `${Math.round(d.heladaFactor * 100)} % · ${noches}, ${cuando}${min}${suelo}`;
}

function initMushroomSelector() {
  const sel = document.getElementById('mushroomSelector');
  const info = document.getElementById('mushroomInfoGrid');
  if (!sel) return;

  sel.innerHTML = porPrioridad(SPECIES.map(sp => ({ sp }))).map(({ sp }) => {
    const m = MUSHROOM_META[sp.key] || {};
    const on = selectedMushrooms.includes(sp.key);
    return `
      <label class="mushroom-option ${on ? 'selected' : ''}${sp.toxica ? ' toxica' : ''}">
        <input type="checkbox" value="${sp.key}" ${on ? 'checked' : ''}>
        <span class="mushroom-option-icon">${m.icon || '🍄'}</span>
        <div class="mushroom-option-info">
          <div class="mushroom-option-name">${escaparHtml(sp.es)}</div>
          <div class="mushroom-option-scientific">${escaparHtml(sp.lat)}</div>
          ${sp.toxica ? '<div class="mushroom-option-tox">☠️ Tóxica</div>' : ''}
        </div>
      </label>`;
  }).join('');

  if (info) {
    info.innerHTML = porPrioridad(SPECIES.map(sp => ({ sp }))).map(({ sp }) => {
      const m = MUSHROOM_META[sp.key] || {};
      return `
      <div class="mushroom-info-card ${sp.toxica ? 'toxica' : ''}" style="border-left-color:${m.color || '#666'}">
        <div class="mushroom-info-header">
          <span class="mushroom-info-icon">${m.icon || '🍄'}</span>
          <div class="mushroom-info-title">
            <div class="mushroom-info-name">${escaparHtml(sp.es)}</div>
            <div class="mushroom-info-scientific">${escaparHtml(sp.lat)}</div>
            ${sp.alias ? `<div class="mushroom-info-alias">${escaparHtml(sp.alias)}</div>` : ''}
          </div>
        </div>
        ${sp.toxica ? `<div class="toxic-banner small">
            ☠️ <strong>ESPECIE TÓXICA — NO COMER.</strong>
            <span>${escaparHtml(sp.aviso)}</span>
          </div>` : ''}
        <div class="mushroom-info-details">
          <p><strong>Grupo:</strong> ${GUILD_LABELS[sp.guild]}</p>
          <p><strong>Temporada documentada:</strong> ${escaparHtml(temporadaTexto(sp))}</p>
          <p><strong>Comestibilidad:</strong> ${escaparHtml(sp.comestible || 'no documentada')}</p>
          <p><strong>Rango de temperatura de suelo para fructificar:</strong> ${sp.tBase} a ${sp.tMax} °C, óptimo ${sp.tOpt} °C</p>
          <p><strong>Mínima crítica:</strong> ${sp.tCrit} °C</p>
          <p><strong>Grados día necesarios:</strong> ${sp.gddNeed}</p>
          <p><strong>Ventana hídrica:</strong> ${sp.L} días · óptima ${sp.Ro} mm</p>
          <p><strong>Hábitat:</strong> ${escaparHtml(sp.habitat.map(cap).join(', '))}</p>
        </div>
        <p class="card-evidencia">
          <span class="evidencia-badge ev-${sp.evidencia || 'estimado'}">${EVIDENCIA_LABELS[sp.evidencia] || EVIDENCIA_LABELS.estimado}</span>
          ${sp.fuente ? `<span class="fuente">Fuente: ${escaparHtml(sp.fuente)}</span>` : ''}
        </p>
      </div>`;
    }).join('');
  }

  sel.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
    const k = cb.value;
    if (cb.checked) {
      if (!selectedMushrooms.includes(k)) selectedMushrooms.push(k);
    } else {
      selectedMushrooms = selectedMushrooms.filter(x => x !== k);
    }
    cb.closest('.mushroom-option').classList.toggle('selected', cb.checked);
    saveSelectedMushrooms();
    renderEstado();
    renderTarjetas();
  }));
}

// ------------------------------------------------------------
// Buscador y selector geospatial
// ------------------------------------------------------------

function initSearch() {
  const inp = document.getElementById('searchInputDashboard');
  const btn = document.getElementById('searchBtnDashboard');
  const go = () => buscar(inp.value);
  if (btn) btn.addEventListener('click', go);
  if (inp) inp.addEventListener('keypress', e => { if (e.key === 'Enter') go(); });
}

async function buscar(q) {
  if (!q?.trim()) return notify('Introduce una ubicación', 'error');
  const res = await buscarLugar(q.trim());
  if (!res.length) return notify('Ubicación no encontrada', 'error');
  await setLocation(res[0].latitude, res[0].longitude);
  notify(`📍 ${res[0].name}`, 'success');
}

function initGeoSelect() {
  const s = document.getElementById('geoSelect');
  if (!s) return;
  s.addEventListener('change', async () => {
    // Formato: "tipo|lat|lng". El tipo distingue un setal propio de una
    // zona de referencia, que comparten la misma estructura.
    const [, lat, lng] = s.value.split('|');
    if (!lat) return;

    await setLocation(parseFloat(lat), parseFloat(lng));
  });
}

/** Zonas micológicas de referencia (centros de zonas con setas). */
/*
 * Zonas de setas de referencia.
 *
 * IMPORTANTE, Y NO ES UN MODESTO: son macrozonas de entre diez y varios mil
 * kilómetros cuadrados, no puntos de setal. Aquí no se buscan setas "aquí":
 * se busca el tipo de bosque que las lleva. Quien conoce un monte de verdad
 * no publica el sitio, y no sería responsable inventarlo, porque una
 * coordenada demasiado precisa daría una certeza que ningún dato sostiene.
 *
 * Cada zona declara de dónde sale lo que se afirma de ella:
 *   evidencia: 'documentado' -> hay fuente oficial o estudio publicado.
 *              'indicado'    -> el bosque y su asociación con las setas están
 *                                documentados, pero no hay cifras de producción
 *                                para esa zona concreta.
 *
 * Las coordenadas son el centroide o la localidad de referencia, obtenidas
 * de Nominatim (OpenStreetMap), no una parcela concreta.
 */
const ZONAS_MADRID = [

  /* -- Comunidad de Madrid ------------------------------------------ */

  {
    nombre: 'Parque Nacional de la Sierra de Guadarrama',
    zona: 'Madrid / Segovia',
    lat: 40.8879, lng: -3.9414,
    bosque: 'Pinar de pino silvestre, hayedo y robledal, de 1.200 a 2.400 m.',
    especies: ['boletus', 'niscalos', 'rebozuelo', 'boleto_pino', 'gula_monte',
               'san_jorge', 'hongo_verano', 'seta_pino'],
    evidencia: 'documentado',
    nota: 'El propio Parque publica qué especies se pueden recoger y con qué '
        + 'cupo: 20 kg por persona y día para boleto y níscalo. La recogida está '
        + 'regulada monte a monte y en varios montes hace falta permiso.',
    fuente: 'Plan Rector de Uso y Gestión del Parque Nacional (art. 59) y '
        + 'normativa de recogida de setas del propio Parque; guía de setas y '
        + 'hongos de la Sierra de Guadarrama, MITECO / CENEAM.',
  },
  {
    nombre: 'Pinares de Valsaín',
    zona: 'Segovia, en el borde con Madrid',
    lat: 40.8518, lng: -4.0113,
    bosque: 'Pinar puro de pino silvestre (Pinus sylvestris) por encima de 1.400 m.',
    especies: ['boletus', 'niscalos', 'seta_pino', 'girola', 'boleto_pino', 'san_jorge'],
    evidencia: 'documentado',
    nota: 'Uno de los mejores pinares de pino silvestre contiguos a la capital. '
        + 'La banda altitudinal del boleto se tomó de los gradientes de '
        + 'productividad medidos en masas de pinar de este tipo.',
    fuente: 'Martínez-Peña et al. (2012), modelos de rendimiento de hongos '
        + 'ectomicorrícicos en Pinus sylvestris.',
  },
  {
    nombre: 'Pinares de La Cabrera y riberos del Escorial',
    zona: 'El Escorial, Madrid',
    lat: 40.5836, lng: -4.1281,
    bosque: 'Pinar de pino silvestre en la vertiente occidental del Guadarrama.',
    especies: ['boletus', 'niscalos', 'boleto_pino', 'san_jorge'],
    evidencia: 'indicado',
    nota: 'Entra por el tipo de bosque, no por cifras propias: es pino silvestre '
        + 'del mismo macizo que la zona anterior. No hay estudio de rendimiento '
        + 'publicado para este pinar en concreto.',
    fuente: 'Cartografía forestal y límites del Parque Nacional de la Sierra '
        + 'de Guadarrama.',
  },
  {
    nombre: 'Hayedo de Montejo',
    zona: 'El Berrueco, Sierra Norte, Madrid',
    lat: 40.8890, lng: -3.5614,
    bosque: 'Hayedo de haya (Fagus sylvatica) de unas 250 ha al pie de la Sierra de Ayllón.',
    especies: ['rebozuelo', 'trompeta', 'rovello', 'hongo_verano', 'boletus', 'boleto_bronce'],
    evidencia: 'indicado',
    nota: 'Hayedo puro y húmedo: donde mejor salen la chantarela, las trompetas '
        + 'de la muerte y las rúsculas. La asociación del haya con el boleto y la '
        + 'chantarela es de las mejor estudiadas del país, pero de este hayedo '
        + 'concreto no hay cifras publicadas.',
    fuente: 'Ficha del Hayedo de Montejo (250 ha, municipio de El Berrueco) y '
        + 'literatura sobre micorrizas de Fagus sylvatica.',
  },
  {
    nombre: 'Robledales y pino rojo del Valle del Lozoya',
    zona: 'Valle del Lozoya, Madrid',
    lat: 40.9632, lng: -3.7840,
    bosque: 'Robledal de quejigo y fresno con pinar de pino rojo, en el contacto con la montaña.',
    especies: ['boletus', 'rebozuelo', 'amanita', 'trompeta', 'rovello', 'boleto_bronce'],
    evidencia: 'indicado',
    nota: 'Zona ecotón, del robledal al pinar, con setas de los dos bosques a la '
        + 'vez. Enlaza con el Hayedo de Montejo, que se lista aparte.',
    fuente: 'Mapa de usos del suelo y manual de selvicultura de la Sierra Norte '
        + 'de Madrid.',
  },
];

const ZONAS_ESPANA = [

  {
    nombre: 'Pinares de Soria',
    zona: 'Soria, Castilla y León',
    lat: 41.7600, lng: -2.5300,
    bosque: 'Pinar de pino silvestre y pino resinero sobre arenales, de 1.000 a 1.400 m.',
    especies: ['boletus', 'niscalos', 'seta_pino', 'girola', 'boleto_pino', 'san_jorge'],
    evidencia: 'documentado',
    nota: 'Es la referencia de la literatura: el estudio de rendimiento de '
        + 'boleto y níscalo más citado sobre setas en España se hizo aquí, y '
        + 'concluyó que el área basal óptima del pinar está entre 20 y 40 m²/ha.',
    fuente: 'Martínez-Peña et al. (2012), Forest Ecology and Management 282: '
        + 'modelos de rendimiento para Boletus edulis y Lactarius grupo '
        + 'deliciosus en pinares de Pinus sylvestris de Soria.',
  },
  {
    nombre: 'Sierra de Albarracín y Alto Maestrazgo',
    zona: 'Teruel, Aragón',
    lat: 40.4073, lng: -1.4443,
    bosque: 'Pinar de pino silvestre y pino resinero, con sabinar en las cotas altas.',
    especies: ['boletus', 'niscalos', 'seta_pino', 'girola', 'boleto_pino'],
    evidencia: 'documentado',
    nota: 'Su fama micológica está en la trufa negra, y ahí el dato es duro: '
        + 'Teruel es el mayor productor del mundo y en la comarca de Sarrión hay '
        + 'unas 3.000 ha de plantación trufera. La trufa es subterránea y este '
        + 'modelo NO la cubre: lo que calcula aquí es el boleto y el níscalo de '
        + 'sus pinares, no la trufa.',
    fuente: 'Datos de producción de Tuber melanosporum del Grupo Europeo de la '
        + 'Trufa; ficha de Tuber melanosporum sobre producción en España y '
        + 'Aragón; servicio de previsión micológica de la Sierra de Albarracín.',
  },
  {
    nombre: 'Sierra de Aracena y Picos de Aroche',
    zona: 'Huelva, Andalucía',
    lat: 37.8949, lng: -6.5624,
    bosque: 'Castanedo, robledal y alcornocal, con dehesa en los bordes.',
    especies: ['amanita', 'rebozuelo', 'boleto_bronce', 'rovello', 'trompeta', 'senderuela', 'seta_cardo'],
    evidencia: 'indicado',
    nota: 'Lo singular es el castañedo: la ocrea y el rebozuelo salen en castaño '
        + 'y en avellano, y en las dehesas de la falda hay seta de cardo y parasol.',
    fuente: 'Parque Natural Sierra de Aracena y Picos de Aroche (186.000 ha); '
        + 'ficha de hongos de Andalucía (Junta de Andalucía).',
  },
  {
    nombre: 'Alcornocales y Serranía de Ronda',
    zona: 'Cádiz y Málaga, Andalucía',
    lat: 36.6512, lng: -5.2742,
    bosque: 'Alcornocal y encinar con quejigal, en el lugar más lluvioso de España.',
    especies: ['amanita', 'boleto_bronce', 'rebozuelo', 'rovello', 'trompeta', 'hongo_verano'],
    evidencia: 'indicado',
    nota: 'Más de 1.500 mm de lluvia al año, el máximo de la península. Roble y '
        + 'alcornoque: ocrea, boleto bronce y chantarela.',
    fuente: 'Parque Natural de Los Alcornocales; atlas climático de Andalucía.',
  },
  {
    nombre: 'Berguedà y Cerdanya',
    zona: 'Barcelona, Cataluña',
    lat: 42.1106, lng: 1.8583,
    bosque: 'Hayedo y pinar de pino silvestre en la montaña, con robledal.',
    especies: ['boletus', 'rebozuelo', 'gula_monte', 'trompeta', 'rovello', 'hongo_verano', 'seta_cardo'],
    evidencia: 'indicado',
    nota: 'Cataluña concentra el consumo y el comercio de setas del país, y el '
        + 'pino silvestre de cotas altas da boleto mientras el haya da '
        + 'chantarela y trompetas.',
    fuente: 'Iglesias Bernabé et al. (2023), caracterización de los factores '
        + 'que controlan la producción de Boletus edulis (portal científico '
        + 'de la Universidad de Vigo).',
  },
  {
    nombre: 'Sierra de Aralar',
    zona: 'Navarra',
    lat: 42.9761, lng: -2.0106,
    bosque: 'Hayedo y pinar de pino silvestre hasta los 1.000 m.',
    especies: ['rebozuelo', 'boletus', 'niscalos', 'trompeta', 'gula_monte', 'boleto_bronce'],
    evidencia: 'indicado',
    nota: 'Sin cifras publicadas. Se incluye por la calidad del hayedo y por '
        + 'una cultura setera viva en la zona, con los "txalak" (níscalos) como '
        + 'referencia de temporada local.',
    fuente: 'Inventario de hábitats de la Sierra de Aralar; cultura tradicional '
        + 'navarra de los txalak.',
  },
  {
    nombre: 'Vega de Pas y Valle de Pas',
    zona: 'Cantabria',
    lat: 43.1585, lng: -3.7821,
    bosque: 'Hayedo atlántico, robledal y pradera de montaña.',
    especies: ['rebozuelo', 'trompeta', 'rovello', 'hongo_verano', 'boletus', 'girola', 'seta_cardo'],
    evidencia: 'indicado',
    nota: 'Hayedo atlántico con mucho rocío: chantarela, trompetas y boleto de '
        + 'haya.',
    fuente: 'Zonas protegidas de Cantabria; atlas de los hábitats naturales de '
        + 'Cantabria.',
  },
];

/**
 * Rellena el desplegable con los setales guardados y las zonas de referencia.
 *
 * Se repinta en cada refresh(), así que hay que conservar la selección: sin
 * esto el desplegable volvía al primer elemento tras cada movimiento del
 * mapa, que es un parpadeo muy molesto.
 */
function renderGeoselector() {
  const s = document.getElementById('geoSelect');
  if (!s) return;

  const seleccionada = s.value;
  const opPrevia = [...s.options].find(o => o.value === seleccionada);
  const etiquetaPrevia = opPrevia ? opPrevia.textContent : null;

  // Los setales guardados van primero: son los que el usuario usa.
  const mios = favorites.map(f =>
    `<option value="fav:${f.id}|${f.lat}|${f.lng}">⭐ ${escaparHtml(f.name)}</option>`
  ).join('');

  const opcionZona = z =>
    `<option value="zona|${z.lat}|${z.lng}">`
    + `${escaparHtml(z.nombre)}</option>`;

  s.innerHTML = `<option value="">— Zonas de setas —</option>`
    + (mios ? `<optgroup label="Mis setales (${favorites.length})">${mios}</optgroup>` : '')
    + `<optgroup label="Zonas de referencia · Madrid">`
    + ZONAS_MADRID.map(opcionZona).join('') + `</optgroup>`
    + `<optgroup label="Zonas de referencia · resto de España">`
    + ZONAS_ESPANA.map(opcionZona).join('') + `</optgroup>`;

  if (seleccionada) {
    const porValor = [...s.options].find(o => o.value === seleccionada);
    if (porValor) {
      s.value = porValor.value;
    } else if (etiquetaPrevia) {
      // El setal pudo renombrarse: se busca por la etiqueta anterior.
      const porEtiqueta = [...s.options].find(o => o.textContent === etiquetaPrevia);
      if (porEtiqueta) s.value = porEtiqueta.value;
    }
  }
}

// ------------------------------------------------------------
// UI helpers
// ------------------------------------------------------------

function showLoading(v) {
  const el = document.getElementById('loading');
  if (el) el.style.display = v ? 'flex' : 'none';
}

function notify(msg, type = 'info') {
  // Tonos de otoño: Information en oliva, aviso en musgo y error en
  // tierra rojiza. Los tres se distinguen de un vistazo y ninguno es el
  // azul ni el rojo brillante de las paletas por defecto.
  const bg = { info: '#8a6a2f', success: '#6f7a33', error: '#b23c1b' }[type];
  const n = document.createElement('div');
  n.className = 'toast';
  n.setAttribute('role', 'status');
  n.textContent = msg;
  n.style.background = bg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3200);
}

const style = document.createElement('style');
style.textContent = `
.toast{
  position:fixed;top:16px;left:16px;right:16px;max-width:min(420px,calc(100% - 32px));
  padding:14px 20px;color:#fff;border-radius:8px;z-index:9999;font-size:14px;
  box-shadow:0 4px 12px rgba(0,0,0,.2);
  animation:toastIn .25s ease;
}
@keyframes toastIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
`;
document.head.appendChild(style);

// Metadatos visuales (icono, color) por especie
const MUSHROOM_META = {
  boletus: { icon: '🟤', color: '#8b4513' },
  niscalos: { icon: '🟠', color: '#e65100' },
  amanita: { icon: '🔴', color: '#d32f2f' },
  rebozuelo: { icon: '🟡', color: '#f9a825' },
  senderuela: { icon: '⚪', color: '#9e9e9e' },
  parasol: { icon: '🟫', color: '#8d6e63' },
  champinon: { icon: '⚪', color: '#bdbdbd' },
  girola: { icon: '⚫', color: '#455a64' },
  seta_pino: { icon: '🟤', color: '#5d4037' },
  rovello: { icon: '🔴', color: '#c62828' },
  trompeta: { icon: '⚫', color: '#212121' },
  morena: { icon: '🟤', color: '#795548' },
  san_jorge: { icon: '⚪', color: '#e0e0e0' },
  boleto_pino: { icon: '🟫', color: '#9c4a1a' },
  gula_monte: { icon: '🟡', color: '#fbc02d' },
  hongo_verano: { icon: '🟨', color: '#c9a227' },
  boleto_bronce: { icon: '⚫', color: '#4e342e' },
  seta_cardo: { icon: '⚪', color: '#d7ccc8' },
};
// Lista completa, por si algún otro sitio la recorre entera.
const ZONAS_REFERENCIA = [...ZONAS_MADRID, ...ZONAS_ESPANA];
