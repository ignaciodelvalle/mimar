# Metodología — Datos abiertos de MiMAR

Esta página explica, en lenguaje simple, **qué datos publica MiMAR**, **cómo se
calculan** y, sobre todo, **cómo protegemos la privacidad de las personas y de
sus mascotas**. La publicamos como parte de la **transparencia activa** que exige
la **Ley 27.275** de acceso a la información pública: el Estado debe poner a
disposición, de manera abierta y reutilizable, la información de interés público
que produce.

## Qué se cuenta

MiMAR es el sistema de credencial digital de mascotas de la Argentina. A medida
que veterinarias, municipios y personas registran mascotas y eventos (vacunas,
esterilizaciones, microchips, fallecimientos), el sistema puede calcular
indicadores de salud y bienestar animal a nivel de cada provincia.

Publicamos cinco conjuntos de datos, todos **agregados por provincia**:

1. **Cobertura de vacunación antirrábica** — qué porcentaje de los perros
   registrados tiene la vacuna antirrábica vigente.
2. **Cobertura de esterilización** — qué porcentaje de las mascotas activas tiene
   al menos una esterilización registrada.
3. **Cobertura de microchip** — qué porcentaje de las mascotas activas tiene un
   microchip ISO activo.
4. **Cumplimiento de registro PPP** — de los perros marcados como potencialmente
   peligrosos, qué porcentaje tiene la declaración de raza registrada.
5. **Fallecimientos registrados** — cuántas mascotas figuran actualmente como
   fallecidas.

Cada indicador se calcula con **exactamente la misma definición** que usan los
tableros internos del Estado, para que las cifras públicas nunca difieran de las
que ve un funcionario.

## Qué NO se publica nunca

- **Datos personales** de las personas dueñas (nombre, contacto, DNI). El DNI
  jamás se almacena ni se publica en texto plano.
- **Datos de una mascota individual**: ninguna fila representa a una mascota. Cada
  fila es un total provincial.
- **Tokens públicos** ni identificadores que permitan llegar a la credencial de
  una mascota.
- **Ubicaciones exactas** ni datos a nivel de localidad o barrio en estos
  conjuntos. La unidad geográfica publicada es la provincia.

## Cómo protegemos la privacidad: k-anonimato (k = 5)

Aun publicando sólo totales, un total muy chico puede señalar a una persona. Si
una provincia tuviera, por ejemplo, sólo 3 mascotas registradas, publicar una
cifra sobre "esas 3 mascotas" se acercaría demasiado a hablar de individuos
concretos.

Para evitarlo aplicamos **k-anonimato con k = 5**: **ninguna cifra publicada puede
describir a un grupo de menos de 5 individuos.** Cuando un grupo es más chico que
5, esa celda no muestra el número: muestra el texto **`suprimido por privacidad`**
(nunca un 0, porque un 0 falso también sería información).

En los conjuntos de **tasa** (antirrábica, esterilización, microchip, PPP) hay
tres formas en que un grupo chico podría quedar expuesto, y cualquiera de ellas
activa la supresión:

- La **población base** de la provincia es menor a 5.
- El **grupo cubierto** (por ejemplo, "mascotas vacunadas") tiene entre 1 y 4.
- El **grupo no cubierto** (por ejemplo, "mascotas sin vacunar") tiene entre 1 y 4.

En el conjunto de **conteo** (mortalidad) se suprime cuando el total de la
provincia es menor a 5.

Además **no publicamos el numerador crudo** (por ejemplo, la cantidad exacta de
perros vacunados); publicamos la población base y el porcentaje. En las filas que
sí se muestran, ambos grupos tienen 5 o más individuos, así que ni siquiera
recalculando `base × porcentaje` se llega a un número que individualice a alguien.

### Por qué un 0 se publica en las tasas pero un conteo chico no

El criterio para el número **cero** es deliberadamente distinto según el tipo de
conjunto, porque un cero significa cosas distintas en cada uno:

- En los conjuntos de **tasa** (antirrábica, esterilización, microchip, PPP), un
  **numerador de 0** —por ejemplo, "0 de 8.000 perros con la declaración registrada"—
  **se publica**. Un cero acá dice "ninguna mascota de este grupo tiene el evento":
  no describe a ningún individuo, no reidentifica a nadie, y "todavía no hay ni un
  caso" es información pública valiosa (mide una brecha real de cobertura). Lo que sí
  se suprime es un numerador **chico pero positivo** (entre 1 y 4), porque ahí sí hay
  un puñado de personas concretas detrás del número. La base y el complemento siguen
  la misma regla: 0 no protege, 1–4 sí.
- En el conjunto de **conteo** (mortalidad) se suprime cuando el total de la provincia
  es **menor a 5**, incluidos los conteos chicos positivos. Acá el número publicado ES
  el tamaño del grupo sensible (mascotas fallecidas), así que un conteo de 1 a 4
  señalaría directamente a esas pocas mascotas. Un 0 —"ninguna mascota figura
  fallecida"— tampoco individualiza a nadie; la diferencia de fondo es que en un
  conteo el número publicado es el grupo en sí, mientras que en una tasa el número
  publicado es la base (≥ 5) y el porcentaje, no el grupo chico.

En resumen: publicar un 0 nunca reidentifica a nadie, así que un 0 se muestra; lo que
se oculta es siempre un grupo de **entre 1 y 4** individuos concretos.

## Supresión complementaria: el ataque por diferencia

Hay un riesgo más sutil. Supongamos que se conoce (o se publica en otra fuente) un
**total nacional**, y que todas las provincias están visibles salvo una, que fue
suprimida por ser chica. Entonces ese valor oculto se podría **reconstruir por
resta**: total nacional − suma de las provincias visibles.

Para cerrar esa puerta aplicamos **supresión complementaria a nivel nacional**: si,
después de la supresión primaria, queda **exactamente una** provincia suprimida en
todo el país, suprimimos también la **siguiente provincia más chica**. Así nunca
queda un único valor oculto aislable; siempre hay al menos dos, y de un total sólo
se puede despejar su suma, no cada uno por separado.

## Supresión conjunta de la base compartida

Algunos conjuntos publican **la misma columna de población base** calculada del
**mismo denominador**. Hoy es el caso de `mascotas_activas`, que aparece tanto en
**cobertura de esterilización** como en **cobertura de microchip**: en ambos, la base
es la cantidad de mascotas activas de la provincia.

Si cada conjunto decidiera su supresión por separado, aparecería una grieta: una
provincia podría quedar **suprimida en un archivo** (porque, por ejemplo, su grupo
cubierto de microchip es chico) pero **visible en el otro** (porque su cobertura de
esterilización no tiene ningún grupo chico). Como la base es la misma, alcanzaría con
**cruzar los dos archivos por `codigo_iso`** para leer, en el archivo que sí la
muestra, exactamente la base que el otro había ocultado.

Para cerrar esa grieta, la base compartida se suprime de forma **conjunta**:

- Primero se calcula, para cada conjunto que publica esa base, qué provincias
  quedarían suprimidas por sus propias reglas.
- Si una provincia queda suprimida en **cualquiera** de esos conjuntos, su columna
  `mascotas_activas` se publica como `suprimido por privacidad` en **todos** ellos.
- Las columnas propias de cada conjunto (el porcentaje de cobertura correspondiente)
  conservan su supresión individual. Es seguro publicar un porcentaje sin su base:
  una tasa sola —sin el total— no permite recuperar ningún conteo, y sólo mostramos
  el porcentaje cuando el grupo cubierto y el no cubierto ya son ≥ 5.

Esta regla se deriva automáticamente de la definición de los conjuntos: si en el
futuro un tercer conjunto publica esa misma base, queda incluido en la supresión
conjunta sin ningún cambio de criterio. El cálculo se hace sobre los conteos vigentes
al generar cada archivo, no leyendo el archivo ya publicado del otro conjunto. Como
cada archivo se regenera de forma independiente (caché diaria), dos archivos generados
en momentos distintos pueden diferir transitoriamente en qué provincias marcan; esa
diferencia nunca expone un grupo menor a 5, porque una base solo se publica en un
archivo cuando, al momento de generarlo, ningún conjunto del grupo la suprimía —
es decir, cuando ya era un agregado ≥ 5 apto para publicación.

### Bases anidadas: la resta entre poblaciones que se contienen

Compartir la base no es la única forma en que dos archivos se delatan. Hay bases
que **contienen** a otras: todo perro registrado es una mascota activa, y todo
perro PPP es un perro registrado. Cada archivo puede pasar sus propios controles
de k sobre su propia población y, aun así, la **resta** entre las dos —las
mascotas que no son perros— es un grupo que nadie revisó.

El ejemplo concreto: una provincia con 9.004 mascotas activas y 9.000 perros
registrados publica, sin decirlo, un grupo de 4. Los dos archivos son
"correctos" por separado; el dato surge de cruzarlos por `codigo_iso` y restar.

Por eso la supresión conjunta no compara nombres de columna: compara
**poblaciones declaradas como contenidas una en la otra**. Cuando la diferencia
entre una base y la base que la contiene queda entre 1 y 4, esa base se suprime
en **los dos** archivos. Una diferencia de 0 no se suprime —un complemento vacío
no identifica a nadie—, y la relación se recorre de forma transitiva, así que
también se comparan bases que están a dos pasos (perros PPP contra mascotas
activas), porque quien cruza archivos no está obligado a elegir los contiguos.

## Autoevaluación de riesgo de reidentificación

Analizamos los caminos por los que alguien podría intentar reidentificar a una
persona o mascota a partir de estos datos, y cómo los mitigamos:

- **Celdas chicas (identificación directa)** → mitigado por k-anonimato (k = 5):
  ninguna celda describe a menos de 5 individuos.
- **Reconstrucción del numerador desde la tasa** → mitigado: sólo publicamos filas
  donde el grupo cubierto y el no cubierto tienen 5 o más; y no publicamos el
  numerador crudo.
- **Ataque por diferencia contra un total nacional** → mitigado por la supresión
  complementaria a nivel nacional.
- **Ataque por diferencia entre ventanas de tiempo (temporal)** → **riesgo real,
  mitigado pero no eliminado.** Este endpoint es público y puede descargarse
  automáticamente ("scrapearse") todos los días, así que **sí es posible**
  guardar publicaciones sucesivas y compararlas para intentar aislar cambios
  entre un día y otro. No afirmamos que esto sea imposible. Lo que sí sostenemos:
  - La cadencia es **diaria, no continua**: la ventana mínima entre dos
    fotografías es de un día, lo que reduce (aunque no anula) la granularidad
    de cualquier diferencia observable frente a un scraping más frecuente.
  - Cada fotografía, tomada individualmente, ya pasó por k-anonimato (k = 5) y
    supresión complementaria a nivel nacional. Restar dos fotografías donde la
    misma celda está visible en ambas sólo puede exponer una diferencia entre
    dos grupos que YA eran ≥ 5 cada uno — la resta nunca expone directamente un
    grupo menor a 5, porque ninguno de los dos términos de la resta lo era.
  - Reconocemos un **riesgo residual de inferencia** sobre las celdas
    suprimidas: si una celda aparece suprimida en una fotografía y visible en
    la siguiente (o viceversa), comparar ambas puede acotar el rango del valor
    que estuvo oculto (por ejemplo, saber que pasó de "suprimido" a un valor
    visible acota su crecimiento mínimo). Esto no revela el valor exacto que
    estuvo suprimido, pero es un vector de inferencia real que no
    minimizamos.
  - **Trabajo futuro (NO implementado todavía)**: estamos evaluando una
    supresión "delta-aware" — que trate cada par de publicaciones sucesivas
    como una unidad a proteger, no sólo cada fotografía por separado — y/o
    publicaciones congeladas en períodos fijos más espaciados. Mientras esa
    mitigación no esté implementada, el riesgo residual descripto arriba se
    mantiene.
- **Cruce entre conjuntos** → los conjuntos de esterilización y microchip comparten
  **la misma población base** (`mascotas_activas`, calculada del mismo denominador).
  Si cada conjunto se suprimiera por separado, una provincia podría quedar oculta en
  uno pero visible en el otro, y bastaría **cruzar los dos archivos por `codigo_iso`**
  para recuperar la base que uno de ellos había ocultado. Por eso la supresión de la
  base compartida es **conjunta** (ver "Supresión conjunta de la base compartida"): si
  una provincia se suprime en **cualquiera** de los conjuntos que publican esa base,
  su columna `mascotas_activas` se suprime en **todos** ellos. Así, cruzar los archivos
  nunca recupera una base que fue ocultada en alguno.
- **Localidad no informada** → algunas mascotas tienen provincia pero no localidad.
  Como estos conjuntos son provinciales, esas mascotas están correctamente contadas
  y no generan discrepancia geográfica.

## Licencia y actualización

- **Licencia**: Creative Commons Atribución 4.0 Internacional (CC BY 4.0).
- **Atribución**: *MiMAR — Sistema de credencial digital de mascotas (Argentina).
  datos.mimar.gob.ar*
- **Actualización**: las cifras se recalculan al menos una vez por día. Cada
  descarga informa su fecha de generación en los metadatos.

Ver también el [diccionario de datos](./diccionario.md) para el detalle de columnas
de cada conjunto.
