# Diccionario de datos — Datos abiertos de MiMAR

Este documento describe cada conjunto de datos abiertos que publica MiMAR bajo la
Ley 27.275 de acceso a la información pública (transparencia activa). Todos los
datos son **agregados por provincia**: nunca se publica información de una mascota
individual, ni datos personales, ni ubicaciones exactas.

- **Formato**: CSV (UTF-8, RFC 4180) y JSON, vía `?format=csv` o `?format=json`.
- **Endpoint**: `/transparencia/datos/{dataset}?format=csv`
- **Unidad geográfica**: provincia (24 jurisdicciones, incluida CABA).
- **Umbral de privacidad (k)**: 5. Ver la regla de supresión de cada conjunto.
- **Marcador de celda suprimida**: `suprimido por privacidad` (nunca 0).

Cada descarga incluye un encabezado de metadatos (licencia, fecha de generación,
URL de metodología, regla de supresión) en las cabeceras HTTP y, en JSON, dentro
del objeto `meta`.

---

## Regla de supresión (común)

Una celda numérica se reemplaza por `suprimido por privacidad` cuando publicar su
valor podría exponer a un grupo pequeño de individuos:

- **Conjuntos de tasa** (antirrábica, esterilización, microchip, PPP): se suprime
  la fila cuando la **población base** de la provincia es menor a 5, o cuando el
  **grupo cubierto** (numerador) o el **grupo no cubierto** (base − numerador)
  tiene entre 1 y 4 individuos.
- **Conjunto de conteo** (mortalidad): se suprime cuando el conteo de la provincia
  es menor a 5.
- **Supresión complementaria (a nivel nacional)**: si, tras la supresión primaria,
  queda **exactamente una** provincia suprimida en todo el país, se suprime también
  la siguiente provincia más chica. Así, un valor oculto nunca se puede reconstruir
  restando las provincias visibles de un total nacional.

El numerador crudo (por ejemplo, "cantidad de perros vacunados") **no se publica**;
sólo se publica la población base y el porcentaje. En las filas visibles, ambos son
grupos de tamaño ≥ 5, por lo que reconstruir el numerador a partir de
`base × porcentaje` sólo arroja un valor seguro (≥ 5), nunca uno individualizable.

---

## Conjuntos de datos

### 1. `cobertura-antirrabica` — Cobertura de vacunación antirrábica

Porcentaje de perros con vacuna antirrábica vigente por provincia.

| Columna | Tipo | Unidad | Descripción |
|---|---|---|---|
| `provincia` | texto | — | Nombre de la provincia (o CABA). |
| `codigo_iso` | texto | — | Código ISO 3166-2:AR (por ejemplo `AR-B`, `AR-C`). |
| `perros_registrados` | entero | perros | Población base: perros registrados en la provincia. |
| `cobertura_antirrabica_pct` | decimal | % (0-100) | Porcentaje de esos perros con vacuna antirrábica vigente. |

- **Cadencia**: actualización diaria. Vigencia según la fecha de próximo refuerzo de la dosis; sin esa fecha, se usa una ventana móvil de 12 meses.
- **Supresión**: regla de conjuntos de tasa (ver arriba).

### 2. `cobertura-esterilizacion` — Cobertura de esterilización

Porcentaje de mascotas activas con al menos una esterilización registrada, por
provincia.

| Columna | Tipo | Unidad | Descripción |
|---|---|---|---|
| `provincia` | texto | — | Nombre de la provincia (o CABA). |
| `codigo_iso` | texto | — | Código ISO 3166-2:AR. |
| `mascotas_activas` | entero | mascotas | Población base: mascotas activas en la provincia. |
| `cobertura_esterilizacion_pct` | decimal | % (0-100) | Porcentaje de esas mascotas con al menos una esterilización registrada. |

- **Cadencia**: instantánea, acumulado histórico; actualización diaria.
- **Supresión**: regla de conjuntos de tasa.

### 3. `cobertura-microchip` — Cobertura de microchip

Porcentaje de mascotas activas con microchip ISO activo, por provincia.

| Columna | Tipo | Unidad | Descripción |
|---|---|---|---|
| `provincia` | texto | — | Nombre de la provincia (o CABA). |
| `codigo_iso` | texto | — | Código ISO 3166-2:AR. |
| `mascotas_activas` | entero | mascotas | Población base: mascotas activas en la provincia. |
| `cobertura_microchip_pct` | decimal | % (0-100) | Porcentaje de esas mascotas con un microchip ISO activo. |

- **Cadencia**: instantánea, acumulado histórico; actualización diaria.
- **Supresión**: regla de conjuntos de tasa.

### 4. `cumplimiento-ppp` — Cumplimiento de registro de perros potencialmente peligrosos

Porcentaje de perros marcados como potencialmente peligrosos (PPP) con la
declaración de raza registrada, por provincia.

| Columna | Tipo | Unidad | Descripción |
|---|---|---|---|
| `provincia` | texto | — | Nombre de la provincia (o CABA). |
| `codigo_iso` | texto | — | Código ISO 3166-2:AR. |
| `perros_ppp` | entero | perros | Población base: perros marcados como potencialmente peligrosos. |
| `cumplimiento_ppp_pct` | decimal | % (0-100) | Porcentaje de esos perros con la declaración de raza registrada. |

- **Cadencia**: instantánea, acumulado histórico; actualización diaria.
- **Supresión**: regla de conjuntos de tasa.

### 5. `mortalidad` — Fallecimientos registrados

Cantidad de mascotas registradas actualmente como fallecidas, por provincia.

| Columna | Tipo | Unidad | Descripción |
|---|---|---|---|
| `provincia` | texto | — | Nombre de la provincia (o CABA). |
| `codigo_iso` | texto | — | Código ISO 3166-2:AR. |
| `fallecimientos_registrados` | entero | mascotas | Mascotas de la provincia registradas actualmente como fallecidas. |

- **Cadencia**: instantánea, acumulado histórico; actualización diaria.
- **Supresión**: regla de conjuntos de conteo (se suprime si el conteo es menor a 5).

---

## Licencia

Los conjuntos de datos se publican bajo **Creative Commons Atribución 4.0
Internacional (CC BY 4.0)**.

- Texto legal: <https://creativecommons.org/licenses/by/4.0/deed.es>
- **Atribución requerida**: *MiMAR — Sistema de credencial digital de mascotas
  (Argentina). datos.mimar.gob.ar*

Podés copiar, redistribuir, adaptar y usar los datos con cualquier fin, incluso
comercial, siempre que cites la fuente con la atribución indicada.
