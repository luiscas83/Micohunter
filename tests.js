/* Tests del motor de prediccion de MicoHunter.
 *
 * Ejecutar con:  node tests.js
 *
 * Sin dependencias, sin framework y sin build, porque el proyecto no tiene
 * package.json: el mismo algoritmo.js que carga el navegador es el que se
 * importa aqui con require(), asi que no hay dos copias que se desincronicen.
 *
 * El motor tenia comentarios que lo llamaban verificable y no habia ni un
 * test. Estos son los que faltaban.
 */

'use strict';

const assert = require('node:assert');
const A = require('./algoritmo.js');

let pruebas = 0;
let fallos = 0;

function grupo(nombre) { console.log('\n' + nombre); }

function prueba(nombre, fn) {
  pruebas++;
  try {
    fn();
    console.log('  ok     ' + nombre);
  } catch (e) {
    fallos++;
    console.log('  FALLA  ' + nombre);
    console.log('         ' + (e && e.message ? e.message : e));
  }
}

const r2 = (x) => Math.round(x * 100) / 100;

/* ------------------------------------------------------------------ */
/* Contextos sinteticos                                                 */
/* ------------------------------------------------------------------ */

/* Contexto de 30 dias. lluvia[0] es hoy. */
function ctx(o) {
  o = o || {};
  if (o.tSuelo === undefined) o.tSuelo = 18;   // sin esto, todo salia NaN
  const n = o.lluvia ? o.lluvia.length : 30;
  const hist = [];
  for (let i = n - 1; i >= 0; i--) {
    hist.push({
      d: i,
      t: o.histT ? o.histT[i] : o.tSuelo - 2 + (i % 3),
      tmax: o.tSuelo + 2,
      tmin: o.tSuelo - 8,
      hr: 75,
    });
  }
  hist[hist.length - 1].t = o.tSuelo;
  return {
    historial: hist,
    lluvia30: o.lluvia || Array.from({ length: n }, (_, i) => (i < 10 ? 6 : 0.5)),
    altitude: o.alt === undefined ? 1200 : o.alt,
    tSuelo: hist[hist.length - 1].t,
    mes: o.mes === undefined ? 10 : o.mes,
    terreno: {
      vegetacion: o.veg || ['pinar'],
      exposicion: null,
      humedad: 'normal',
      ph: o.ph === undefined ? 5.0 : o.ph,
      hayMadera: null,
    },
  };
}

function esp(k) {
  const s = A.SPECIES.find(x => x.key === k);
  assert.ok(s, 'no existe la especie ' + k);
  return s;
}

/* ------------------------------------------------------------------ */
/* 1. Funciones de respuesta                                            */
/* ------------------------------------------------------------------ */

grupo('1. Funciones de respuesta');

prueba('potencialEstacional vale 0 bajo la minima critica', () => {
  const sp = esp('boletus');
  assert.strictEqual(A.potencialEstacional(sp.tCrit - 1, sp), 0);
});

prueba('potencialEstacional nunca sale de 0..1', () => {
  const sp = esp('boletus');
  for (let t = -5; t <= 40; t += 0.5) {
    const v = A.potencialEstacional(t, sp);
    assert.ok(v >= 0 && v <= 1, 't=' + t + ' -> ' + v);
  }
});

prueba('potencialEstacional cae por encima del techo', () => {
  const sp = esp('boletus');
  assert.ok(A.potencialEstacional(sp.tMax + 5, sp) < A.potencialEstacional(sp.tMax - 1, sp));
});

prueba('factorTemporada: 1.00 dentro, 0.45 a dos meses, 0.15 lejos', () => {
  const sp = esp('boletus');   // temporada 6-11
  assert.strictEqual(A.factorTemporada(sp, 9), 1.0);
  assert.strictEqual(A.factorTemporada(sp, 7), 1.0, 'el mes 7 esta dentro');
  assert.strictEqual(A.factorTemporada(sp, 4), 0.45);
  assert.strictEqual(A.factorTemporada(sp, 3), 0.15);
});

prueba('factorTemporada con temporada vacia no penaliza', () => {
  assert.strictEqual(A.factorTemporada({ temporada: [] }, 1), 1);
});

prueba('lluviaEfectiva: la misma lluvia concentrada da mas', () => {
  const sp = esp('boletus');
  const hoy = Array(30).fill(0).map((_, i) => (i === 0 ? 20 : 0));
  const repartida = Array(30).fill(0).map((_, i) => (i < 4 ? 5 : 0));
  assert.ok(A.lluviaEfectiva(hoy, sp) > A.lluviaEfectiva(repartida, sp));
});

prueba('lluviaEfectiva vale 0 sin lluvia', () => {
  assert.strictEqual(A.lluviaEfectiva(Array(30).fill(0), esp('boletus')), 0);
});

prueba('altitudeFactor baja fuera del optimo', () => {
  assert.ok(A.altitudeFactor(300) < A.altitudeFactor(1500));
});

/* ------------------------------------------------------------------ */
/* 2. El arreglo del cap del pH                                         */
/* ------------------------------------------------------------------ */

grupo('2. Factor de suelo: el pH ya no esta capado');

prueba('acidofila en su pH ideal no penaliza', () => {
  const r = A.factorSuelo(5.2, esp('boletus'));
  assert.strictEqual(r2(r.factor), 1.0);
  assert.strictEqual(r.etiqueta, 'pH adecuado');
});

prueba('acidofila en suelo calizo SI pierde (antes daba 1.000 igual)', () => {
  const r = A.factorSuelo(7.6, esp('boletus'));
  assert.ok(r.factor < 1, 'sigue capado: ' + r.factor);
  assert.ok(r.factor >= 0.6, 'por debajo del suelo: ' + r.factor);
  assert.strictEqual(r.etiqueta, 'suelo demasiado calizo');
});

prueba('el recorrido del pH es monotono decreciente', () => {
  let previo = 2;
  for (const ph of [4.0, 5.0, 6.0, 7.0, 8.0, 9.0]) {
    const f = A.factorSuelo(ph, esp('boletus')).factor;
    assert.ok(f <= previo, 'ph=' + ph + ' -> ' + f + ' no baja');
    previo = f;
  }
});

prueba('alcalinofila en suelo acido penaliza', () => {
  assert.ok(A.factorSuelo(4.8, esp('seta_cardo')).factor < 1);
});

prueba('sin pH el factor es neutro y se declara desconocido', () => {
  const r = A.factorSuelo(null, esp('boletus'));
  assert.strictEqual(r.factor, 1);
  assert.strictEqual(r.conocido, false);
});

prueba('pH absurdo no rompe ni sale de rango', () => {
  for (const ph of [NaN, -3, 14, undefined, null]) {
    const r = A.factorSuelo(ph, esp('boletus'));
    assert.ok(Number.isFinite(r.factor), 'factor no finito con ph=' + ph);
    assert.ok(r.factor > 0 && r.factor <= 1, 'fuera de rango con ph=' + ph);
  }
});

prueba('el efecto del pH llega hasta el indice final', () => {
  const sp = esp('boletus');
  const acido = A.indice(sp, ctx({ ph: 5.0 }));
  const calizo = A.indice(sp, ctx({ ph: 7.6 }));
  assert.ok(acido.I > calizo.I,
    'el indice no se mueve: ' + acido.I + ' vs ' + calizo.I);
});

/* ------------------------------------------------------------------ */
/* 3. GDD y su tope de ventana                                          */
/* ------------------------------------------------------------------ */

grupo('3. GDD y tope de ventana');

prueba('GDD acumulado coincide con la suma manual', () => {
  const sp = esp('boletus');
  const hist = Array.from({ length: 10 }, () => ({ d: 0, t: sp.tBase + 2, tmax: 0, tmin: 0, hr: 0 }));
  const r = A.calcularGDD(hist, sp, 0);
  assert.strictEqual(r.gdd, 20);
  assert.strictEqual(r.diasEnRango, 10);
});

prueba('el tope se respeta tambien en dias de estres termico', () => {
  // Senderuela tiene diasMax 25: con 30 dias de historico el tope SI puede
  // activarse. Con el boleto (45) no, y el test no probaria nada.
  // Antes del arreglo estos dias hacia continue y no contaban para el tope:
  // diasEnRango llegaba a 30.
  const sp = esp('senderuela');
  const hist = Array.from({ length: 30 }, () => ({ d: 0, t: sp.tMax + 8, tmax: 0, tmin: 0, hr: 0 }));
  const r = A.calcularGDD(hist, sp, 0);
  assert.strictEqual(r.diasEnRango, 25,
    'los dias de estres se saltan el tope: ' + r.diasEnRango);
});

prueba('el tope no supera los dias disponibles y lo declara', () => {
  const sp = esp('boletus');
  const hist = Array.from({ length: 12 }, () => ({ d: 0, t: sp.tBase + 3, tmax: 0, tmin: 0, hr: 0 }));
  const r = A.calcularGDD(hist, sp, 0);
  assert.strictEqual(r.tope, 12);
  assert.strictEqual(r.topeAlcanzable, false);
  assert.strictEqual(r.diasDisponibles, 12);
  assert.strictEqual(r.diasEnRango, 12);
});

prueba('con diasMax corto el tope SI es alcanzable', () => {
  const sp = esp('senderuela');
  const hist = Array.from({ length: 30 }, () => ({ d: 0, t: sp.tBase + 3, tmax: 0, tmin: 0, hr: 0 }));
  const r = A.calcularGDD(hist, sp, 0);
  assert.strictEqual(r.topeAlcanzable, true);
  assert.strictEqual(r.diasEnRango, sp.diasMax);
});



prueba('el factor de acumulacion nunca supera 1', () => {
  assert.strictEqual(A.factorAcondicionamiento(99999, esp('boletus')), 1);
});

/* ------------------------------------------------------------------ */
/* 4. Habitat                                                           */
/* ------------------------------------------------------------------ */

grupo('4. Factor de habitat');

prueba('cobertura principal da 1.00', () => {
  const r = A.evaluarHabitat(esp('niscalos'), { vegetacion: ['pinar'], ph: 5 });
  assert.strictEqual(r2(r.factor), 1.0);
});

prueba('sin cobertura devuelve 0,70 y lo dice (ni premia ni penaliza)', () => {
  const r = A.evaluarHabitat(esp('niscalos'), { vegetacion: [], ph: 5 });
  assert.strictEqual(r2(r.factor), 0.70);
  assert.strictEqual(r.etiqueta, 'sin datos de cobertura');
});

prueba('con cobertura incompatible una especie confinada cae por debajo de 0,30', () => {
  const r = A.evaluarHabitat(esp('niscalos'), { vegetacion: ['robledal'], ph: 5 });
  assert.ok(r.factor > 0 && r.factor < 0.3, '-> ' + r.factor);
});

prueba('vegetacion desconocida degrada en vez de vetar', () => {
  const r = A.evaluarHabitat(esp('boletus'), { vegetacion: ['pastizal'], ph: 5 });
  assert.ok(r.factor > 0);
  assert.strictEqual(r.confuso, true);
});

/* ------------------------------------------------------------------ */
/* 5. Los cinco escenarios sinteticos                                   */
/* ------------------------------------------------------------------ */

grupo('5. Escenarios sinteticos');

const ESC = {
  '30 dias secos': ctx({ histT: Array.from({ length: 30 }, (_, i) => 11 + (i % 2)), lluvia: Array(30).fill(0.2) }),
  'lluvia intensa reciente': ctx({ lluvia: Array(30).fill(9) }),
  'lluvia moderada + temperatura favorable': ctx({}),
  'lluvia + temperaturas demasiado altas': ctx({ tSuelo: 27, histT: Array(30).fill(26) }),
  'condiciones variables': ctx({
    tSuelo: 17,
    histT: Array.from({ length: 30 }, (_, i) => [7, 21, 14, 26, 11, 18][i % 6]),
    lluvia: Array.from({ length: 30 }, (_, i) => [0, 14, 0, 0, 8, 0][i % 6]),
  }),
};

for (const nombre of Object.keys(ESC)) {
  prueba('escenario "' + nombre + '" sin NaN y en rango', () => {
    for (const sp of A.SPECIES) {
      const r = A.indice(sp, ESC[nombre]);
      assert.ok(Number.isFinite(r.I), sp.key + ' -> I=' + r.I);
      assert.ok(r.I >= 0 && r.I <= 100, sp.key + ' fuera de rango: ' + r.I);
      for (const k of Object.keys(r)) {
        if (typeof r[k] === 'number') {
          assert.ok(Number.isFinite(r[k]), sp.key + '.' + k + ' = ' + r[k]);
        }
      }
      const d = r.detalle;
      for (const k of Object.keys(d)) {
        if (typeof d[k] === 'number') {
          assert.ok(Number.isFinite(d[k]), sp.key + '.detalle.' + k + ' = ' + d[k]);
        }
      }
    }
  });
}

prueba('el ranking sale ordenado de mayor a menor', () => {
  const r = A.ranking(ESC['lluvia moderada + temperatura favorable']);
  assert.strictEqual(r.length, A.SPECIES.length);
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i - 1].I >= r[i].I, 'desordenado en la posicion ' + i);
  }
});

prueba('treinta dias secos puntuan menos que lluvia moderada', () => {
  const suma = c => A.SPECIES.reduce((s, sp) => s + A.indice(sp, c).I, 0);
  const seco = suma(ESC['30 dias secos']);
  const humedo = suma(ESC['lluvia moderada + temperatura favorable']);
  assert.ok(seco < humedo, 'seco=' + r2(seco) + ' humedo=' + r2(humedo));
});

/* ------------------------------------------------------------------ */
/* 6. Datos incompletos y robustez                                      */
/* ------------------------------------------------------------------ */

grupo('6. Datos incompletos y casos raros');

prueba('sin SoilGrids (ph null) el indice se calcula igual', () => {
  const r = A.indice(esp('boletus'), ctx({ ph: null }));
  assert.ok(Number.isFinite(r.I) && r.I > 0);
  assert.strictEqual(r.detalle.sueloConocido, false);
});

prueba('historial vacio no rompe', () => {
  const c = ctx({});
  c.historial = [];
  const r = A.indice(esp('boletus'), c);
  assert.ok(Number.isFinite(r.I));
});

prueba('historial con huecos no rompe', () => {
  const c = ctx({});
  c.historial.forEach((d, i) => { if (i % 3 === 0) d.t = null; });
  const r = A.indice(esp('boletus'), c);
  assert.ok(Number.isFinite(r.I));
});

prueba('lluvia30 mas corta que la ventana L no rompe', () => {
  const r = A.indice(esp('boletus'), ctx({ lluvia: Array(5).fill(3) }));
  assert.ok(Number.isFinite(r.I) && r.reff >= 0);
});

prueba('historial con un dia no numerico NO propaga NaN', () => {
  const c = ctx({});
  c.historial[5].t = null;
  c.historial[9].t = undefined;
  const r = A.indice(esp('boletus'), c);
  assert.ok(Number.isFinite(r.I), 'I=' + r.I);
  assert.ok(r.I > 0, 'I=' + r.I);
});

prueba('vegetacion vacia no revienta ninguna especie', () => {
  for (const sp of A.SPECIES) {
    assert.ok(Number.isFinite(A.indice(sp, ctx({ veg: [] })).I), sp.key);
  }
});

prueba('especie desconocida: error controlado', () => {
  const fantasma = { key: 'no_existe', habitat: [], temporada: [] };
  let r;
  try {
    r = A.indice(fantasma, ctx({}));
  } catch (e) {
    assert.ok(e instanceof TypeError || e instanceof RangeError, 'rara: ' + e);
    return;
  }
  assert.ok(Number.isFinite(r.I), 'I=' + r.I);
  assert.ok(Number.isFinite(r.S) && Number.isFinite(r.H) && Number.isFinite(r.A));
});

prueba('las 18 especies tienen los ocho parametros en orden', () => {
  for (const sp of A.SPECIES) {
    for (const k of ['tBase', 'tOpt', 'tMax', 'tCrit', 'gddNeed', 'L', 'Ro', 'diasMax']) {
      assert.ok(Number.isFinite(sp[k]), sp.key + ' sin ' + k);
    }
    assert.ok(sp.tCrit < sp.tBase, sp.key + ': tCrit >= tBase');
    assert.ok(sp.tBase < sp.tOpt, sp.key + ': tBase >= tOpt');
    assert.ok(sp.tOpt < sp.tMax, sp.key + ': tOpt >= tMax');
    assert.ok(sp.diasMax > 0 && sp.Ro > 0 && sp.L > 0, sp.key + ': parametro no positivo');
  }
});

prueba('toda especie tiene habitat y temporada no vacios', () => {
  for (const sp of A.SPECIES) {
    assert.ok(Array.isArray(sp.habitat) && sp.habitat.length, sp.key + ' sin habitat');
    assert.ok(Array.isArray(sp.temporada) && sp.temporada.length, sp.key + ' sin temporada');
  }
});

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7. Altitud por especie                                                */
/* ------------------------------------------------------------------ */

grupo('7. Factor altitudinal por especie');

prueba('las 18 especies tienen banda propia y coherente', () => {
  assert.strictEqual(A.SPECIES.length, 18);
  for (const sp of A.SPECIES) {
    assert.ok(Array.isArray(sp.alt), sp.key + ' sin banda');
    assert.strictEqual(sp.alt.length, 3, sp.key + ': banda de 3 numeros');
    const b = sp.alt;
    assert.ok(b[0] >= 0, sp.key + ': optimo min negativo');
    assert.ok(b[1] > b[0], sp.key + ': max <= min');
    assert.ok(b[2] > 0, sp.key + ': margen no positivo');
    assert.ok(sp.altSuelo > 0 && sp.altSuelo <= 1, sp.key + ': suelo fuera de 0..1');
    assert.ok(['documentado', 'indicado'].includes(sp.altEvidencia),
      sp.key + ': evidencia "' + sp.altEvidencia + '"');
    assert.ok(typeof sp.altFuente === 'string' && sp.altFuente.length > 10,
      sp.key + ': sin fuente');
  }
});

prueba('las bandas NO son todas iguales (ya no es la curva del boleto)', () => {
  const firmas = new Set(A.SPECIES.map(sp => sp.alt.join('-')));
  assert.ok(firmas.size >= 8,
    'solo ' + firmas.size + ' bandas distintas: siguen siendo casi todas la del boleto');
});

prueba('dentro de la banda optima el factor es 1,00', () => {
  for (const sp of A.SPECIES) {
    const medio = Math.round((sp.alt[0] + sp.alt[1]) / 2);
    assert.strictEqual(A.altitudeFactor(medio, sp), 1,
      sp.key + ' a ' + medio + ' m: ' + A.altitudeFactor(medio, sp));
    assert.strictEqual(A.altitudeFactor(sp.alt[0], sp), 1, sp.key + ' en el borde bajo');
    assert.strictEqual(A.altitudeFactor(sp.alt[1], sp), 1, sp.key + ' en el borde alto');
  }
});

prueba('el factor nunca sale de [altSuelo, 1]', () => {
  for (const sp of A.SPECIES) {
    for (const alt of [0, 50, 300, 700, 1047, 1400, 1900, 2500, 3500]) {
      const v = A.altitudeFactor(alt, sp);
      assert.ok(v >= sp.altSuelo - 1e-9 && v <= 1,
        sp.key + ' a ' + alt + ' m = ' + v + ', suelo ' + sp.altSuelo);
    }
  }
});

prueba('el recorrido es unimodal y sin peldanos', () => {
  // Sube hasta la banda optima, meseta dentro y baja despues. Lo que no puede
  // es dar saltos: la curva es continua. Si se comprobara solo "decreciente"
  // fallaria en la rampa de subida, que es justamente donde la curva sube.
  for (const sp of A.SPECIES) {
    const centro = Math.round((sp.alt[0] + sp.alt[1]) / 2);
    let subida = -1;
    for (let alt = 0; alt <= centro; alt += 25) {
      const v = A.altitudeFactor(alt, sp);
      assert.ok(v >= subida - 1e-9, sp.key + ' baja al subir hasta ' + alt + ' m');
      subida = v;
    }
    let bajada = 2;
    for (let alt = centro; alt <= 3500; alt += 25) {
      const v = A.altitudeFactor(alt, sp);
      assert.ok(v <= bajada + 1e-9, sp.key + ' sube al bajar en ' + alt + ' m');
      bajada = v;
    }
  }
});

prueba('el fallo original: la ostra en la costa ya no pierde el 50%', () => {
  const sp = esp('girola');   // Pleurotus ostreatus, nivel del mar a 2000 m
  assert.strictEqual(A.altitudeFactor(300, sp), 1);
  assert.strictEqual(A.altitudeFactorGlobal(300), 0.5);
});

prueba('el fallo original: el perrechico bajo ya no pierde el 50%', () => {
  const sp = esp('san_jorge');   // documentado 500-1200 m
  const bajo = A.altitudeFactor(300, sp);
  assert.ok(bajo > A.altitudeFactorGlobal(300),
    'sigue igual que la curva del boleto: ' + bajo);
  assert.strictEqual(bajo, 0.75, 'a 300 m esta a 200 del borde con margen 400');
});

prueba('el fallo original: el boleto en alta montana ya no se castiga', () => {
  const sp = esp('boletus');
  // En España está documentado hasta 3500 m. La curva del boleto lo ponía en
  // 0,50 a partir de 2000 m: 1500 m de rango real desperdiciados.
  assert.strictEqual(A.altitudeFactor(2200, sp), 1);
  assert.strictEqual(A.altitudeFactorGlobal(2200), 0.5);
  // Y el suelo (0,55) no lo toca hasta pasado el margen de 700 m.
  assert.strictEqual(A.altitudeFactor(2900, sp), 0.55);
});

prueba('las dos curvas coinciden donde el boleto manda', () => {
  const sp = esp('boletus');
  assert.strictEqual(A.altitudeFactor(1500, sp), 1);
  assert.strictEqual(A.altitudeFactorGlobal(1500), 1);
});

prueba('sin especie cae en la curva global de reserva', () => {
  assert.strictEqual(A.altitudeFactor(1047, null), A.altitudeFactorGlobal(1047));
  assert.strictEqual(A.altitudeFactor(1047, {}), A.altitudeFactorGlobal(1047));
  assert.strictEqual(A.altitudeFactor(1047, { alt: [1, 2] }), A.altitudeFactorGlobal(1047));
});

prueba('altitud no numerica no rompe', () => {
  const sp = esp('boletus');
  for (const alt of [NaN, undefined, null, -50]) {
    const v = A.altitudeFactor(alt, sp);
    assert.ok(Number.isFinite(v) && v >= sp.altSuelo && v <= 1, alt + ' -> ' + v);
  }
});

prueba('el indice final ya distingue especies por altitud', () => {
  const sp = esp('girola');
  const costa = A.indice(sp, ctx({ alt: 300 })).I;
  const alta = A.indice(sp, ctx({ alt: 2400 })).I;
  assert.ok(costa > alta, 'costa=' + costa + ' alta=' + alta);
});

prueba('el detalle expone la banda y su evidencia', () => {
  const d = A.indice(esp('boletus'), ctx({})).detalle;
  assert.ok(/\d+-\d+ m/.test(d.altBanda), 'banda: ' + d.altBanda);
  assert.ok(['documentado', 'indicado'].includes(d.altEvidencia), d.altEvidencia);
});

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8. Estrés por helada                                                  */
/* ------------------------------------------------------------------ */

grupo('8. Estrés por helada');

/* Contexto con las mínimas de aire de las últimas noches controladas.
   `noches` va de más antigua a más reciente; es el valor de tmin de cada
   noche, que es la señal con la que se detecta la helada. El suelo se deja
   templado salvo que se indique otra cosa, para aislar el efecto del aire. */
function ctxHel(noches, sueloHoy) {
  const c = ctx({});
  for (let k = 0; k < noches.length; k++) {
    c.historial[c.historial.length - 1 - k].tmin = noches[noches.length - 1 - k];
  }
  if (sueloHoy != null) c.historial[c.historial.length - 1].t = sueloHoy;
  c.tSuelo = c.historial[c.historial.length - 1].t;
  return c;
}

const PROLONGADO = [-2, -3, 1, 7];    // tres noches malas y una buena
const AISLADO = [8, 7, -2, 7];        // una noche mala y tres buenas

prueba('las 18 especies tienen los cuatro campos de helada en rango', () => {
  for (const sp of A.SPECIES) {
    assert.ok(Number.isFinite(sp.frostTol), sp.key + ': sin frostTol');
    assert.ok(sp.frostPenalty > 0 && sp.frostPenalty <= 1,
      sp.key + ': frostPenalty ' + sp.frostPenalty);
    assert.ok(sp.frostRecovery > 0 && sp.frostRecovery <= 10,
      sp.key + ': frostRecovery ' + sp.frostRecovery);
    assert.ok(sp.frostSoil >= 0 && sp.frostSoil <= 3,
      sp.key + ': frostSoil ' + sp.frostSoil);
  }
});

prueba('las tolerancias al frío NO son todas iguales', () => {
  const tols = new Set(A.SPECIES.map(sp => sp.frostTol));
  assert.ok(tols.size >= 6, 'solo ' + tols.size + ' tolerancias distintas');
});

prueba('sin helada el factor es exactamente 1', () => {
  const c = ctxHel([9, 10, 9, 11]);
  for (const sp of A.SPECIES) {
    const f = A.frostStress(c.historial, sp, 0);
    assert.strictEqual(f.stress, 0, sp.key + ' con Stress ' + f.stress);
    assert.strictEqual(f.mult, 1, sp.key + ' con mult ' + f.mult);
  }
});

prueba('un episodio prolongado pesa MÁS que uno aislado, en todas', () => {
  const cP = ctxHel(PROLONGADO);
  const cA = ctxHel(AISLADO);
  let comparadas = 0;
  for (const sp of A.SPECIES) {
    const p = A.frostStress(cP.historial, sp, 0);
    const a = A.frostStress(cA.historial, sp, 0);
    assert.ok(p.stress >= a.stress - 1e-9,
      sp.key + ': prolongado ' + p.stress + ' < aislado ' + a.stress);
    comparadas++;
  }
  assert.strictEqual(comparadas, 18);
});

prueba('la helada ya NO pone el índice a cero ni marca no viable', () => {
  // Suelo dentro del rango de todas, con una helada fuerte en el aire.
  const c = ctxHel([-9, -8, -9, -7], 16);
  for (const sp of A.SPECIES) {
    const r = A.indice(sp, c);
    assert.strictEqual(r.viable, true, sp.key + ': viable=' + r.viable);
    assert.strictEqual(r.motivo, null, sp.key + ': motivo=' + r.motivo);
    assert.ok(r.I > 0, sp.key + ' con I=' + r.I + ', se ha quedado en cero');
    assert.ok(Number.isFinite(r.I), sp.key);
  }
});

prueba('el aire cuenta aunque el suelo esté templado', () => {
  // El fallo que se arregla: antes una mínima de -8 °C con suelo a 14 °C no
  // hacía nada al boleto, porque la helada se miraba solo en el suelo.
  const c = ctxHel([-8], 14);
  const f = A.frostStress(c.historial, esp('boletus'), 0);
  assert.ok(f.stress > 0.2, 'la helada de aire sigue sin contar: ' + f.stress);
  assert.ok(f.mult < 1, 'el factor no baja: ' + f.mult);
});

prueba('si el suelo baja del mínimo crítico pesa más que el aire solo', () => {
  const sp = esp('boletus');
  const templado = ctxHel([-3], 16);          // aire helado, suelo a 16
  const frio = ctxHel([-3], 2);                // misma noche, suelo a 2
  const a = A.frostStress(templado.historial, sp, 0);
  const b = A.frostStress(frio.historial, sp, 0);
  assert.ok(b.stress > a.stress + 0.2,
    'el suelo no aporta: aire ' + a.stress + ' vs suelo ' + b.stress);
  assert.strictEqual(b.sueloHelado, true);
  assert.strictEqual(a.sueloHelado, false);
});

prueba('el índice se recupera conforme el episodio se aleja', () => {
  const sp = esp('boletus');
  const serie = [0, 1, 2, 3, 5, 7].map(ant => {
    const c = ctx({});
    c.historial[c.historial.length - 1 - ant].tmin = -6;
    for (const k of [0, 1, 2]) {
      if (k !== ant) c.historial[c.historial.length - 1 - k].tmin = 9;
    }
    return A.frostStress(c.historial, sp, 0);
  });
  for (let i = 1; i < serie.length; i++) {
    assert.ok(serie[i].stress < serie[i - 1].stress,
      'el estrés no baja al alejarse en ' + serie[i - 1].stress + ' -> ' + serie[i].stress);
    assert.ok(serie[i].mult > serie[i - 1].mult,
      'el factor no sube al alejarse en ' + serie[i - 1].mult + ' -> ' + serie[i].mult);
  }
});

prueba('las especies resistentes sufren menos que las frágiles', () => {
  const c = ctxHel(PROLONGADO);
  const dura = A.frostStress(c.historial, esp('girola'), 0);
  const fragil = A.frostStress(c.historial, esp('amanita'), 0);
  assert.ok(dura.mult > fragil.mult,
    'la gírgola (' + dura.mult + ') no aguanta más que la amanita (' + fragil.mult + ')');
  assert.ok(dura.mult >= 0.99, 'la gírgola tiene que salir ilesa: ' + dura.mult);
});

prueba('el estrés y el factor se quedan en sus rangos', () => {
  for (const noches of [[-30], [-30, -30, -30, -30], [5, 5, 5, 5]]) {
    const c = ctxHel(noches);
    for (const sp of A.SPECIES) {
      const f = A.frostStress(c.historial, sp, 0);
      assert.ok(f.stress >= 0 && f.stress <= 1, sp.key + ': stress ' + f.stress);
      assert.ok(f.mult >= sp.frostPenalty - 1e-9 && f.mult <= 1 + 1e-9,
        sp.key + ': mult ' + f.mult + ' fuera de [penalty, 1]');
      assert.ok(Number.isFinite(f.mult) && Number.isFinite(f.stress), sp.key);
    }
  }
});

prueba('las noches de helada por encima de la tolerancia no cuentan', () => {
  // Una noche a -1 °C no le hace nada a la gírgola, que aguanta hasta -6.
  const c = ctxHel([-1], 14);
  const f = A.frostStress(c.historial, esp('girola'), 0);
  assert.strictEqual(f.noches, 0);
  assert.strictEqual(f.mult, 1);
});

prueba('sin mínima de aire el modelo no rompe', () => {
  const c = ctx({});
  for (const d of c.historial) d.tmin = null;
  for (const sp of A.SPECIES) {
    const r = A.indice(sp, c);
    assert.ok(Number.isFinite(r.I), sp.key + ' -> I=' + r.I);
    assert.ok(Number.isFinite(r.detalle.heladaFactor), sp.key);
  }
});

prueba('el detalle expone el episodio para poder contarlo', () => {
  const d = A.indice(esp('boletus'), ctxHel(PROLONGADO)).detalle;
  assert.ok(Number.isFinite(d.heladaFactor), 'sin heladaFactor');
  assert.ok(Number.isFinite(d.heladaEstres), 'sin heladaEstres');
  assert.ok(d.heladaNoches >= 1, 'no cuenta las noches: ' + d.heladaNoches);
  assert.ok(d.heladaMinima <= -1, 'no registra la mínima: ' + d.heladaMinima);
  assert.ok(d.heladaAntiguedad !== null, 'no sabe cuánto hace');
});

prueba('el factor de helada aparece en el índice final', () => {
  const sp = esp('boletus');
  const conHelada = A.indice(sp, ctxHel(PROLONGADO)).I;
  const sinHelada = A.indice(sp, ctxHel([9, 9, 9, 9])).I;
  assert.ok(conHelada < sinHelada,
    'la helada no baja el índice: ' + conHelada + ' vs ' + sinHelada);
});

console.log('\n' + '-'.repeat(58));
console.log(pruebas + ' pruebas, ' + fallos + ' fallos');
console.log('-'.repeat(58));
process.exit(fallos ? 1 : 0);