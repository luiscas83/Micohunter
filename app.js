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

async function setLocation(lat, lng) {
  selectedLat = lat;
  selectedLng = lng;
  moveMarker(lat, lng);
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
    notify(String(e.message || e), 'error');
    showLoading(false);
    return;
  }

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
    // Si el usuario ha movido el mapa mientras tanto, esta respuesta ya no
    // corresponde al punto actual: se descarta.
    if (m.lat !== selectedLat || m.lng !== selectedLng) return;

    if (s.ok) {
      // Repintado quirúrgico: sólo cambia lo que depende del suelo. La
      // textura y el pH se escriben en sus campos y los factores de hábitat
      // se recalculan, sin tocar el mapa ni reconstruir las 19 tarjetas.
      actualizarSoloSuelo(s);
    } else {
      setSoilHint(s.error || 'SoilGrids no disponible');
    }
  } catch (e) {
    console.warn(e);
    setSoilHint(String(e.message || e));
  }
}

/**
 * Segunda fase: llega el suelo y sólo se actualiza lo que depende de él.
 *
 * Antes esto llamaba a aplicarDatos(), que rehacía las 19 tarjetas con
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

  set('soilTypeValue', capitalize(s.textura));
  set('phValue', s.ph != null ? s.ph.toFixed(1) : '—');
  renderTerreno(m, s);
  renderAnalisis();
  refrescarFactoresHabitat();
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

    // Etiqueta de hábitat estimado
    const cond = [...card.querySelectorAll('.condition-item')]
      .find(el => el.textContent.includes('Hábitat estimado'));
    if (cond) {
      const v = cond.querySelector('.condition-value');
      if (v) v.textContent = r.detalle.habEtiqueta || '—';
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
  if (e) e.innerHTML = `<span class="soil-unavailable">${msg}</span>`;
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
  e.innerHTML = `Textura <strong>${capitalize(s.textura)}</strong>`
    + ` · arena <strong>${n0(s.arena)}%</strong>`
    + ` / arcilla <strong>${n0(s.arcilla)}%</strong>`
    + ` / limo <strong>${n0(s.limo)}%</strong>`
    + ` · pH <strong>${n0(s.ph * 10) / 10}</strong>`
    + ` · carbono <strong>${n0(s.costero)} g/kg</strong>`
    + `<br><span class="soil-note">ISRIC SoilGrids 2.0, horizonte 5-15 cm, rejilla 250 m</span>`;
}

const capitalize = s => s ? s[0].toUpperCase() + s.slice(1) : s;

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
 * repetía lo que ya dicen los 19 anillos y ocupaba más sitio que la ficha.
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
        <span class="condition-value">${r.detalle.habEtiqueta || '—'}</span>
      </div>
      <div class="condition-item">
        <span>🔥 GDD acum.:</span>
        <span class="condition-value">${Math.round(r.G)} / ${sp.gddNeed}</span>
      </div>
      <div class="condition-item">
        <span>💧 Lluvia eff.:</span>
        <span class="condition-value">${r.reff.toFixed(1)} mm</span>
      </div>
    </div>

    <div class="mushroom-details">
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Base / Techo:</span>
        <span class="mushroom-detail-value">${sp.tBase} / ${sp.tMax} °C</span>
      </div>
      <div class="mushroom-detail-item">
        <span class="mushroom-detail-label">Helada crítica:</span>
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
        <span class="mushroom-detail-label">Factor altitud:</span>
        <span class="mushroom-detail-value">${pct(r.detalle.alt)}%</span>
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
      <td title="Hídrico">${pct(r.H)}%</td>
      <td title="Acumulación GDD">${pct(r.A)}%</td>
      <td title="Temporada documentada">${pct(r.T)}%</td>
      <td title="GDD acumulado">${Math.round(r.G)}</td>
      <td title="Lluvia efectiva">${r.reff.toFixed(0)}</td>
      <td title="Temp. óptima">${sp.tOpt}°C</td>
      <td title="Compatibilidad de hábitat (estimada)">${pct(r.detalle.habFactor)}%</td>
      <td class="col-nivel">${r.viable ? n.texto : `— (${r.motivo})`}</td>
    </tr>`;
  }).join('');

  const m = currentCtx;
  const w = currentMeteo || {};
  const n1 = v => (v == null || Number.isNaN(v) ? '—' : v.toFixed(1));
  const acum = k => m.lluvia30.slice(0, k).reduce((a, b) => a + b, 0).toFixed(1);

  c.innerHTML = `
    <div class="card">
      <h3>📊 Ranking de especies</h3>
      <p class="model-note">
        Modelo por ventanas: <code>I = 100 · S · H<sup>0.5</sup> · A · T · F<sub>hábitat</sub> · F<sub>altitud</sub></code><br>
        <strong>S</strong> potencial térmico del suelo ·
        <strong>H</strong> factor hídrico ·
        <strong>A</strong> acumulación de grados-día ·
        <strong>T</strong> temporada documentada ·
        <strong>G</strong> grados-día acumulados ·
        La estacionalidad la fija la <em>temperatura del suelo</em>, no el calendario.
      </p>
      <div class="table-wrapper">
        <table class="ranking-table">
          <thead><tr>
            <th>Especie</th><th>Índice</th><th>S</th><th>H</th><th>A</th><th>T</th>
            <th>GDD</th><th>Lluvia eff.</th><th>T° opt</th><th>F. hábitat</th><th>Estado</th>
          </tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
      <p class="hint-text">
        ⚠️ Parámetros por especie son valores de partida documentados, no calibrados
        con dataset propio. Requieren validación con observaciones de campo.
      </p>
    </div>

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
          <div class="analysis-item"><span class="analysis-label">Humedad 7d</span><span class="analysis-value">${w.hr7 == null ? '—' : Math.round(w.hr7) + '%'}</span></div>
          <div class="analysis-item"><span class="analysis-label">Vegetación (est.)</span><span class="analysis-value">${m.terreno.vegetacion.join(', ')}</span></div>
          <div class="analysis-item"><span class="analysis-label">Textura suelo</span><span class="analysis-value">${m.suelo.ok ? m.suelo.textura : 'no disponible'}</span></div>
        </div>
      </div>
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
  // idempotente: llamarla sin nada guardado devuelve las 19, no lo que
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
          <p><strong>Base / óptimo / techo:</strong> ${sp.tBase} / ${sp.tOpt} / ${sp.tMax} °C</p>
          <p><strong>Mínima crítica:</strong> ${sp.tCrit} °C</p>
          <p><strong>GDD necesarios:</strong> ${sp.gddNeed}</p>
          <p><strong>Ventana hídrica:</strong> ${sp.L} días · óptima ${sp.Ro} mm</p>
          <p><strong>Hábitat:</strong> ${escaparHtml(sp.habitat.join(', '))}</p>
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
    // Formato: "tipo|lat|lng". El tipo distingue un setal propio de una zona
    // de referencia, que comparten la misma estructura.
    const [, lat, lng] = s.value.split('|');
    if (lat) await setLocation(parseFloat(lat), parseFloat(lng));
  });
}

/** Zonas micológicas de referencia (centros de zonas con setas). */
const ZONAS_REFERENCIA = [
  ["Picos de Europa (Asturias)", 43.18, -4.82],
  ["Valle de Arán (Pirineo)", 42.70, 0.65],
  ["Pinares de Soria", 41.76, -2.53],
  ["Montes de lua (Orense)", 42.33, -7.40],
  ["Sierra de Guadarrama", 40.56, -3.88],
  ["Maestrazgo (Castellón)", 40.30, -0.51],
  ["Sierra Morena", 38.43, -5.44],
  ["Montes Vascos", 43.03, -2.55],
  ["La Alcarria (Toledo)", 39.85, -4.15],
  ["Sierra de Gredos", 40.25, -5.20],
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

  const zonas = ZONAS_REFERENCIA.map(z =>
    `<option value="zona|${z[1]}|${z[2]}">${escaparHtml(z[0])}</option>`
  ).join('');

  s.innerHTML = `<option value="">— Zonas de setas —</option>`
    + (mios ? `<optgroup label="Mis setales (${favorites.length})">${mios}</optgroup>` : '')
    + `<optgroup label="Zonas de referencia">${zonas}</optgroup>`;

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
  const bg = { info: '#2196f3', success: '#4caf50', error: '#f44336' }[type];
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
  gurmelo: { icon: '☠️', color: '#b71c1c' },
  seta_cardo: { icon: '⚪', color: '#d7ccc8' },
};