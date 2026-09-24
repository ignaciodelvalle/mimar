// El diccionario de especies — la ÚNICA fuente de cómo se escribe una especie
// en es-AR.
//
// Separado de lib/utils/format.ts el 2026-08-09, cuando ese módulo volvió a
// cruzar el límite de 1500 líneas del fence de tamaño. Es el mismo corte que ya
// se le hizo a los helpers de fecha (./date-input-ar, 2026-08-06): cuando un
// módulo no entra, se parte por familias, no se sube el límite.
//
// format.ts RE-EXPORTA las tres funciones, así que los 76 archivos que ya las
// importaban de ahí siguen funcionando sin tocarse.
//
// POR QUÉ EXISTE ESTE ARCHIVO Y NO CADA PANTALLA SU MAPA. El costo de la
// alternativa está medido dos veces: el 2026-07-08 la QA encontró un mapa local
// dog/cat en /mis-mascotas y en el tablero de la organización, y el 2026-08-08
// una revisión adversa encontró cuatro más — dos duplicados dentro de un mismo
// archivo, y uno que era un ternario que renderizaba TODA especie no-perro como
// "Gatos". El 2026-08-09 apareció el peor: un mapa que cubría sólo perro y gato
// con `?? pet.species` de fallback, así que la pantalla del inspector de
// maltrato mostraba el enum crudo para conejo, cobayo, hurón y "otra".
//
// Guardado por __tests__/species-label-single-source.test.ts, cuyo baseline
// quedó VACÍO el 2026-08-09.

export function speciesLabel(species: string): string {
  switch (species) {
    case "dog":
      return "Perro";
    case "cat":
      return "Gato";
    case "rabbit":
      return "Conejo";
    case "guinea_pig":
      return "Cobayo";
    case "ferret":
      return "Hurón";
    case "other":
      return "Otra";
    default:
      return species;
  }
}

// Contrapartida plural, para superficies que nombran un CONJUNTO de especies en
// vez de un animal: filtros ("Perros", "Gatos") y las filas de elegibilidad de
// un servicio ("Especies: Perros, Gatos").
export function speciesLabelPlural(species: string): string {
  switch (species) {
    case "dog":
      return "Perros";
    case "cat":
      return "Gatos";
    case "rabbit":
      return "Conejos";
    case "guinea_pig":
      return "Cobayos";
    case "ferret":
      return "Hurones";
    case "other":
      return "Otras";
    default:
      return species;
  }
}

/**
 * `{ value, label }` para un selector de especie, con la etiqueta tomada de
 * `speciesLabel`.
 *
 * QUÉ resuelve, y qué NO. El conjunto de VALORES es una decisión de producto por
 * pantalla —/gob/perdidas filtra dog/cat/other, el alta ofrece más— y por eso lo
 * elige quien llama. Lo que no era una decisión por pantalla es la ORTOGRAFÍA, y
 * once archivos la reescribían a mano.
 *
 * Decisión del PO (2026-08-09): "Perro" y "Cobayo" a secas. El desdoblamiento
 * "Perro/a" en un selector de ESPECIE es un error de categoría —ahí no se habla
 * de personas, y el sexo del animal tiene su propio campo— y "Cobayo" es el
 * término de SENASA. `speciesLabel` ya escribía ambos así; lo que faltaba era
 * que las pantallas lo usaran.
 */
export function speciesOptions(values: readonly string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: speciesLabel(value) }));
}

/**
 * La especie EN MEDIO DE UNA FRASE, en minúscula: "Ya tenés un perro, sexo sin
 * especificar…".
 *
 * Existe porque había un TERCER mapa —en minúsculas, para prosa— dentro de
 * MinimalNewPetForm, y el fence no lo veía: sus etiquetas están capitalizadas y
 * las regex eran sensibles a mayúsculas. El baseline llegó a quedar en cero
 * mientras ese mapa seguía vivo. (El fence ahora es insensible; esta función es
 * el lugar donde va la respuesta.)
 *
 * `other` es la única excepción real: "otra" a secas no cierra la frase, así que
 * la prosa dice "otra especie". El resto es la etiqueta canónica en minúscula —
 * una sola decisión de ortografía, dos registros.
 */
export function speciesInProse(species: string): string {
  return species === "other" ? "otra especie" : speciesLabel(species).toLowerCase();
}
