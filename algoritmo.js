// ============================================================
// MicoHunter — Motor de predicción de fructificación
// ============================================================
//
// FUENTES DE DATOS
//  - Meteorología: Open-Meteo (sin clave, CORS abierto)
//      https://api.open-meteo.com/v1/forecast
//  - Suelo: SoilGrids (ISRIC, acceso público sin clave)
//      https://rest.isric.org/soilproperties/
//  - Terreno: campo `elevation` de Open-Meteo
//
// MODELO
//  En vez de un índice continuo, se modelan VENTANAS DE FRUCTIFICACIÓN
//  mediante:
//    1. GDD (Growing Degree Days) — suma de calor acumulado desde que la
//       temperatura del suelo cruza la base de la especie.
//    2. Un factor hídrico con decaimiento exponencial sobre la ventana L.
//    3. Un estrés por helada con memoria, que reduce pero no borra.
//    4. Techo térmico y fuera de rango, como decaimientos.
//
//  I = 100 · S · H^0.5 · A   donde:
//    S  = potencial estacional por temperatura del suelo (0-1)
//    H  = factor hídrico normalizado (0-1)
//    A  = escriburación: GDD acumulado / GDD necesario (0-1+)
//
//  Referencias metodológicas:
//   - Egli et al. (2010) Suelo y agua como factores limitantes
//   - Lamartiniere & Hoffman (2025) GLMM sobre B. edulis, óptimo 13.2 °C
//   - Martínez-Peña et al. (2012) masa basal y altitud en B. edulis
//   - Kauserud et al. (2012) PNAS, cambio de fenología por calentamiento
//   - Hall et al. (2012) PLoS ONE, 30 años de censo en bosque de roble
// ============================================================

/**
 * Perfiles de preferencia de pH.
 *
 * Cuatro, no tres. El cuarto es `pHTolerante`, y existe por el níscalo:
 * prefiere los suelos ácidos, pero no le estorban los calizos ni los
 * arenosos. Eso no es lo mismo que ser indiferente, y con los tres perfiles
 * anteriores había que elegir entre las dos cosas y se elegía la falsa: o
 * marcándolo acidófilo, que le restaba puntos en un suelo de pH 7,8 siendo
 * que ahí crece bien, o marcándolo indiferente, que pierdía la preferencia.
 *
 * Se distinguen por las tres cifras, no por el nombre:
 *
 *              óptimo  meseta  suelo en el peor caso
 *   ácido        5,2     1,5        0,60
 *   alcalino     7,6     1,4        0,60
 *   indiferente  6,8     1,8        0,70
 *   tolerante    5,6     3,4        0,85
 *
 * El tolerante mantiene el óptimo ácido —que es la preferencia— pero ensancha
 * la meseta hasta 3,4, de modo que pH 2,2 a 9,0 dan factor 1,00. En un suelo
 * de pH 7,8 el níscalo deja de perder puntos, que es lo que pedía el caso.
 */

const API = {
  openMeteo: 'https://api.open-meteo.com/v1/forecast',
  openMeteoArchive: 'https://archive-api.open-meteo.com/v1/archive',
  nominatim: 'https://nominatim.openstreetmap.org/reverse',
  geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
};

/**
 * Datos descriptivos de cada especie, tomados de la FUENTE PRIMARIA del
 * proyecto:
 *
 *   Hans E. E. Laux, "Setas de España y Europa", TIKAL, 2012 (ed. española
 *   de su guía de campo).
 *
 * Por qué están aquí y no dentro de cada ficha: para poder cotejarlos de un
 * vistazo. Cada texto es el campo "ÉPOCA Y LUGAR", "UTILIZACIÓN" o
 * "CONFUSIÓN CON SETAS PELIGROSAS" de la ficha correspondiente del libro,
 * sin reescribirlo. Las especies del modelo apuntan aquí con `ver`, así que
 * cualquier duda de dónde salió un dato se resuelve mirando la cita.
 *
 * LO QUE EL LIBRO NO TIENE
 *
 * El libro es una guía de identificación: describe sombrero, pie, esporas y
 * cuándo y dónde crece. No trae ningún número. Por eso los parámetros del
 * modelo —tBase, tOpt, tMax, tCrit, gddNeed, L, Ro, tolerancias al frío,
 * bandas altitudinales— NO salen de aquí: salen de los estudios científicos
 * que ya estaban citados en cada ficha. La regla acordada es:
 *
 *   - los HECHOS (época, hábitat, suelo, comestibilidad, confusión) salen del
 *     libro;
 *   - los NÚMEROS del modelo salen de la literatura, y se dejan como estaban
 *     porque son los que la aplicación lleva mostrando desde el principio.
 *
 * ÚNICA EXCEPCIÓN DOCUMENTADA
 *
 * Pleurotus eryngii (seta de cardo) NO tiene ficha en el libro: los Pleurotus
 * que aparecen son cornucopiae, dryinus, mitis, ostreatus, pulmonarius,
 * ulmarius y violaceofulvus. Sus datos salen de Carlavilla & Manjón, Italian
 * Mycology 2023, y se marca como excepción en la propia ficha.
 */
const LAUX = {
  boletus: {
    epoca: 'de julio a octubre, en bosques de coníferas, alguna vez surgen '
      + 'también en bosques caducifolios de toda Europa. Pueden aparecer en '
      + 'masa en zonas de reciente repoblación de pinos',
    util: 'comestible, muy apreciada en la cocina',
  },
  niscalos: {
    epoca: 'de agosto a octubre, debajo de pinos (Pinus) en todas las zonas de '
      + 'Europa de clima templado, sobre suelos neutros o calizos',
    util: 'comestible',
  },
  amanita: {
    epoca: 'de julio hasta octubre, aisladas o en grupos, en bosques caducifolios, '
      + 'amantes del calor; en Europa muy escasas; en el sur de Europa es '
      + 'apreciada como un delicado manjar. Especie protegida en muchos países',
    util: 'comestible',
    confusion: 'se puede confundir con la matamoscas o falsa oronja (Amanita '
      + 'muscaria), que tiene restos de vélum en forma de copos blancos sobre '
      + 'el sombrero, láminas blancas y un pie blanco',
  },
  rebozuelo: {
    epoca: 'de junio a noviembre, aislada o en grupos, en bosques caducifolios y '
      + 'de coníferas; en Europa está muy extendida, en muchos lugares está en '
      + 'franco retroceso',
    util: 'comestible, muy apreciada por su valor comercial como seta de '
      + 'mercado debido a su resistencia y a que casi nunca presenta gusanos',
    confusion: 'en la Europa meridional prolifera una seta muy similar a ella '
      + 'aunque venenosa, la seta de olivo (Omphalotus olearius), que se '
      + 'encuentra en el tronco y las raíces de viejos olivos',
  },
  senderuela: {
    epoca: 'desde mayo hasta noviembre, en ocasiones en grandes cantidades, en '
      + 'líneas o corros sobre prados, superficies de hierba, parques y en los '
      + 'linderos de los bosques; ampliamente extendida',
    util: 'comestible, muy apropiada como seta de aderezo; los pies son duros',
    confusion: 'en los mismos lugares crece la Inocybe erubescens y otras setas '
      + 'venenosas de los géneros Inocybe, Clitocybe, Entoloma y Panaeolus',
    interesante: 'el micelio libera compuestos de nitrógeno, por lo que la '
      + 'hierba primero presenta un jugoso color verde oscuro',
  },
  parasol: {
    epoca: 'de julio hasta octubre, en bosques caducifolios y de coníferas, '
      + 'sobre prados; muy extendida en el centro de Europa',
    util: 'comestible; fácilmente reconocible',
    confusion: 'más pequeña es la lepiota de escamas puntiagudas '
      + '(Echinoderma asperum). La muy poco común Macrolepiota venenata causa '
      + 'fuertes afecciones gastrointestinales',
  },
  champinon: {
    epoca: 'de junio a octubre, en prados, campos y tierras de cultivo; muy '
      + 'extendida en Europa',
    util: 'comestible',
    confusion: 'el agárico amarilleante (Agaricus xanthoderma) se reconoce por '
      + 'el bulbo del pie amarillo que aparece al cortar y por su desagradable '
      + 'aroma a fenol. Son válidas también las advertencias relativas a las '
      + 'venenosas Amanita',
  },
  girola: {
    epoca: 'desde octubre hasta marzo, de forma parasítica o saprofítica en '
      + 'troncos o tocones de árboles caducifolios, muy raramente en coníferas',
    util: 'comestible. Buena seta para comer, puede ser criada en distintos '
      + 'sustratos',
    confusion: 'puede ser confundida con la Sarcomyxa serotina, que crece en '
      + 'la misma época en madera de árboles caducifolios o coníferas y es más '
      + 'pequeña, con sombrero de verde oliva a amarillo oliva',
  },
  seta_pino: {
    epoca: 'aparece a partir de septiembre y, después de la entrada del '
      + 'invierno, puede durar hasta diciembre; se da en bosques caducifolios '
      + 'y de coníferas, sobre suelos arenosos y barrosos, debajo de abetos '
      + 'rojos (Picea abies) y pinos (Pinus)',
    util: 'comestible',
    confusion: 'es muy semejante por su aspecto al tricoloma atigrado '
      + '(Tricholoma pardalotum) y también emite el mismo olor a harina. El '
      + 'tricoloma saponáceo tiene olor a jabón',
  },
  rovello: {
    epoca: 'desde junio a octubre, en bosques caducifolios y de coníferas, así '
      + 'como en parques; en todas las zonas templadas de Europa; evita los '
      + 'suelos de contenido calizo',
    util: 'comestible',
    confusion: 'son muy similares a ella algunos tipos de Russula de sabor acre '
      + 'y sombrero rojo, como la Russula mairei',
  },
  trompeta: {
    epoca: 'de agosto a noviembre, la mayoría de veces en grupos o corros '
      + 'debajo de hayas (Fagus sylvatica) y robles (Quercus), preferentemente '
      + 'en suelos calizos; está muy extendida en Europa; en la actualidad está '
      + 'en franco retroceso',
    util: 'comestible, es muy apreciada como seta para cocinar. Se utiliza como '
      + 'sucedáneo de las colmenillas y las trufas; es muy apropiada para secar',
    confusion: 'se le parece la trompeta negra (Cantharellus cinereus), pero '
      + 'ésta es más pequeña y tiene unos marcados pliegues en la parte inferior '
      + 'del sombrero. Debido a su forma y color casi no se pueden confundir '
      + 'con setas venenosas',
  },
  morena: {
    epoca: 'de abril a mayo, aislada o en grupos, en bosques caducifolios, '
      + 'ribereños y de arbustos',
    util: 'comestible; las personas más delicadas pueden cocer la colmenilla y '
      + 'luego deshacerse del agua de cocción',
    confusion: 'el bonete (Gyromitra esculenta) tiene una cutícula con forma '
      + 'que se asemeja a un cerebro',
  },
  san_jorge: {
    epoca: 'desde abril hasta junio, en lugares con hierba, en bosques '
      + 'caducifolios, en los bordes de los bosques, en arbustos, sobre prados '
      + 'y parques, en ocasiones en filas y corros',
    util: 'comestible',
    confusion: 'puede confundirse con una seta venenosa muy extendida en '
      + 'Europa, la Inocybe erubescens, que al principio también posee un '
      + 'sombrero blanco, pero no huele a harina. Además, si se la presiona o '
      + 'con la maduración, adquiere una tonalidad rojo teja',
  },
  boleto_pino: {
    epoca: 'de julio a octubre, sobre suelos ácidos, la mayoría de las veces '
      + 'debajo de pinos (Pinus) en casi toda Europa; poco común, debe ser '
      + 'protegida a causa de su rareza',
    util: 'comestible',
  },
  gula_monte: {
    // OJO: el libro NO da ficha de "Craterellus lutescens". Lo incluye como
    // sinónimo de Cantharellus xanthopus (Pers.) Duby, que es como se cita
    // aquí. Hay quien los considera dos especies distintas; se documenta en
    // `taxonomiaAviso` y no sehidden.
    fichaComo: 'Cantharellus xanthopus (Pers.) Duby, Cantharellus lutescens '
      + '(Pers.) Fr. Cantharellaceae',
    epoca: 'de agosto a noviembre, en grupos o corros, en bosques húmedos de '
      + 'coníferas, en bosques pantanosos y caducifolios',
    util: 'comestible; es muy apreciada para secar, buena seta de aderezo',
    confusion: 'es muy semejante a ella el rebozuelo atrompetado '
      + '(Cantharellus tubaeformis), pero éste tiene un sombrero amarillo '
      + 'grisáceo y unos pliegues claramente marcados en la parte inferior',
  },
  hongo_verano: {
    epoca: 'desde mayo hasta julio, en bosques de hayas y robles herbáceos, y '
      + 'suelos ricos en cal, durante veranos calurosos. También en parques; '
      + 'es una seta escasa',
    util: 'comestible',
    confusion: 'de joven se confunde fácil con otros boletos comestibles',
  },
  boleto_bronce: {
    epoca: 'desde junio hasta octubre, en bosques caducifolios cálidos '
      + '(predominantemente de robles); poco común y está fuertemente afectado '
      + 'por el impacto medioambiental. En muchos lugares está en pleno '
      + 'retroceso y debe ser protegido a causa de su rareza',
    util: 'comestible',
  },
  pie_azul: {
    epoca: 'desde julio hasta noviembre, en ocasiones también en primavera '
      + '(desde abril hasta mayo), la mayoría de las veces en corros o grupos, '
      + 'en bosques caducifolios y de coníferas, también en jardines; está muy '
      + 'extendida en Europa',
    util: 'es posible que se presente en ciertos casos individuales alguna '
      + 'reacción de intolerancia: quien la padezca debe renunciar a consumir '
      + 'estas setas',
    confusion: 'entre los Cortinarius existen dos variedades de color '
      + 'semejante que son algo venenosos: Cortinarius traganus y Cortinarius '
      + 'camphoratus; se diferencian de la Lepista nuda tanto por su repugnante '
      + 'olor como por su esporada marrón y, al menos cuando tienen más edad, '
      + 'por unas láminas marrones',
    interesante: 'los pies teñidos también en violeta y su aparición en '
      + 'terrenos herbosos poco abonados',
  },
};

/**
 * Cómo se cita el libro en las fichas, con el contraste de las otras dos
 * fuentes detrás.
 *
 * Se hace aquí y no en cada ficha para que no haya 19 sitios donde olvidarse de
 * añadirlo: cualquier especie nueva lo lleva puesto por construcción.
 *
 * @param key     clave en LAUX
 * @param numeros dónde salen los valores numéricos del modelo
 * @returns       texto de fuente completo
 */
function fuenteLaux(key, numeros) {
  const l = LAUX[key];
  let t = 'Laux, "Setas de España y Europa" (TIKAL, 2012): "' + l.epoca + '"; '
    + 'UTILIZACIÓN: "' + l.util + '"';
  if (l.confusion) t += '. CONFUSIÓN: "' + l.confusion + '"';
  if (numeros) t += '. Parámetros numéricos: ' + numeros;
  return t + fuenteCruce(key);
}

/**
 * CONTRASTE CON OTRAS DOS FUENTES
 *
 *   - Waldschatzfinder (waldschatzfinder.de/pilze): temporada y árboles
 *     asociados por especie.
 *   - Wikipedia en inglés: temporada, hábitat, ecología y nomenclatura.
 *
 * Van aquí y no dentro de las fichas por el mismo motivo que `LAUX`: para poder
 * cotejar de un vistazo dónde coincide el libro y dónde no. Estas dos fuentes
 * NO mandan sobre Laux; son la segunda voz, y cuando discrepan se dice en
 * voz alta en vez de promediar.
 *
 * COBERTURA DESIGUAL
 * Waldschatzfinder tiene ficha de 11 de las 19 especies. Faltan la amanita, la
 * rúsula, la capuchina, el boleto de pino, la gula de monte, el boleto
 * reticulado, el boleto bronce y la senderuela. Donde no hay dato se dice
 * "sin ficha", no se rellena de memoria.
 */
const CRUCE = {
  boletus: {
    ws: 'Waldschatzfinder: temporada junio-octubre, árboles "Abeto rojo, Pino, '
      + 'Abeto" (coincide con Laux en pinar; Laux además menciona caducifolios '
      + 'y la repoblación reciente)',
  },
  niscalos: {
    ws: 'Waldschatzfinder: temporada julio-octubre y árboles "Pino, Abeto rojo". '
      + 'Coincide con Laux en que es_PINUS, pero se adelanta un mes.',
  },
  amanita: {
    wiki: 'Wikipedia y Global Fungal Red List: "edible ectomycorrhizal '
      + 'mushroom typically associating with oaks and other hardwood species". '
      + 'Coincide con Laux en caducifolios cálidos.',
  },
  rebozuelo: {
    ws: 'Waldschatzfinder: temporada mayo-septiembre, árboles "Abeto rojo, Haya, '
      + 'Abeto". Laux da junio-noviembre: la web acorta la temporada por ambos '
      + 'extremos. Waldschatzfinder menciona haya, donde Laux solo dice '
      + '"caducifolios" sin nombrarlos.',
  },
  senderuela: {
    wiki: 'Wikipedia: "summer and autumn (May–November in the UK)". Idéntico a '
      + 'Laux. First Nature y MushroomExpert la documentan en "public lawns and '
      + 'parks, often surviving even where people walk quite frequently", es '
      + 'decir, en parques y césped donde pasa gente. Ojo: eso choca con la regla '
      + 'de urbano = 0, que es una decisión del usuario y no de la fuente.',
  },
  parasol: {
    ws: 'Waldschatzfinder: temporada junio-octubre, "no ligada a árboles". '
      + 'Laux da julio-octubre y la sitúa "sobre prados". Coinciden en que no '
      + 'depende de un árbol.',
  },
  champinon: {
    ws: 'Waldschatzfinder: temporada mayo-octubre, "no ligada a árboles". '
      + 'Laux da junio-octubre en "prados, campos y tierras de cultivo".',
  },
  girola: {
    ws: 'Waldschatzfinder: temporada enero-abril y octubre-diciembre, árboles '
      + '"Haya, otras especies de árboles, Abedul". Laux da octubre-marzo. '
      + 'Coinciden en que es la más invernal de todas las de la app.',
  },
  seta_pino: {
    wiki: 'FungiAtlas: "mycorrhizal with pine and mixed forests, especially on '
      + 'sandy soils or soils with lime inclusions"; MushroomExpert: el género '
      + 'Tricholoma es micorrícico. Coincide con el guild de la ficha y con '
      + 'Laux en los suelos arenosos; la web añade matiz de cal que Laux no '
      + 'menciona.',
  },
  rovello: {
    wiki: 'Wikipedia: "appears in summer or autumn, grows primarily in '
      + 'deciduous forests in Europe and North America". Coincide con Laux.',
  },
  trompeta: {
    ws: 'Waldschatzfinder: temporada agosto-noviembre, árboles "Haya, Roble, '
      + 'otras especies de árboles". Idéntico a Laux.',
  },
  morena: {
    ws: 'Waldschatzfinder: temporada abril-mayo. Idéntico a Laux.',
  },
  san_jorge: {
    ws: 'Waldschatzfinder: temporada mayo-junio, "no ligada a árboles".',
    wiki: 'Wikipedia: "found from April to June in the United Kingdom"; en '
      + 'Alemania "Maipilz, where it fruits in May"; en Italia "marzolino", '
      + 'marzo. Y "common in grasslands in Europe, often in areas rich in '
      + 'limestone", por lo que esta ficha pasa a alcalinófila. En España es muy '
      + 'valrada: en el País Vasco el "perretxiko" se come el 28 de abril, San '
      + 'Prudencio. TRES FUENTES DICEN PRIMAVERA.',
  },
  boleto_pino: { nota: 'Sin ficha en Waldschatzfinder ni contraste en Wikipedia.' },
  gula_monte: {
    wiki: 'MushroomExpert: "Cantharellus lutescens is a synonym, as are '
      + 'Cantharellus/Craterellus xanthopus, luteocomus and aurora"; '
      + 'iNaturalist los trata como una sola especie. CONFIRMA que el libro tiene '
      + 'razón al dar la ficha bajo Cantharellus xanthopus. Index Fungorum, en '
      + 'cambio, mantiene Craterellus lutescens (Fr.) Fr. (1838) con basionimo '
      + 'Cantharellus lutescens Fr. 1821 como nombre aparte, así que el criterio '
      + 'no es universal.',
  },
  hongo_verano: {
    wiki: 'Wikipedia: "occurs in deciduous forests of Europe, where it forms a '
      + 'relationship with species of oak (Quercus). The fungus produces '
      + 'fruiting bodies in the summer months". Coincide con Laux en verano y '
      + 'caducifolios, pero la web lo asocia al ROBLE mientras Laux nombra '
      + 'haya y roble.',
  },
  boleto_bronce: {
    wiki: 'Wikipedia: "The cork oak (Quercus suber) is a key host, showing a '
      + 'preference for acidic soils. Roadsides and parks are common habitats". '
      + 'Confirma el acidofilia de la ficha. Ojo: lo de los parques y cunetas '
      + 'choca con la regla de urbano = 0.',
  },
  seta_cardo: {
    ws: 'Waldschatzfinder: temporada abril-noviembre, "no ligada a árboles". '
      + 'Único dato externo que tiene esta especie, que no está en el libro.',
  },
  pie_azul: {
    ws: 'Waldschatzfinder: temporada SEPTIEMBRE-DICIEMBRE, árboles "Abeto rojo, '
      + 'Abeto, Haya". ESTA FUENTE NO COINCIDE CON LAUX, que la da de julio a '
      + 'noviembre y además en primavera. Fungipedia va con Waldschatzfinder '
      + '("late autumn, into winter"). Se sigue a Waldschatzfinder por decisión '
      + 'del usuario, contra el libro.',
    wiki: 'Wikipedia usa el nombre Collybia nuda ("previously described as '
      + 'Lepista nuda and Clitocybe nuda"): hay tres nombres en circulación. '
      + 'Sobre toxicidad, Wikipedia NO menciona muscarina; sí confirma la '
      + 'confusión: "can be confused with certain blue or purple species of '
      + 'the genus Cortinarius, including the uncommon C. camphoratus, many of '
      + 'which may be poisonous".',
  },
};

/**
 * Texto de la cita secundaria, listo para pegar detrás de `fuenteLaux()`.
 * @param key clave de CRUCE
 * @returns   cadena que empieza por ". " o '' si no hay contraste
 */
function fuenteCruce(key) {
  const c = CRUCE[key];
  if (!c) return '';
  const partes = [];
  if (c.ws) partes.push(c.ws);
  if (c.wiki) partes.push(c.wiki);
  if (c.nota) partes.push(c.nota);
  if (!partes.length) return '';
  return '. Fuentes secundarias — ' + partes.join(' ') +
    ' (son contraste, no mandan sobre el libro)';
}

/**
 * Parámetros por especie.
 *
 * CALIBRACIÓN: estos valores son un punto de partida documentado, NO un
 * dataset. Deben recalibrarse con observaciones de campo propias.
 *
 * tBase   : °C de suelo — umbral inferior de actividad (inicio de GDD)
 * tOpt    : °C de suelo — óptimo térmico
 * tMax    : °C de suelo — por encima, estrés (restricción fuerte)
 * tCrit   : °C — mínima absoluta; por debajo, T=0
 * gddNeed : grados-día acumulados necesarios para fructificar
 * L       : días — constante de decaimiento del reservorio hídrico
 * Ro      : mm — lluvia efectiva que satura el factor hídrico
 * diasMax : días — ventana máxima de acumulación
 *
 * RESPUESTA A LA HELADA (cuatro campos, todos en grados Celsius)
 *
 * La helada es un estado que se acumula y se desvanece, no un interruptor:
 *
 *   frostTol   : °C de aire mínimo por debajo del cual la especie sufre.
 *                0 significa que cualquier helada le hace daño; -6 que se
 *                la banca con una helada fuerte.
 *   frostPenalty : multiplicador del índice con el estrés de helada al
 *                máximo. 0,75 = apenas le afecta; 0,10 = casi la destruye.
 *                Nunca es 0: una helada muy fuerte reduce el potencial, no
 *                lo borra, y el índice se recupera con el deshielo.
 *   frostRecovery : días — constante de tiempo con la que se olvida el
 *                episodio. Es lo que hace que hoy con +7 °C después de tres
 *                noches de hielo el índice no esté a cero, sino reducido.
 *   frostSoil  : grados extra de estrés cuando el suelo también se congela,
 *                porque entonces se congeló el micelio y no solo el aire.
 *
 * HEURÍSTICO. Los valores salen de la tolerancia al frío documentada de cada
 * especie, no de mediciones de daños por helada: para eso no hay ensayos.
 */
const SPECIES = [
  {
    key: 'boletus', lat: 'Boletus edulis', es: 'Boleto / Hongo',
    // tomaba del boleto para todas.
    alt: [800, 2200, 700],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.55,
    altEvidencia: 'documentado',
    altFuente: 'Martínez-Peña et al. (2012), gradiente de masa basal 0-38,5 kg/ha en Pinar Grande (Soria, ~1100 m); en España se cita hasta 3500 m',    // Respuesta a la helada: micelio resistente, pero el cuerpo fructífero es blando.
    frostTol: -2, frostPenalty: 0.4, frostRecovery: 4, frostSoil: 1.2,

    // Laux: julio-octubre, coníferas y a veces caducifolios, y "en masa en
    // zonas de reciente repoblación de pinos". El conopenedor va primero
    // porque el libro lo menciona antes.
    
    guild: 'ectomicorricico',
    prioridad: 10,
    habitat: ['pinar', 'bosque_mixto', 'hayedo', 'robledal', 'castaneral'],
    avoidDrySW: true,           // no coloniza sotobosques secos de SO
    temporada: [7, 8, 9, 10],
    temporadaTxt: LAUX.boletus.epoca,
    comestible: 'excelente',
    // Única especie con óptimo térmico medido en campo.
    evidencia: 'publicado',
    fuente: fuenteLaux('boletus',
      'Los datos numéricos no están en el libro, que es una guía de '
      + 'identificación y no publica valores. Proceden de: Lamartiniere & '
      + 'Hoffman (2025), GLMM sobre Boletus edulis: óptimo térmico del suelo '
      + '13,2 °C (bioRxiv 10.64898/2025.12.12.693895); Martínez-Peña et al. '
      + '(2012) sobre masa basal y altitud'),
    acidofilo: true, confined: false,
    tBase: 8, tOpt: 13.2, tMax: 22, tCrit: 3,
    gddNeed: 180, L: 11, Ro: 40, diasMax: 45,
  },
  {
    key: 'niscalos', lat: 'Lactarius deliciosus', es: 'Níscalo / Rovelló',
    // tomaba del boleto para todas.
    alt: [900, 1800, 500],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.55,
    altEvidencia: 'documentado',
    altFuente: 'pinares de montaña de Pinus nigra y P. brutia; Pirineos y Mediterráneo occidental',    // Respuesta a la helada: micelio resistente.
    frostTol: -2, frostPenalty: 0.4, frostRecovery: 4, frostSoil: 1.2,

    guild: 'ectomicorricico',
    prioridad: 20,
    habitat: ['pinar'],          // casi exclusivamente Pinus
    avoidDrySW: false,
    // Laux lo sitúa de AGOSTO a OCTUBRE. Antes ponía septiembre-noviembre.
    temporada: [8, 9, 10],
    temporadaTxt: LAUX.niscalos.epoca,
    comestible: 'comestible buena o mejor',
    evidencia: 'estimado',
    // pH: Laux dice "sobre suelos neutros o calizos", y lo dice de forma
    // expresa. Pero el níscalo sigue siendo un acidófilo que en los pinares
    // ácidos de montaña se da mejor, así que no cabe en ninguno de los tres
    // perfiles de siempre: ni acidófilo (le penalizaría un pH 7,8 donde
    // crece bien) ni indiferente (perdería la preferencia). Se usa el
    // perfil `pHTolerante`: óptimo ácido, meseta ancha.
    pHTolerante: true,
    acidofilo: true, confined: true,
    tBase: 7, tOpt: 11.5, tMax: 20, tCrit: 2,
    gddNeed: 200, L: 12, Ro: 40, diasMax: 50,
    fuente: fuenteLaux('niscalos',
      'altitud y helada de literatura ibérica sobre Pinus nigra y P. brutia; '
      + 'el resto de parámetros son valores de partida sin calibrar'),
  },
  {
    key: 'amanita', lat: 'Amanita caesarea', es: 'Amanita caesarea',
    alias: 'Oronja · Reig',
    // tomaba del boleto para todas.
    alt: [200, 900, 400],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.5,
    altEvidencia: 'documentado',
    altFuente: 'termófila mediterránea, típicamente 200-900 m y hasta 1500 m en los mejores casos',    // Respuesta a la helada: termofila mediterranea, la mas fragil ante el frio.
    frostTol: 2, frostPenalty: 0.15, frostRecovery: 7, frostSoil: 1.6,

    guild: 'ectomicorricico',
    prioridad: 50,
    habitat: ['robledal', 'castaneral', 'encinar', 'bosque_mixto'],
    avoidDrySW: false,
    temporada: [7, 8, 9, 10],
    temporadaTxt: LAUX.amanita.epoca,
    fuente: fuenteLaux('amanita',
      'banda altitudinal sin dato publicado, tomada del rango de las frondosas caducifolias con las que se asocia (HEURÍSTICO); el resto son valores de partida'),
    comestible: 'comestible',
    evidencia: 'estimado',
    acidofilo: false, confined: false,
    tBase: 12, tOpt: 20, tMax: 28, tCrit: 10,
    gddNeed: 150, L: 8, Ro: 30, diasMax: 35,

    confusion: LAUX.amanita.confusion,
  },
  {
    key: 'rebozuelo', lat: 'Cantharellus cibarius', es: 'Rebozuelo / Chantarela',
    alias: 'Galán',
    // tomaba del boleto para todas.
    alt: [500, 1400, 500],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.6,
    altEvidencia: 'indicado',
    altFuente: 'haya y robledal de media montaña; sin fuente con rango en metros',    // Respuesta a la helada: verano-otono tardio.
    frostTol: -1, frostPenalty: 0.35, frostRecovery: 4, frostSoil: 1.2,

    // Laux incluye las coníferas: "en bosques caducifolios y de coníferas".
    
    guild: 'ectomicorricico',
    prioridad: 30,
    habitat: ['hayedo', 'robledal', 'castaneral', 'pinar', 'bosque_mixto'],
    avoidDrySW: false,
    temporada: [6, 7, 8, 9, 10, 11],
    temporadaTxt: LAUX.rebozuelo.epoca,
    fuente: fuenteLaux('rebozuelo',
      'banda altitudinal sin dato publicado para la especie (HEURÍSTICO); el resto son valores de partida'),
    comestible: 'comestible',
    evidencia: 'estimado',
    acidofilo: false, confined: false,
    tBase: 10, tOpt: 16, tMax: 24, tCrit: 6,
    gddNeed: 160, L: 10, Ro: 30, diasMax: 40,

    confusion: LAUX.rebozuelo.confusion,
  },
  {
    key: 'senderuela', lat: 'Marasmius oreades', es: 'Senderuela',
    // tomaba del boleto para todas.
    alt: [0, 700, 400],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.7,
    altEvidencia: 'indicado',
    altFuente: 'praderas, cunetas y dunas costeras; sin fuente con rango en metros',    // Respuesta a la helada: pradera y cuneta; muy tolerante a la sequia y al frio, rebrota.
    frostTol: -2, frostPenalty: 0.55, frostRecovery: 3, frostSoil: 0.7,

    // Laux: "sobre prados, superficies de hierba, parques y en los linderos de
    // los bosques". De ahí el borde_bosque, que faltaba.
    
    guild: 'saprofita',
    prioridad: 57,
    habitat: ['pradera', 'pastizal', 'cesped', 'borde_bosque'],
    avoidDrySW: false,
    temporada: [5, 6, 7, 8, 9, 10, 11],
    temporadaTxt: LAUX.senderuela.epoca,
    fuente: fuenteLaux('senderuela',
      'sin dato numérico publicado para la especie; todos los parámetros son valores de partida sin calibrar'),
    comestible: 'comestible',
    evidencia: 'estimado',
    acidofilo: false, confined: false,
    tBase: 9, tOpt: 17, tMax: 28, tCrit: 3,
    gddNeed: 110, L: 7, Ro: 20, diasMax: 25,

    confusion: LAUX.senderuela.confusion,
  },
  {
    key: 'parasol', lat: 'Macrolepiota procera', es: 'Parasol',
    // tomaba del boleto para todas.
    alt: [0, 1000, 400],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.6,
    altEvidencia: 'indicado',
    altFuente: 'praderas y claros, incluida ciudad baja; sin fuente con rango en metros',    // Respuesta a la helada: pradera de verano, muy delicate.
    frostTol: 1, frostPenalty: 0.25, frostRecovery: 6, frostSoil: 1.4,

    // Laux: "en bosques caducifolios y de coníferas, sobre prados".
    
    guild: 'saprofita',
    prioridad: 58,
    habitat: ['claro', 'borde_bosque', 'pastizal', 'matorral', 'pradera'],
    avoidDrySW: false,
    temporada: [7, 8, 9, 10],
    temporadaTxt: LAUX.parasol.epoca,
    fuente: fuenteLaux('parasol',
      'sin dato numérico publicado para la especie; todos los parámetros son valores de partida sin calibrar'),
    comestible: 'comestible',
    evidencia: 'estimado',
    acidofilo: false, confined: false,
    tBase: 11, tOpt: 18, tMax: 26, tCrit: 6,
    gddNeed: 150, L: 7, Ro: 25, diasMax: 35,

    confusion: LAUX.parasol.confusion,
  },
  {
    key: 'champinon', lat: 'Agaricus campestris', es: 'Champiñón silvestre',
    // tomaba del boleto para todas.
    alt: [0, 900, 400],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.6,
    altEvidencia: 'indicado',
    altFuente: 'pradera y pastizal de secano; sin fuente con rango en metros',    // Respuesta a la helada: pradera de secano, otono.
    frostTol: -1, frostPenalty: 0.35, frostRecovery: 4, frostSoil: 1.2,

    // Laux: "en prados, campos y tierras de cultivo".
    
    guild: 'saprofita',
    prioridad: 60,
    habitat: ['pradera', 'pastizal', 'majadal', 'ganado'],
    avoidDrySW: false,
    temporada: [6, 7, 8, 9, 10],
    temporadaTxt: LAUX.champinon.epoca,
    fuente: fuenteLaux('champinon',
      'sin dato numérico publicado para la especie; todos los parámetros son valores de partida sin calibrar'),
    comestible: 'comestible',
    evidencia: 'estimado',
    acidofilo: false, confined: false,
    tBase: 9, tOpt: 16, tMax: 24, tCrit: 3,
    gddNeed: 120, L: 7, Ro: 20, diasMax: 25,

    confusion: LAUX.champinon.confusion,
  },
  {
    key: 'girola', lat: 'Pleurotus ostreatus', es: 'Seta de ostra',
    alias: 'Gírgola',
    // tomaba del boleto para todas.
    alt: [0, 1200, 800],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.7,
    altEvidencia: 'documentado',
    altFuente: 'el complejo P. ostreatus va del nivel del mar a 2000 m en Europa mediterránea (IMA Fungus 2020)',    // Respuesta a la helada: fructifica con la helada y seStimula con ella; la trehalosa le da antifreeze.
    frostTol: -6, frostPenalty: 0.75, frostRecovery: 2, frostSoil: 0.4,

    // Laux: "en troncos o tocones de árboles caducifolios, muy raramente en
    // coníferas". Por eso se quita el pinar de la lista.
    
    guild: 'saprofita_lignum',
    prioridad: 55,
    substrate: 'madera',         // requiere sustrato leñoso
    // No se puede saber desde coordenadas si hay tronco o tocón. Se listan
    // también los bosques, para que el factor no colapse en todos ellos.
    habitat: ['tronco', 'tocon', 'madera_muerta', 'hayedo', 'robledal',
      'castaneral', 'fresnedal', 'olmedal'],
    avoidDrySW: false,
    temporada: [10, 11, 12, 1, 2, 3],
    temporadaTxt: LAUX.girola.epoca,
    fuente: fuenteLaux('girola',
      'sin dato numérico publicado para la especie; todos los parámetros son valores de partida sin calibrar'),
    comestible: 'comestible',
    evidencia: 'estimado',
    acidofilo: false, confined: false,
    tBase: 6, tOpt: 14, tMax: 22, tCrit: -3,
    gddNeed: 130, L: 8, Ro: 25, diasMax: 35,

    confusion: LAUX.girola.confusion,
  },
  {
    key: 'seta_pino', lat: 'Tricholoma portentosum', es: 'Capuchina',
    alias: 'Seta de los piñones',
    // tomaba del boleto para todas.
    alt: [1000, 1900, 600],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.5,
    altEvidencia: 'indicado',
    altFuente: 'pino de montaña; sin fuente con rango en metros',    // Respuesta a la helada: especie de pino de montana, otoño tardio hasta invierno.
    frostTol: -5, frostPenalty: 0.6, frostRecovery: 3, frostSoil: 0.8,

    // Laux: "se da en bosques caducifolios y de coníferas, sobre suelos
    // arenosos y barrosos, debajo de abetos rojos (Picea abies) y pinos", y
    // "después de la entrada del invierno, puede durar hasta diciembre".
    
    guild: 'ectomicorricico',
    prioridad: 54,
    habitat: ['pinar', 'hayedo', 'robledal', 'bosque_mixto'],
    avoidDrySW: false,
    temporada: [9, 10, 11, 12],
    temporadaTxt: LAUX.seta_pino.epoca,
    fuente: fuenteLaux('seta_pino',
      'banda altitudinal sin dato publicado para la especie (HEURÍSTICO); el resto son valores de partida'),
    comestible: 'comestible',
    evidencia: 'estimado',
    acidofilo: true, confined: true,
    tBase: 4, tOpt: 10, tMax: 17, tCrit: 0,
    gddNeed: 140, L: 12, Ro: 35, diasMax: 50,

    confusion: LAUX.seta_pino.confusion,
  },
  {
    key: 'rovello', lat: 'Russula vesca', es: 'Rúsula comestible',
    // tomaba del boleto para todas.
    alt: [400, 1600, 500],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.6,
    altEvidencia: 'indicado',
    altFuente: 'hayedo y robledal; sin fuente con rango en metros',    // Respuesta a la helada: miceliaruble.
    frostTol: -2, frostPenalty: 0.4, frostRecovery: 4, frostSoil: 1.2,

    // Laux: "en bosques caducifolios y de coníferas, así como en parques", y
    // "evita los suelos de contenido calizo": de ahí acidofilo.
    
    guild: 'ectomicorricico',
    prioridad: 53,
    habitat: ['hayedo', 'robledal', 'pinar', 'castaneral', 'bosque_mixto'],
    avoidDrySW: false,
    temporada: [6, 7, 8, 9, 10],
    temporadaTxt: LAUX.rovello.epoca,
    fuente: fuenteLaux('rovello',
      'banda altitudinal sin dato publicado para la especie (HEURÍSTICO); el resto son valores de partida'),
    comestible: 'comestible',
    evidencia: 'estimado',
    acidofilo: true, confined: false,
    tBase: 10, tOpt: 16, tMax: 25, tCrit: 5,
    gddNeed: 160, L: 9, Ro: 30, diasMax: 40,

    confusion: LAUX.rovello.confusion,
  },
  {
    key: 'trompeta', lat: 'Craterellus cornucopioides', es: 'Trompeta de la muerte',
    // tomaba del boleto para todas.
    alt: [200, 1200, 500],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.55,
    altEvidencia: 'indicado',
    altFuente: 'haya y roble; registros a 400 m y en hayedo de montaña',    // Respuesta a la helada: haya y roble, otono tardio.
    frostTol: -2, frostPenalty: 0.5, frostRecovery: 4, frostSoil: 1,

    // Laux: "debajo de hayas (Fagus sylvatica) y robles (Quercus),
    // preferentemente en suelos calizos". No menciona castañar.
    
    guild: 'ectomicorricico',
    prioridad: 51,
    habitat: ['hayedo', 'robledal'],
    avoidDrySW: false,
    temporada: [8, 9, 10, 11],
    temporadaTxt: LAUX.trompeta.epoca,
    fuente: fuenteLaux('trompeta',
      'banda altitudinal sin dato publicado para la especie (HEURÍSTICO); el resto son valores de partida'),
    comestible: 'comestible',
    evidencia: 'estimado',
    acidofilo: false, confined: false,
    tBase: 7, tOpt: 13, tMax: 21, tCrit: 3,
    gddNeed: 190, L: 12, Ro: 35, diasMax: 50,

    confusion: LAUX.trompeta.confusion,
  },
  {
    key: 'morena', lat: 'Morchella esculenta', es: 'Marzuelo / Seta de marzo',
    alias: 'Colmenilla · Morella',
    // tomaba del boleto para todas.
    alt: [100, 1200, 500],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.55,
    altEvidencia: 'indicado',
    altFuente: 'frutal y ribera; sin fuente con rango en metros',    // Respuesta a la helada: primavera temprana, tras el deshielo; las ascosporas necesitan suelo sobre 10 °C.
    frostTol: -4, frostPenalty: 0.5, frostRecovery: 3, frostSoil: 0.8,

    // Laux: "de abril a mayo, en bosques caducifolios, ribereños y de
    // arbustos". No menciona pinar, así que se quita.
    
    guild: 'saprofita',
    prioridad: 56,
    // Hospedantes documentados en la península y el Mediterráneo (Morchella,
    // Wikipedia): Abies, Pinus, Populus, Ulmus, Quercus, Arbutus, Castanea,
    // Alnus, Olea, Malus, Fraxinus. También en suelos perturbados y tras incendios.
    habitat: ['fresnedal', 'olmedal', 'ribera', 'frutal', 'matorral', 'robledal'],
    temporada: [4, 5],
    temporadaTxt: LAUX.morena.epoca,
    comestible: 'comestible cocida',
    aviso: 'Tóxica en crudo. No confundir con el gurumelo (Gyromitra), mortal.',
    evidencia: 'derivado',
    fuente: fuenteLaux('morena',
      'Los datos numéricos no están en el libro. Proceden de literatura '
      + 'general sobre la colmenilla (Woodland Trust para la temporada, '
      + 'EnglishFungi para el suelo calcáreo); se han sustituido las citas a '
      + 'Wikipedia que tenía esta ficha'),
    avoidDrySW: false,
    acidofilo: false, confined: false,
    // Preferencia documentada por suelo de base calcárea (alcalino), aunque
    // también aparece en suelos ácidos: de ahí que no sea acidofila.
    alcalinofila: true,
    tBase: 7, tOpt: 12, tMax: 18, tCrit: 0,
    gddNeed: 120, L: 10, Ro: 20, diasMax: 30,

    confusion: LAUX.morena.confusion,
  },
  {
    key: 'san_jorge', lat: 'Calocybe gambosa', es: 'Perrechico',
    // tomaba del boleto para todas.
    alt: [500, 1200, 400],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.5,
    altEvidencia: 'documentado',
    altFuente: 'cinturón norte (Álava, Navarra, Burgos, La Rioja, Soria) entre 500 y 1200 m',    // Respuesta a la helada: pradera de primavera, tolera las heladas tardias.
    frostTol: -3, frostPenalty: 0.5, frostRecovery: 3, frostSoil: 0.8,

    guild: 'saprofita',
    prioridad: 59,
    // Laux la sitúa en "lugares con hierba, bosques caducifolios, bordes de los
    // bosques, arbustos, prados y parques": es más de pradera que de bosque,
    // pero el borde y el matorral están en la ficha.
    habitat: ['pradera', 'borde_bosque', 'matorral', 'claro'],
    // Laux la da en PRIMAVERA: "desde abril hasta junio". Antes la app la
    // tenía en septiembre-noviembre, que era lo contrario.
    //
    // Los números térmicos NO se tocan (tBase 6, tOpt 11, tMax 17), y son de
    // otoño-frío. Queda una incoherencia conocida: la ventana de temporada T
    // y la ventana térmica no apuntan a la misma estación. Se declara aquí en
    // lugar de disimularla ajustando un número que llevas meses viendo; si se
    // quisiera cerrar el desfase, el sitio es tOpt y no la temporada.
    temporada: [4, 5, 6],
    temporadaTxt: LAUX.san_jorge.epoca,
    comestible: 'excelente',
    evidencia: 'estimado',
    // pH: Wikipedia dice que es "common in grasslands in Europe, often in areas
    // rich in limestone", y en España es la seta de San Prudencio en un clima
    // que no es ácido. Antes era indiferente; pasa a alcalinófila por decisión
    // del usuario. Laux no dice nada del pH, así que la cita es secundaria.
    alcalinofila: true,
    avoidDrySW: false,
    acidofilo: false, confined: false,
    tBase: 6, tOpt: 11, tMax: 17, tCrit: 1,
    gddNeed: 110, L: 9, Ro: 20, diasMax: 30,
    confusion: LAUX.san_jorge.confusion,
    fuente: fuenteLaux('san_jorge',
      'banda altitudinal del cinturón norte (Álava, Navarra, Burgos, La '
      + 'Rioja, Soria) entre 500 y 1200 m; el resto son valores de partida'),
  },

  // ══════════════════════════════════════════════════════════
  // ESPECIES AÑADIDAS — ver nota de procedencia más abajo
  // ══════════════════════════════════════════════════════════
  {
    key: 'boleto_pino', lat: 'Boletus pinophilus', es: 'Boleto de pino',
    alias: 'Boletus pinicola · Cep vermellós · Calabaza',
    // tomaba del boleto para todas.
    alt: [400, 1800, 600],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.5,
    altEvidencia: 'documentado',
    altFuente: 'desde bosque de tierra baja hasta 1800 m',    // Respuesta a la helada: micelio resistente.
    frostTol: -2, frostPenalty: 0.4, frostRecovery: 4, frostSoil: 1.2,

    // Laux: "de julio a octubre, sobre suelos ácidos, la mayoría de las veces
    // debajo de pinos (Pinus)". Se retira la temporada larga de
    // abril-octubre que tenía antes.
    
    guild: 'ectomicorricico',
    prioridad: 40,
    // Hospedantes documentados: Pinus (muy detallado: P. sylvestris, pinea,
    // pinaster, radiata, nigra, uncinata), Abies alba, Picea abies y, de
    // forma secundaria, Castanea, Quercus, Fagus, Betula y Carpinus.
    habitat: ['pinar', 'bosque_mixto'],
    temporada: [7, 8, 9, 10],
    temporadaTxt: LAUX.boleto_pino.epoca,
    comestible: 'excelente',
    evidencia: 'derivado',
    fuente: fuenteLaux('boleto_pino',
      'Los datos numéricos no están en el libro. Se han sustituido las citas '
      + 'a Wikipedia y a un foro que tenía esta ficha, que además describían '
      + 'una temporada de abril a octubre que el libro no sostiene'),
    // Suelos pobres, ácidos y arenosos de conífera.
    acidofilo: true, confined: false,
    avoidDrySW: false,
    tBase: 7, tOpt: 14, tMax: 21, tCrit: 2,
    gddNeed: 160, L: 11, Ro: 40, diasMax: 50,
  },
  {
    key: 'gula_monte', lat: 'Craterellus lutescens', es: 'Gula de monte / Trompeta amarilla',
    alias: 'Cantharellus lutescens · Camagroc',
    // tomaba del boleto para todas.
    alt: [300, 1200, 500],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.55,
    altEvidencia: 'documentado',
    altFuente: 'citada a 600 m en el prelittoral mediterráneo y a 1400 m en los Pirineos; pinares de ribera y cerca del mar',    // Respuesta a la helada: pinar humedo de montana.
    frostTol: -3, frostPenalty: 0.5, frostRecovery: 4, frostSoil: 1,

    // ATENCIÓN: el libro no tiene ficha de "Craterellus lutescens"; da estos
    // datos en la ficha de Cantharellus xanthopus (Pers.) Duby, donde figura
    // como sinónimo. Se documenta en taxonomiaAviso.
    
    guild: 'ectomicorricico',
    prioridad: 52,
    // Micorrízico, en pinares y abetales, sobre musgo y suelos húmedos;
    // en grandes colonias, a menudo cerca del mar.
    habitat: ['pinar', 'ribera', 'hayedo', 'robledal', 'bosque_mixto'],
    temporada: [8, 9, 10, 11],
    temporadaTxt: LAUX.gula_monte.epoca,
    comestible: 'buena',
    evidencia: 'derivado',
    fuente: fuenteLaux('gula_monte',
      'Los datos numéricos no están en el libro. Se han sustituido las citas a '
      + 'Wikipedia que tenía esta ficha, que además describían un guild '
      + 'micorrícico que el libro no menciona'),
    acidofilo: false, confined: false,
    avoidDrySW: false,
    tBase: 5, tOpt: 10, tMax: 17, tCrit: 0,
    gddNeed: 150, L: 14, Ro: 45, diasMax: 60,

    taxonomiaAviso: LAUX.gula_monte.tax,

    confusion: LAUX.gula_monte.confusion,
  },
  {
    key: 'hongo_verano', lat: 'Boletus reticulatus', es: 'Boleto Reticulado',
    alias: 'Boletus aestivalis · Cèpe d\'été · Sommerröhrling',
    // tomaba del boleto para todas.
    alt: [300, 1300, 500],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.5,
    altEvidencia: 'documentado',
    altFuente: 'termófilo de roble caducifolio; hasta 1500 m',    // Respuesta a la helada: boleto termofilo de verano.
    frostTol: 0, frostPenalty: 0.2, frostRecovery: 6, frostSoil: 1.5,

    // Laux: "desde mayo hasta julio, en bosques de hayas y robles herbáceos,
    // y suelos ricos en cal, durante veranos calurosos. También en parques".
    
    guild: 'ectomicorricico',
    prioridad: 41,
    // Micorrízico con Quercus, Fagus y Castanea en robledal caducifolio.
    habitat: ['hayedo', 'robledal'],
    temporada: [5, 6, 7],
    temporadaTxt: LAUX.hongo_verano.epoca,
    comestible: 'excelente',
    evidencia: 'derivado',
    fuente: fuenteLaux('hongo_verano',
      'Los datos numéricos no están en el libro. Proceden de Beugelsdijk et '
      + 'al. 2008, Mycol. Res. (especie distinta de B. edulis) y de la '
      + 'descripción de suelos cálidos y bien drenados, calizos o limosos. Se '
      + 'han sustituido las citas a Wikipedia y a un portal divulgativo'),
    // "Warm, well-drained chalky or loamy soils" — a diferencia de B. edulis,
    // que prefiere suelos ácidos.
    acidofilo: false, confined: false,
    avoidDrySW: false,
    tBase: 10, tOpt: 16, tMax: 24, tCrit: 5,
    gddNeed: 150, L: 9, Ro: 30, diasMax: 35,

    confusion: LAUX.hongo_verano.confusion,
  },
  {
    key: 'boleto_bronce', lat: 'Boletus aereus', es: 'Boleto bronce / Hongo negro',
    alias: 'Boletus edulis f. aereus · B. mamorensis',
    // tomaba del boleto para todas.
    alt: [50, 1100, 400],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.5,
    altEvidencia: 'documentado',
    altFuente: 'del nivel del mar a 1100 m, con encinar y alcornocal',    // Respuesta a la helada: boleto termofilo, robledal y encinar.
    frostTol: 0, frostPenalty: 0.2, frostRecovery: 6, frostSoil: 1.5,

    // Laux: "en bosques caducifolios cálidos (predominantemente de robles)".
    // El matorral y la dehesa que tenía antes no salen en la ficha.
    
    guild: 'ectomicorricico',
    prioridad: 42,
    // Micorrízico con frondosas y arbustos esclerófilos. Hospedante clave:
    // Quercus suber (alcorque). También Fagus, Castanea, Arbutus, Erica, Cistus.
    // La dehesa se queda aunque el libro no la mencione: el MFE etiqueta los
    // alcornocales y las dehesas con esa palabra, y si ninguna especie la
    // declarara, un punto en una dehesa se quedaría sin ninguna especie que
    // encajara. El libro dice "bosques caducifolios cálidos (predominantemente
    // de robles)", y el alcornoque es un roble de clima cálido.
    habitat: ['robledal', 'dehesa', 'castaneral', 'encinar', 'bosque_mixto'],
    temporada: [6, 7, 8, 9, 10],
    temporadaTxt: LAUX.boleto_bronce.epoca,
    comestible: 'excelente',
    evidencia: 'derivado',
    fuente: fuenteLaux('boleto_bronce',
      'Los datos numéricos no están en el libro. Proceden de Beugelsdijk et '
      + 'al. 2008 (distinto de B. edulis) y de la literatura que recoge su '
      + 'preferencia por suelos ácidos, al contrario que B. reticulatus. Se ha '
      + 'sustituido la cita a Wikipedia'),
    // La fuente dice explícitamente "showing a preference for acidic soils",
    // al contrario que B. reticulatus.
    acidofilo: true, confined: false,
    avoidDrySW: false,
    // Es el boleto de óptimo térmico más alto de los tres: busca el calor.
    tBase: 13, tOpt: 18, tMax: 26, tCrit: 8,
    gddNeed: 170, L: 8, Ro: 25, diasMax: 30,

    confusion: LAUX.boleto_bronce.confusion,
  },
  {
    key: 'seta_cardo', lat: 'Pleurotus eryngii', es: 'Seta de cardo',
    alias: 'Cardoncello · Gírgola de panical · Pleurote du panicaut',
    // tomaba del boleto para todas.
    alt: [0, 800, 400],   // [óptimo min, óptimo max, margen]
    altSuelo: 0.6,
    altEvidencia: 'documentado',
    altFuente: 'praderas secas y estepas mediterráneas',    // Respuesta a la helada: pradera seca y estepa, clima calido.
    frostTol: 3, frostPenalty: 0.12, frostRecovery: 7, frostSoil: 1.6,

    guild: 'saprofita_raices',
    prioridad: 61,
    // NO crece sobre madera: es la única Pleurotus que fructifica sobre las
    // raíces y la base del tallo de plantas vivas de las Apiáceas
    // (umbeliferas). En España, sobre todo Eryngium campestre, en praderas
    // y matorrales secos calcáreos. Provoca "rondas de brujas".
    // ESTA ÚNICA ESPECIE NO ESTÁ EN EL LIBRO DE LAUX.
    //
    // Los Pleurotus que aparecen en "Setas de España y Europa" son
    // cornucopiae, dryinus, mitis, ostreatus, pulmonarius, ulmarius y
    // violaceofulvus. No está el eryngii, así que su ficha conserva la
    // literatura científica. Es la excepción declarada de todo el proyecto.
    habitat: ['pradera', 'pastizal', 'matorral', 'claro', 'majadal'],
    temporada: [3, 4, 5, 9, 10, 11],
    temporadaTxt: 'primavera y otoño en estado silvestre; cultivada todo el año',
    comestible: 'excelente',
    evidencia: 'derivado',
    fuente: 'PLEUROTUS ERYNGII NO ESTÁ EN LAUX, "Setas de España y Europa" '
      + '(TIKAL, 2012), que es la fuente primaria del resto del proyecto. '
      + 'Procede de: Carlavilla & Manjón, Italian Mycology 2023 ("behaves as a '
      + 'necrotrophic pathogen of Eryngium campestre"); Zervakis et al. 2001; '
      + 'Mycology (raíces de Eryngium y otras umbeliferas)'
      + fuenteCruce('seta_cardo'),
    acidofilo: false, confined: false,
    avoidDrySW: false,
    tBase: 8, tOpt: 15, tMax: 24, tCrit: 2,
    gddNeed: 130, L: 10, Ro: 25, diasMax: 40,
  },

  {
    key: 'pie_azul',
    lat: 'Lepista nuda',
    es: 'Seta de pie azul',
    alt: [100, 1400, 600],
    altSuelo: 0.55,
    altEvidencia: 'indicado',
    altFuente: 'sin banda altitudinal publicada para la especie; se toma el rango '
      + 'de las frondosas caducifolias con las que se asocia. HEURÍSTICO',
    // Es una especie de finales de otoño que sigue entrando en invierno, así que
    // tolera las heladas sin problema. Lo que no aguanta bien es la sequedad.
    frostTol: -1, frostPenalty: 0.15, frostRecovery: 6, frostSoil: 1.1,

    // Descomposedora de hojarasca, NO pratense.
    //
    // Existe un desacuerdo real en la literatura sobre su guild: buena parte de
    // las guías la tratan como micorrícica, pero Fungi Foundation la describe
    // entre los hongos que viven "entre restos de plantas en el suelo" y las
    // referencias actuales la citan como saprofita de hojarasca. El libro de
    // Laux no dice nada del guild, así que se mantiene `saprofita_humus`.
    //
    // La distinción no es cosmética: `evaluarHabitat` multiplica por 0,45 a
    // las saprofitas pratenses cuando el punto cae en bosque. Con guild
    // `saprofita` esta seta habría salido con el hábitat al 45 % en el
    // hayedo que es justo donde vive.
    guild: 'saprofita_humus',
    prioridad: 62,
    // Laux: "bosques caducifolios y de coníferas, también en jardines".
    habitat: ['hayedo', 'robledal', 'castaneral', 'pinar',
      'bosque_mixto', 'matorral'],
    // TEMPORADA: NO SIGUE AL LIBRO, Y ES DELIBERADO.
    //
    // Laux da "desde julio hasta noviembre, en ocasiones también en primavera
    // (desde abril hasta mayo)". Waldschatzfinder da "septiembre a diciembre" y
    // Fungipedia dice "abundante a finales de otoño, e incluso hasta bien
    // entrado el invierno": esas dos van juntas. Se ha seguido a
    // Waldschatzfinder por decisión del usuario, contra el libro, así que la
    // cita del libro se conserva arriba en `LAUX.pie_azul.epoca` para que se
    // vea el desacuerdo, y `CRUCE.pie_azul` lo explica en la ficha.
    //
    // La temporadaTxt no se pone aquí a mano: la compone `temporadaTexto()`
    // para que en pantalla se lean los meses de la fuente que manda, no los
    // del libro.
    temporada: [9, 10, 11, 12],
    temporadaTxt: 'septiembre-diciembre, con Waldschatzfinder y Fungipedia. Laux '
      + 'la da más ancha: "desde julio hasta noviembre, en ocasiones también en '
      + 'primavera"',
    comestible: 'comestible con precaución',
    evidencia: 'publicado',
    acidofilo: false, confined: false,
    avoidDrySW: false,
    tBase: 4, tOpt: 11, tMax: 18, tCrit: 0,
    gddNeed: 120, L: 9, Ro: 30, diasMax: 40,

    // ---- AVISO DE SEGURIDAD ----
    //
    // `toxica` es booleano a propósito: el resto del código lo usa como
    // bandera para pintar el cartel rojo y para marcar la tarjeta, no para
    // enseñar el texto. El texto va en `aviso`, que es lo que lee el cartel.
    //
    // Lo que se muestra es lo que dice Laux y nada más. La fuente primaria
    // del proyecto manda sobre los avisos, así que aquí no aparecen ni la
    // muscarina ni el complejo de especies que constan en otros estudios:
    // quedan recogidos en el apartado 8 de la Metodología, en "Limitaciones",
    // con su referencia, para que no se pierdan y se puedan recuperar.
    //
    // El cartel sigue saliéndose por la razón que da el libro: hay dos
    // Cortinarius de color muy semejante que son venenosos.
    toxica: true,
    aviso: 'UTILIZACIÓN (Laux, "Setas de España y Europa", TIKAL, 2012): "es '
      + 'posible que se presente en ciertos casos individuales alguna reacción '
      + 'de intolerancia: quien la padezca debe renunciar a consumir estas '
      + 'setas". CONFUSIÓN CON SETAS PELIGROSAS: "entre los Cortinarius existen '
      + 'dos variedades de color semejante que son algo venenosos: Cortinarius '
      + 'traganus y Cortinarius camphoratus; se diferencian de la Lepista nuda '
      + 'tanto por su repugnante olor como por su esporada marrón y, al menos '
      + 'cuando tienen más edad, por unas láminas marrones".',
    confusion: LAUX.pie_azul.confusion,
    taxonomiaAviso: 'Denominación aceptada: Lepista nuda (Bull.) Cooke, '
      + 'familia Tricholomataceae. Sinónimo principal: Rhodopaxillus nudus '
      + '(Bull.) Maire. Nombres comunes: pie azul, ziza hankaurdin, '
      + 'pimpinella morada. INTERESANTE (Laux): "los pies teñidos también en '
      + 'violeta y su aparición en terrenos herbosos poco abonados".',
    fuente: fuenteLaux('pie_azul',
      'banda altitudinal sin dato publicado para la especie, tomada del rango '
      + 'de las frondosas caducifolias con las que se asocia (HEURÍSTICO); '
      + 'tolerancia a la helada según Woodland Trust ("toleran bien una '
      + 'helada"); temperatura de fructificación 7-21 °C según cultivo '
      + 'publicado'),
  },
];

// ------------------------------------------------------------
// Utilidades numéricas
// ------------------------------------------------------------

const gauss = (x, mu, s) => Math.exp(-((x - mu) ** 2) / (2 * s * s));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Desplazamiento térmico por altitud.
 *
 * SIEMPRE 0 a propósito. Open-Meteo ya entrega la temperatura corregida por
 * la elevación del punto de la rejilla (gradiente 0.0065 K/m). Aplicar otro
 * descentramiento aquí lo contaría dos veces: en un punto de 2436 m eso
 * restaría 12 °C extra y anularía toda la temporada.
 *
 * Se mantiene la función por si algún día se alimenta con datos de una
 * estación a cota fija que exija la corrección.
 */
function tShift(altitude, reference = 500) {
  return 0;
}

/* ---------------------------------------------------------------------
 * Altitud: banda POR ESPECIE
 *
 * Cada especie trae lo suyo en `alt`: [optMin, optMax, margen], en metros,
 * mas `altSuelo`, el valor fuera de rango.
 *
 *   dentro de [optMin, optMax]   1,00   el optimo documentado
 *   fuera                        decae 1 punto por cada `margen` metros
 *   en `altSuelo`                se queda, no baja mas
 *
 * Curva de meseta, igual que la del factor de suelo por pH. Se eligió esta
 * forma y no una de escalones porque así los datos tienen que ser continuos:
 * no hay peldaños sin motivo entre dos bandas contiguas.
 *
 * `altEvidencia` dice de donde sale cada banda:
 *   documentado  hay una fuente con el rango en metros
 *   indicado    deducido del tipo de habitat y del resto de la ficha
 */

function altitudeFactor(altitude, sp) {
  const banda = sp && Array.isArray(sp.alt) && sp.alt.length === 3 ? sp.alt : null;
  if (!banda) return altitudeFactorGlobal(altitude);
  if (!Number.isFinite(altitude)) return 1;

  const min = banda[0], max = banda[1], margen = banda[2];
  const suelo = Number.isFinite(sp.altSuelo) ? sp.altSuelo : 0.5;

  // Distancia al borde mas cercano de la banda optima.
  const fuera = altitude < min ? min - altitude
    : altitude > max ? altitude - max
      : 0;
  if (fuera === 0) return 1;
  if (!(margen > 0)) return suelo;

  return clamp(1 - (1 - suelo) * (fuera / margen), suelo, 1);
}

/**
 * Curva altitudinal de reserva, sin especie.
 *
 * Solo se usa si una ficha llega sin banda `alt`, por ejemplo un registro de
 * favorito de una versión antigua. Los escalones salen de Martínez-Peña et
 * al. (2012), que midió productividad de masa basal de Boletus edulis en un
 * pinar de Soria, así que sirven para un boleto de montaña y no para una
 * seta de tronco de costa.
 */
function altitudeFactorGlobal(altitude) {
  if (altitude < 800) return 0.5;
  if (altitude < 1450) return 0.85;
  if (altitude <= 1650) return 1.0;
  if (altitude < 2000) return 0.8;
  return 0.5;
}

/** Texto de la banda optima, para la tarjeta. */
function altitudEtiqueta(sp) {
  if (!Array.isArray(sp?.alt)) return '';
  return `${sp.alt[0]}-${sp.alt[1]} m`;
}

// ------------------------------------------------------------
// Estacionalidad: la define el SUELO, no el calendario
// ------------------------------------------------------------

/**
 * Ventana de temporada documentada.
 *
 * La temporada de fructificación es, junto con el hospedante, el dato más
 * sólido que hay en micología: está en las fichas de cada especie y coincide
 * entre fuentes. El resto de parámetros numéricos no lo están.
 *
 * Por eso esto NO es un veto sino un peso: si la fecha cae fuera de ventana, la
 * temperatura del suelo de esa fecha ya iría por la vía de S y A. Encima, en
 * España la ventana se desplaza con la latitud y la altitud, así que un 0
 * duro produciría falsos negativos en el norte.
 *
 *   dentro de la ventana   1.00
 *   hasta 2 meses fuera   0.45
 *   más lejos             0.15
 */
function factorTemporada(sp, mes) {
  const t = sp.temporada;
  if (!t || !t.length || !mes) return 1;

  // Distancia circular al mes más cercano de la ventana.
  const distancias = t.map(m => {
    const d = Math.abs(m - mes);
    return Math.min(d, 12 - d);
  });
  const min = Math.min(...distancias);

  if (min === 0) return 1;
  if (min <= 2) return 0.45;
  return 0.15;
}

/**
 * Potencial estacional a partir de la temperatura del suelo.
 * En vez de un día pico fijo, la temporada se abre cuando el suelo
 * supera la base y se cierra cuando se acerca al techo.
 */
function potencialEstacional(tSuelo, sp) {
  if (tSuelo <= sp.tCrit) return 0;
  if (tSuelo < sp.tBase) {
    // Por debajo de la base pero sin helada: potencial bajo y creciente
    return clamp((tSuelo - sp.tCrit) / (sp.tBase - sp.tCrit), 0, 1) * 0.25;
  }
  if (tSuelo > sp.tMax) {
    // Estrés por calor: decae hasta 0 en +6 °C sobre el techo
    return clamp(1 - (tSuelo - sp.tMax) / 6, 0, 1) * 0.5;
  }
  // Dentro del rango activo
  const media = (sp.tBase + sp.tMax) / 2;
  const ancho = (sp.tMax - sp.tBase) / 2;
  const x = (tSuelo - media) / ancho;
  return clamp(1 - x * x * 0.55, 0, 1);
}

// ------------------------------------------------------------
// Acondicionamiento térmico: GDD
// ------------------------------------------------------------

/**
 * Estrés por helada, acumulado y con memoria.
 *
 * Devuelve un valor entre 0 y 1 y el multiplicador que le corresponde al
 * índice. No es un interruptor: una noche mala no borra el potencial, lo
 * reduce, y el potencial vuelve a subir conforme se aleja el episodio.
 *
 * DOS SEÑALES, porque no son lo mismo:
 *
 *   · el AIRE, por su mínima nocturna (historial[i].tmin). Es donde se
 *     congela de verdad, y es la señal principal.
 *   · el SUELO, por su temperatura a 18 cm. Va muy amortiguada, así que un
 *     suelo a 5 °C no es una helada física, pero sí es un estado profundo
 *     para una especie cuyo mínimo crítico está en +10 °C. Cuando el suelo
 *     además baja del mínimo crítico de la especie, se congeló el micelio y
 *     no solo el aire, y el daño pesa más.
 *
 * LA MEMORIA es lo que separa un episodio prolongado de uno aislado:
 *
 *   día -3 → -2 °C, día -2 → -3 °C, día -1 → +1 °C, hoy → +7 °C
 *   tres noches malas y un día bueno: el daño se acumula y pesa.
 *
 *   día -3 → +8 °C, día -2 → +7 °C, día -1 → -2 °C, hoy → +7 °C
 *   una sola noche mala y tres buenas: pesa mucho menos, y con el mismo
 *   desfase temporal.
 *
 * Cada noche aporta `severidad` grados de estrés y se pesa por
 * exp(-días / frostRecovery), así que lo que ocurrió hace tres noches cuenta
 * menos que lo de anoche. La suma se divide por HELADA_SATURA, los grados de
 * estrés que saturan la escala.
 *
 * HEURÍSTICO: la forma es razonable, los umbrales salen de la tolerancia al
 * frío documentada de cada especie. No hay ensayos de daño por helada que
 * den estos números.
 */
const HELADA_SATURA = 4;   // grados de estrés que saturan la escala

function frostStress(historial, sp, shift) {
  const tol = Number.isFinite(sp.frostTol) ? sp.frostTol : 0;
  const rec = Number.isFinite(sp.frostRecovery) && sp.frostRecovery > 0
    ? sp.frostRecovery : 4;
  const pesoSuelo = Number.isFinite(sp.frostSoil) ? Math.max(0, sp.frostSoil) : 1;

  // Un suelo por debajo de 0 °C cuenta siempre algo, aunque el aire medido no
  // llegara: las heladas de radiación en cielo claro congelan el suelo con
  // una temperatura de aire bastante más suave.
  const sueloBase = Number.isFinite(sp.tCrit) ? Math.min(0, sp.tCrit) : 0;

  let acum = 0;
  let peorMin = null;      // mínima de aire más baja del episodio
  let noches = 0;          // noches con helada por encima de la tolerancia
  let antiguedad = null;   // cuántas noches atrás fue la última
  let sueloHelado = false;

  const n = historial.length;
  // La ventana es un poco más larga que la constante de desvanecimiento: más
  // allá de tres constantes el peso es menor del 5 % y no compensa escanear.
  const ventana = Math.min(n, Math.ceil(rec * 3) + 2);

  for (let k = 0; k < ventana; k++) {
    const dia = historial[n - 1 - k];    // k = 0 es hoy
    if (!dia) continue;

    let severidad = 0;

    const tmin = dia.tmin;
    if (tmin != null && Number.isFinite(tmin)) {
      const porAire = Math.max(0, tol - tmin);
      if (porAire > 0) {
        severidad += porAire;
        noches++;
        if (antiguedad === null) antiguedad = k;
        if (peorMin === null || tmin < peorMin) peorMin = tmin;
      }
    }

    const suelo = dia.t;
    if (suelo != null && Number.isFinite(suelo)) {
      const s = suelo + shift;
      if (s <= sp.tCrit) {
        // El micelio estuvo por debajo del mínimo absoluto de la especie.
        severidad += pesoSuelo;
        sueloHelado = true;
        if (antiguedad === null) antiguedad = k;
      } else if (s <= sueloBase) {
        // Suelo congelado, pero dentro de lo que la especie aguanta.
        severidad += pesoSuelo * 0.4;
        sueloHelado = true;
        if (antiguedad === null) antiguedad = k;
      }
    }

    if (severidad > 0) acum += severidad * Math.exp(-k / rec);
  }

  const stress = clamp(acum / HELADA_SATURA, 0, 1);
  const pen = Number.isFinite(sp.frostPenalty)
    ? clamp(sp.frostPenalty, 0.05, 1) : 0.4;

  // Interpolación entre "sin daño" (1) y "peor caso" (frostPenalty).
  const mult = 1 - (1 - pen) * stress;

  return {
    stress, mult,
    peorMin, noches, antiguedad, sueloHelado,
    tol, pen, rec,
  };
}

/**
 * Suma de grados-día desde el último día con temperatura de suelo
 * por debajo de la base de la especie.
 */
function calcularGDD(historial, sp, shift) {
  let gdd = 0;
  let diasEnRango = 0;

  // historial va de más antiguo (índice 0) a hoy (índice final).
  //
  // El tope se comprueba al PRINCIPIO de cada vuelta, antes de acumular. Si
  // se comprobara al final, el día por encima de tMax no lo respetaría,
  // porque hace `continue`: un episodio largo de calor podría recorrer los
  // 30 días de histórico incrementando diasEnRango sin límite.
  //
  // topeAlcanzable dice si sp.diasMax cabe siquiera en el histórico que
  // tenemos. Con 30 días de pasado, las especies con diasMax de 45 a 60
  // (boleto, gula de monte, seta de cardo) nunca pueden topar, porque no hay
  // historial suficiente para llegar. Se expone para poder decirlo en voz
  // alta en vez de fingir que el parámetro se está aplicando.
  const tope = Math.min(sp.diasMax, historial.length);

  for (let i = historial.length - 1; i >= 0; i--) {
    // El día se comprueba ANTES de sumarle el desplazamiento: en JavaScript
    // null + 0 da 0, no NaN, así que un día sin número pasaría por si la
    // temperatura del suelo fuera de 0 °C. El chequeo tiene que ir antes.
    const bruto = historial[i].t;
    if (bruto == null || !Number.isFinite(bruto)) continue;
    const t = bruto + shift;
    // El suelo por debajo de la mínima absoluta cierra la temporada: es un
    // corte real, no un daño que se recupere. Lo que deja el frío del aire es
    // frostStress(), que se aplica al final como multiplicador del índice.
    if (t <= sp.tCrit) break;
    if (diasEnRango >= tope) break;   // ventana agotada
    if (t < sp.tBase) break;           // aún no arranca la temporada
    if (t > sp.tMax) { gdd += 2; diasEnRango++; continue; } // estrés cuenta poco
    gdd += (t - sp.tBase);
    diasEnRango++;
  }

  return {
    gdd, diasEnRango,
    tope,
    diasDisponibles: historial.length,
    topeAlcanzable: sp.diasMax <= historial.length,
  };
}

/** Fracción de Acondicionamiento alcanzada (0-1, con techo). */
function factorAcondicionamiento(gdd, sp) {
  return clamp(gdd / sp.gddNeed, 0, 1);
}

// ------------------------------------------------------------
// Factor hídrico
// ------------------------------------------------------------

const decaimiento = (d, L) => Math.exp(-d / L);

/** Hábitats boscosos. */
const MONTANA = new Set([
  'pinar', 'hayedo', 'robledal', 'castaneral', 'fresnedal', 'olmedal',
  'encinar', 'bosque_mixto', 'tronco', 'tocon', 'madera_muerta',
]);
/** Hábitats abiertos, herbáceos. */
const PRADENSE = new Set([
  'pradera', 'pastizal', 'cesped', 'claro', 'majadal', 'ganado',
  'borde_bosque', 'matorral',
]);

function lluviaEfectiva(lluvia30, sp) {
  let reff = 0;
  for (let d = 0; d < Math.ceil(sp.L); d++) {
    reff += (lluvia30[d] || 0) * decaimiento(d, sp.L);
  }
  return reff;
}

// ------------------------------------------------------------
// Hábitat
// ------------------------------------------------------------

/**
 * Compatibilidad de hábitat.
 *
 * Deliberadamente NO es un veto. La vegetación se infiere por heurística de
 * coordenadas, así que un 0 duro produciría "gírgola: requiere tronco" en
 * cualquier punto que no caiga en la tabla. En su lugar degrada:
 *
 *   1.00  la cobertura local coincide con un hábitat principal
 *   0.60  coincide con un hábitat secundario
 *   0.25  no coincide, pero la especie no está confinada
 *   0.05  especie muy confinada (pinar puro, ribera…) sin cobertura compatible
 *
 * Devuelve { factor, etiqueta, confuso }.
 */
function evaluarHabitat(sp, terreno) {
  const veg = terreno.vegetacion || [];

  // Núcleo urbano: factor 0, sin excepciones ni degradación.
  //
  // Es el único caso donde el hábitat anula en vez de penalizar, y a
  // propósito. Una seta micorrícica necesita un árbol con el quevivir; en
  // una calle no lo hay, y no es que las condiciones sean "menos buenas", es
  // que la seta no tiene dónde crecer. Degradar aquí —que es lo que hace el
  // resto de la función— dejaría a un boletus con 0.25 en la Plaza Mayor,
  // que es justo el falso positivo que motivó consultar el MFE.
  //
  // La detección viene de OpenStreetMap (densidad de edificios) en habitat.js,
  // y sólo se marca `urbano` si la fuente cartografió algo: un punto sin
  // datos en OSM no se da por urbano, porque en el campo OSM no tiene nada
  // y en un pueblo lo tiene todo.
  if (terreno.urbano) {
    return { factor: 0, etiqueta: 'entorno urbano', confuso: false };
  }

  if (!veg.length) return { factor: 0.7, etiqueta: 'sin datos de cobertura', confuso: true };

  // Los hábitats están ordenados por frecuencia: los primeros son los
  // principales para esa especie.
  const principal = sp.habitat.slice(0, 2);
  const hitPrincipal = veg.some(v => principal.includes(v));
  const hitSecundario = veg.some(v => sp.habitat.includes(v));

  let factor;
  if (hitPrincipal) factor = 1.0;
  else if (hitSecundario) factor = 0.6;
  else factor = sp.confinado ? 0.05 : 0.25;

  // Penalización genérica: los hábitats de monte favorecen al grupo leñoso
  // y estorban a los pratenses. Sin esto, "Seta de San Jorge" ganaba en un
  // hayedo de Galicia sólo porque su base térmica es baja.
  // Las saprofitas de raíces (seta de cardo) viven en pradera, no en bosque.
  //
  // OJO con `saprofita_humus`: también es saprofita, pero NO es pratense.
  // Descompone la hojarasca, o sea que vive EN el bosque, y meterla en este
  // grupo la penalizaría en el único sitio donde aparece. Por eso el criterio
  // es "de qué se alimenta", no "es saprofita o no".
  const esPratense = sp.guild === 'saprofita' || sp.guild === 'saprofita_raices';
  if (esPratense && veg.some(v => MONTANA.has(v))) {
    factor *= 0.45;
  }
  if (sp.guild === 'ectomicorricico' && veg.some(v => PRADENSE.has(v))) {
    factor *= 0.5;
  }

  // Exposición ycontinental seca del sur: el boleto no la coloniza.
  if (sp.avoidDrySW && terreno.exposicion === 'S' && terreno.umedad === 'seco') {
    factor *= 0.15;
  }

  // Los saprofitas lignícolas necesitan madera muerta; sin dato de sustrato
  // se penaliza en vez de anular.
  if (sp.substrate === 'madera' && terreno.hayMadera === false) {
    factor *= 0.15;
  }

  const etiqueta = hitPrincipal ? sp.habitat[0]
    : hitSecundario ? sp.habitat[2] || sp.habitat[0]
    : 'no corresponde';

  return { factor: clamp(factor, 0, 1), etiqueta, confuso: !hitSecundario };
}

/**
 * Factor de suelo por pH.
 *
 * Factor aparte, con recorrido propio entre 1,00 y su suelo. Va después del
 * factor de hábitat y no dentro de él: el pH es una variable continua del
 * suelo, no un condicionante de cobertura vegetal.
 *
 * HEURISTICO, pendiente de calibracion con observaciones reales: los tres
 * centros salen de la ecologia documentada de cada grupo, no de mediciones
 * de setas.
 *
 *   acidofilo    optimo 5,2   meseta +-1,5   suelo 0,60
 *   alcalinofila optimo 7,6   meseta +-1,4   suelo 0,60
 *   indiferente  optimo 6,8   meseta +-1,8   suelo 0,70
 *
 * El suelo nunca llega a 0: un pH equivocado penaliza, pero no anula a una
 * especie que ya tenga el resto de condiciones.
 */
function factorSuelo(pH, sp) {
  if (pH == null || !Number.isFinite(pH)) {
    return { factor: 1, etiqueta: '', conocido: false };
  }

  const perfil = sp.pHTolerante
    ? { opt: 5.6, meseta: 3.4, suelo: 0.85 }
    : sp.acidofilo
      ? { opt: 5.2, meseta: 1.5, suelo: 0.60 }
      : sp.alcalinofila
        ? { opt: 7.6, meseta: 1.4, suelo: 0.60 }
        : { opt: 6.8, meseta: 1.8, suelo: 0.70 };

  const d = Math.abs(pH - perfil.opt);
  // Meseta dentro del rango: 1.00. Fuera, decae 1 por cada 2,2 de pH.
  const bruto = d <= perfil.meseta ? 1 : 1 - (d - perfil.meseta) / 2.2;
  const factor = clamp(bruto, perfil.suelo, 1);

  const etiqueta = factor >= 0.999
    ? 'pH adecuado'
    : (sp.pHTolerante ? 'pH poco habitual'
      : sp.acidofilo ? 'suelo demasiado calizo'
        : sp.alcalinofila ? 'suelo demasiado ácido'
          : 'pH poco habitual');

  return { factor, etiqueta, conocido: true };
}

// ------------------------------------------------------------
// Índice principal
// ------------------------------------------------------------

/**
 * Calcula el potencial de fructificación para una especie.
 *
 * @param sp  objeto de SPECIES
 * @param ctx { historial, lluvia30, altitude, terreno }
 *           historial: [{ d, t, tmax, hr }] ordenado de más antiguo a hoy
 * @returns  { I, S, H, A, G, reff, viable, motivo }
 */
function indice(sp, ctx) {
  /* Especie inválida: se comprueba antes de calcular nada, para que un objeto
   * sin parámetros térmicos válidos devuelva un 0 controlado en vez de un
   * NaN que se llevaría el índice entero. En la práctica no ocurre: indice()
   * solo se llama con especies de SPECIES. */
  const clavesTermicas = ['tBase', 'tOpt', 'tMax', 'tCrit', 'gddNeed', 'L', 'Ro'];
  const faltan = clavesTermicas.filter(k => !Number.isFinite(sp?.[k]));
  if (faltan.length) {
    return {
      I: 0, S: 0, H: 0, A: 0, T: 0, G: 0, reff: 0,
      viable: false,
      motivo: `Especie con parametros incompletos: ${faltan.join(', ') || 'no reconocida'}`,
      detalle: { gdd: 0, diasEnRango: 0 },
    };
  }
  if (!Array.isArray(sp.habitat)) sp = { ...sp, habitat: [] };
  if (!Array.isArray(sp.temporada)) sp = { ...sp, temporada: [] };

  const shift = tShift(ctx.altitude);

  // Temperatura del suelo actual (con desplazamiento por altitud)
  const tSuelo = ctx.tSuelo + shift;

  // 1. Estacionalidad (depende del suelo, no del calendario)
  const S = potencialEstacional(tSuelo, sp);

  // 2. Acondicionamiento térmico (GDD desde el arranque de temporada)
  const g = calcularGDD(ctx.historial, sp, shift);
  const { gdd, diasEnRango } = g;
  const A = factorAcondicionamiento(gdd, sp);

  // 3. Factor hídrico
  const reff = lluviaEfectiva(ctx.lluvia30, sp);
  const H = clamp(reff / sp.Ro, 0, 1);

  // 4. Hábitat (degradado, no veto)
  const hab = evaluarHabitat(sp, ctx.terreno);

  // 4b. Suelo por pH, como factor aparte
  const sueloF = factorSuelo(ctx.terreno?.ph, sp);

  // 5. Altitud, con la banda de esta especie
  const alt = altitudeFactor(ctx.altitude, sp);

  // 6. Temporada documentada (peso, no veto)
  const T = factorTemporada(sp, ctx.mes);

  // 7. Estrés por helada, con memoria. Multiplicador: reduce el potencial y
  // el potencial vuelve conforme el episodio se aleja.
  const hel = frostStress(ctx.historial, sp, shift);

  // Índice compuesto. Ojo: son ocho factores multiplicativos y H va con
  // exponente 0,5 a propósito (ver Metodología: un suelo saturado no sigue
  // admitiendo más agua).
  const I = 100 * S * Math.pow(H, 0.5) * A * hab.factor * sueloF.factor * alt * T * hel.mult;

  return {
    I: clamp(I, 0, 100),
    S, H, A, T, G: gdd, reff,
    viable: true,
    motivo: null,
    detalle: {
      gdd, diasEnRango,
      habFactor: hab.factor,
      habEtiqueta: hab.etiqueta,
      habConfuso: hab.confuso,
      sueloFactor: sueloF.factor,
      sueloEtiqueta: sueloF.etiqueta,
      sueloConocido: sueloF.conocido,
      gddTope: g.tope,
      gddTopeAlcanzable: g.topeAlcanzable,
      gddDiasDisponibles: g.diasDisponibles,
      alt,
      altBanda: altitudEtiqueta(sp),
      altEvidencia: sp.altEvidencia || 'indicado',
      heladaFactor: hel.mult,
      heladaEstres: hel.stress,
      heladaMinima: hel.peorMin,
      heladaNoches: hel.noches,
      heladaAntiguedad: hel.antiguedad,
      heladaSuelo: hel.sueloHelado,
      heladaTolerancia: hel.tol,
    },
  };
}

/** Ranking completo, de mayor a menor índice. */
function ranking(ctx) {
  return SPECIES
    .map(sp => ({ sp, ...indice(sp, ctx) }))
    .sort((a, b) => b.I - a.I);
}

/**
 * Las mismas especies ordenadas por el criterio de interés del usuario, no
 * por puntuación. Cada ficha lleva `prioridad`: el boleto, el níscalo y el
 * rebozuelo van primero, después el resto de boletos, y el resto detrás.
 *
 * Se usa para pintar las tarjetas del dashboard y la lista de la pestaña
 * Especies. La tabla de Análisis sigue ordenada por índice, porque ahí lo
 * que interesa es la puntuación.
 */
function porPrioridad(entradas) {
  return [...entradas].sort((a, b) => {
    const pa = a.sp?.prioridad ?? a.prioridad ?? 999;
    const pb = b.sp?.prioridad ?? b.prioridad ?? 999;
    if (pa !== pb) return pa - pb;
    return (b.I ?? 0) - (a.I ?? 0);
  });
}

// ------------------------------------------------------------
// Obtención de datos
// ------------------------------------------------------------

/**
 * Meteorología histórica + reciente de Open-Meteo.
 * past_days=30 da días REALES (no previsión) para el histórico.
 */
async function meteo(lat, lon, days = 30) {
  const url = `${API.openMeteo}`
    + `?latitude=${lat}&longitude=${lon}`
    + `&past_days=${days}&forecast_days=1`
    + '&daily=precipitation_sum,temperature_2m_mean,temperature_2m_min,'
    + 'temperature_2m_max,relative_humidity_2m_mean'
    + '&hourly=soil_temperature_18cm,soil_temperature_6cm,soil_moisture_3_9cm'
    + '&timezone=auto';

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j = await r.json();
  const d = j.daily;
  const n = d.time.length;

  const media = a => a.reduce((x, y) => x + (y ?? 0), 0) / a.length;
  const ult = (k, c) => d[k].slice(n - c);

  // Temperatura de SUELO a 18 cm: la profundidad que usa el modelo de suelo de
  // Open-Meteo y la más próxima a la zona de micorriza fúngica. Se recurre a
  // 6 cm y, en último término, a la del aire.
  const soilT = j.hourly?.soil_temperature_18cm
    || j.hourly?.soil_temperature_6cm
    || d.temperature_2m_mean;
  const profundidadSuelo = j.hourly?.soil_temperature_18cm ? 18
    : j.hourly?.soil_temperature_6cm ? 6 : 0;

  // Un valor diario de suelo: media de las 24 horas del día.
  // `soilT` es un array POR HORAS alineado con el eje temporal local, así que
  // el día i ocupa las posiciones i*24 … i*24+23. Los últimos días pueden venir
  // incompletos (hoy no ha terminado), y hay que usar los valores que haya,
  // no un día entero de ceros.
  const sueloDiario = [];
  for (let i = 0; i < n; i++) {
    const slice = soilT.slice(i * 24, i * 24 + 24).filter(v => v != null);
    const aire = d.temperature_2m_mean[i];
    sueloDiario.push(slice.length ? media(slice) : (aire ?? 0));
  }

  // Historial ordenado de más antiguo a hoy
  const historial = [];
  for (let i = 0; i < n; i++) {
    historial.push({
      d: n - 1 - i,
      t: sueloDiario[i],
      tmax: d.temperature_2m_max[i],
      tmin: d.temperature_2m_min[i],
      hr: d.relative_humidity_2m_mean[i],
    });
  }

  // Lluvia: índice 0 = hoy, 1 = ayer, 2 = anteayer… hasta n-1 hace 30 días.
  // Se invierte el array diario para que el decaimiento exponencial de
  // lluviaEfectiva() pueda recorrerlo hacia atrás con d = 0, 1, 2…
  const lluvia30 = Array.from({ length: n }, (_, i) => d.precipitation_sum[n - 1 - i] || 0);

  const idxHoy = n - 1;
  const fin = v => (v == null ? null : v);

  return {
    dia: diaDelAnio(new Date(d.time[idxHoy] + 'T00:00:00')),
    mes: new Date(d.time[idxHoy] + 'T00:00:00').getMonth() + 1,
    lat,
    lon,
    historial,
    lluvia30,
    tSuelo: sueloDiario[idxHoy],
    tSuelo0: sueloDiario[0],
    profundidadSuelo,
    tAire: fin(d.temperature_2m_mean[idxHoy]),
    tMin7: Math.min(...ult('temperature_2m_min', 7)),
    hr7: media(ult('relative_humidity_2m_mean', 7)),
    altitud: Math.round(j.elevation ?? 0),
    fechaIso: d.time[idxHoy],
  };
}

/**
 * Suelo real de SoilGrids (ISRIC).
 *
 * Notas sobre el servicio, aprendidas a base de 500:
 *  - El endpoint correcto es /soilgrids/v2.0/properties/query y el parámetro
 *    se llama `property` (no `layer`), el valor se llama `value` (no
 *    `column-type`) y el pH es `phh2o` (no `ph`).
 *  - Los únicos horizontes válidos son los de GlobalSoilMap:
 *    0-5, 0-30, 5-15, 15-30, 30-60, 60-100, 100-200 cm. Pedir 0-20cm
 *    devuelve una lista de capas VACÍA y parece un fallo de red.
 *  - Pedir varias propiedades en una llamada devuelve HTTP 500. Hay que
 *    pedir una por una.
 *  - Política de uso: 5 llamadas por minuto. Por eso todo se cachea en
 *    localStorage con la rejilla de 250 m de SoilGrids (~0.0025°) y no se
 *    repregunta lo que ya se sabe.
 */
const SG_URL = 'https://rest.isric.org/soilgrids/v2.0/properties/query';
const SG_CACHE_KEY = 'micohunter_soil_cache';
const SG_DAYS = 180 * 24 * 3600 * 1000;

/** Clave de caché redondeada a la rejilla de 250 m (~0.0025°). */
const sgKey = (prop, lat, lon) =>
  `${prop}@${lat.toFixed(3)},${lon.toFixed(3)}`;

function sgCacheLeer() {
  try { return JSON.parse(localStorage.getItem(SG_CACHE_KEY)) || {}; }
  catch { return {}; }
}

function sgCacheEscribir(k, v) {
  const c = sgCacheLeer();
  c[k] = { v, t: Date.now() };
  const claves = Object.keys(c);
  if (claves.length > 400) {
    // Poda por antigüedad: SoilGrids cambia muy despacio.
    claves
      .sort((a, b) => c[a].t - c[b].t)
      .slice(0, claves.length - 300)
      .forEach(x => delete c[x]);
  }
  try { localStorage.setItem(SG_CACHE_KEY, JSON.stringify(c)); } catch { /* lleno */ }
}

async function sgPropiedad(prop, lat, lon, profundidad) {
  const k = sgKey(`${prop}@${profundidad}`, lat, lon);
  const cache = sgCacheLeer();
  const hit = cache[k];
  if (hit && Date.now() - hit.t < SG_DAYS) return hit.v;

  const url = `${SG_URL}?property=${prop}&depth=${profundidad}`
    + `&value=mean&lon=${lon}&lat=${lat}`;

  // Tope por petición. Se ha visto a ISRIC dejar una consulta colgada: la de
  // arcilla llegó a tardar 55 s mientras las otras tres respondían en menos de
  // uno. Como las cuatro van en paralelo y el conjunto espera a la más lenta,
  // una sola consulta colgada bloqueaba la ficha de suelo entera durante un
  // minuto. Con el tope, se pierde ese dato y se conserva el resto.
  const TOPE_MS = 15000;

  let ultimoError;
  for (let intento = 0; intento < 2; intento++) {
    if (intento) await new Promise(r => setTimeout(r, 900));

    let r;
    try {
      r = await sgConTope(url, TOPE_MS);
    } catch (e) {
      ultimoError = e.name === 'TimeoutError' ? 'sin respuesta' : `red: ${e.message}`;
      continue;
    }

    if (r.status === 429) { ultimoError = 'límite 5/min'; continue; }
    if (!r.ok) throw new Error(`SoilGrids ${prop} ${r.status}`);

    const texto = await r.text();
    if (!texto.trim().startsWith('{')) throw new Error(`SoilGrids ${prop}: no JSON`);

    const j = JSON.parse(texto);
    const capa = j?.properties?.layers?.find(l => l.name === prop);
    const bruto = capa?.depths?.find(d => d.label === profundidad)?.values?.mean;
    if (bruto == null) {
      // 200 con lista de capas vacía: este horizonte no está disponible.
      throw new Error(`SoilGrids ${prop}@${profundidad}: vacío`);
    }

    // SoilGrids devuelve el valor "mapeado" en una escala entera; el factor
    // de la propia respuesta lo lleva a unidades convencionales. Sin esto,
    // un pH de 7.6 llega como 76 y un 49 % de arena como 495.
    const factor = capa.unit_measure?.d_factor ?? 1;
    const valor = bruto / factor;

    sgCacheEscribir(k, valor);
    return valor;
  }
  throw new Error(`SoilGrids ${prop}: ${ultimoError}`);
}

/** fetch con tiempo máximo, con cancelación real de la petición. */
function sgConTope(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

/**
 * Textura, pH y carbono orgánico del suelo.
 *
 * Nunca lanza. Cada propiedad va por separado y con su propio tiempo máximo,
 * así que un fallo o un cuelgue de una no impide mostrar las otras: el pH es
 * el que más pesa en el modelo (ajusta el factor de hábitat), y no tiene
 * sentido perderlo porque la consulta de arcilla se quedara colgada.
 *
 * `ok` significa "ha llegado algo utilizable", no "han llegado las cuatro".
 */
async function suelo(lat, lon) {
  const out = {
    textura: null, ph: null, phGrupo: null,
    arena: null, arcilla: null, limo: null, costero: null,
    parcial: false,
    ok: false, error: null,
  };

  try {
    // Un solo horizonte, 5-15 cm: la franja donde está la micorriza y la
    // que corresponde a la profundidad del suelo que usa el modelo de
    // Open-Meteo. Son 4 llamadas, dentro del límite de 5/min de ISRIC.
    // Pedir dos horizontes o varias propiedades en una llamada devuelve
    // 200 con la lista de capas vacía, o HTTP 500.
    const P = '5-15cm';
    // Se lanzan escalonadas y no a la vez. Cuatro peticiones simultáneas a un
    // servicio que se autolimita a 5 por minuto garantizan que alguna se
    // quede esperando: medido con las cuatro en paralelo, la arena agotaba
    // los 12 s dos veces seguidas mientras la arcilla tardaba 5 s.
    // Con 300 ms de separación todas caben holgadamente.
    const espera = ms => new Promise(r => setTimeout(r, ms));
    const pedir = (prop, retardo) => espera(retardo)
      .then(() => sgPropiedad(prop, lat, lon, P))
      .catch(() => null);

    const [arena, arcilla, ph, costero] = await Promise.all([
      pedir('sand', 0),      // el más importante: sin él no hay textura
      pedir('clay', 300),    // el más lento en la práctica
      pedir('phh2o', 600),   // el que más pesa en el modelo
      pedir('soc', 900),
    ]);

    out.arena = arena;
    out.arcilla = arcilla;
    out.ph = ph;
    out.costero = costero;
    out.limo = (arena != null && arcilla != null) ? Math.max(0, 100 - arena - arcilla) : null;

    // Textura: triángulo textural de USDA simplificado.
    if (arena != null && arcilla != null) {
      if (arcilla >= 35) out.textura = 'arcilloso';
      else if (arena >= 70) out.textura = 'arenoso';
      else if (arena >= 45 && arcilla < 20) out.textura = 'franco-arenoso';
      else if (arcilla >= 18) out.textura = 'franco-arcilloso';
      else out.textura = 'franco';
    } else if (arena != null) {
      // Sin arcilla no se puede usar el triángulo, pero el contenido en
      // arena por sí solo ya acota bastante la clase.
      out.textura = arena >= 70 ? 'arenoso' : arena >= 55 ? 'franco-arenoso' : 'franco';
    }

    if (ph != null) {
      if (ph < 5.5) out.phGrupo = 'acido';
      else if (ph < 7.0) out.phGrupo = 'subacido';
      else if (ph < 7.8) out.phGrupo = 'neutro';
      else out.phGrupo = 'calizo';
    }

    out.parcial = (arena == null || arcilla == null);
    out.ok = out.textura != null || out.ph != null;
    if (out.parcial) out.error = 'SoilGrids no devolvió todas las propiedades';
    return out;
  } catch (e) {
    out.error = e.message;
    return out;
  }
}

function diaDelAnio(date = new Date()) {
  const ini = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - ini) / 864e5);
}

/** Geocodificación: nombre de lugar → coordenadas. */
async function buscarLugar(nombre) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=6&language=es&name='
    + encodeURIComponent(nombre);
  const j = await (await fetch(url)).json();
  return j.results || [];
}

// ------------------------------------------------------------
// Etiquetas para la interfaz
// ------------------------------------------------------------

const FACTOR_LABELS = {
  S: { nombre: 'Estacional', icono: '🌡️' },
  H: { nombre: 'Reserva de humedad del suelo', icono: '🌧️' },
  A: { nombre: 'Acumulación', icono: '🔥' },
  T: { nombre: 'Temporada', icono: '📅' },
};

const GUILD_LABELS = {
  ectomicorricico: 'Ectomicorrícico',
  saprofita: 'Saprofita',
  saprofita_lignum: 'Saprofita de madera',
  saprofita_raices: 'Saprofita de raíces',
  saprofita_humus: 'Saprofita de hojarasca',
};

/** Texto de temporada de una especie, para la interfaz. */
function temporadaTexto(sp) {
  if (!sp.temporada || !sp.temporada.length) return 'no documentada';
  return sp.temporadaTxt || sp.temporada.join(', ');
}

/** Etiqueta de la procedencia de los parámetros de una especie. */
const EVIDENCIA_LABELS = {
  publicado: 'Parámetros publicados',
  derivado: 'Parámetros derivados de la temporada documentada',
  estimado: 'Parámetros estimados',
};

function nivelTexto(I) {
  if (I >= 70) return { texto: 'Muy favorable', clase: 'nivel-alto' };
  if (I >= 45) return { texto: 'Favorable', clase: 'nivel-medio' };
  if (I >= 22) return { texto: 'Posible', clase: 'nivel-bajo' };
  return { texto: 'Desfavorable', clase: 'nivel-nulo' };
}
/* ---------------------------------------------------------------------
 * Exportación para los tests en Node.
 *
 * En el navegador este fichero se carga como script clásico y `module` no
 * existe, así que este bloque no hace nada. En Node permite
 * `require("./algoritmo.js")` sin usar un truco de vm.
 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SPECIES, LAUX, CRUCE, fuenteLaux, fuenteCruce, indice, ranking, porPrioridad, potencialEstacional,
    calcularGDD, factorAcondicionamiento, lluviaEfectiva, evaluarHabitat,
    factorSuelo, factorTemporada, altitudeFactor, altitudeFactorGlobal,
    altitudEtiqueta, frostStress, diaDelAnio,
    FACTOR_LABELS, EVIDENCIA_LABELS, GUILD_LABELS, nivelTexto,
  };
}
