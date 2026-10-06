# Ficha nativa — paridad con la ficha web (2026-10)

La ficha del dueño en el teléfono pinta el mismo papel que
`/mis-mascotas/[token]`. Este escrito dice qué cambió en JavaScript y qué
queda para un rebuild nativo. No agrega módulos, fuentes, ni Reanimated.

## Lo que se ve

| Pieza | Web (aprobada) | App |
|---|---|---|
| Banda | Azul marino, siempre. La marca es miMAR. El subtítulo nombra la cara. | Igual. «miMAR» es texto: el holograma pide un asset y no entra en este pase. |
| Chip de situación | Bajo el nombre, en el frente. En el dorso, debajo de la banda, porque ahí no hay fila de identidad. Al día no lleva chip. | Igual. El color de la situación está en el chip. La banda no cambia de color. |
| «Registrada/o» | No está. | No está. |
| Celda derecha | QR, ping, o nada (`resolveCredentialRightCell`). | La misma clase, en `status.rightCell`. El servidor la decide; las coordenadas no viajan. |
| Vacunación | Cuatro celdas. El color solo si el número es mayor que cero. | Igual, en la libreta. «Vigente», nunca «Al día», en esa grilla. |
| Asientos | Filas. No se repite el rótulo ni la fecha. | Igual. La fila entera sigue siendo el botón. |
| Acciones | Debajo de la tarjeta. | Ya estaban debajo (`OwnerActionPanel`). No se movieron. |
| Pie | — | Sigue «Libreta Sanitaria · lugar» y «Consultada el …». No dice «República Argentina» ni «Emitida». |

## Lo que este pase no hace

- **Coordenadas del último lugar.** El payload trae la clase de celda
  (`rightCell`), no el punto. El ping es el dibujo; no abre un mapa.
- **Holograma, OVD.** Piden assets. La marca es la palabra miMAR. (La
  escarapela y el papel sí: desde 2026-10-06 la credencial del teléfono los
  pinta, en `DocumentChromeNative.tsx`.)
- **Reanimated, módulos nativos, fuentes nuevas.** El giro sigue en
  `Animated` de React Native.
- **`/t/`.** Fuera de este trabajo.
- **Suavizar «Vencida» cuando la fecha es una estimación.** En la web eso
  mira `dueSource`. El payload de la libreta del teléfono no lo trae, así que
  un vencimiento con número mayor que cero se pinta en rojo.

## Dónde está cada cosa

- Banda y chip del dorso: `apps/mobile/src/pets/DocumentChromeNative.tsx`.
  `bandSkin` sigue teniendo el color de cada situación (lo usa el chip).
  `credentialBandSkin` es la banda, y es la azul marino.
- Chip del frente, foto y QR: `apps/mobile/src/pets/OwnerFace.tsx`.
- Grilla y filas: `apps/mobile/src/pets/LibretaScreen.tsx`.
- «Vigente» en cada vacuna: `vaccineStatusLabel` en `libreta-view-model.ts`.
