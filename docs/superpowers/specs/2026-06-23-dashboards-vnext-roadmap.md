# Spec/Roadmap: Dashboards vNext — completitud de proyecciones (foco admin)

> **Documento de pensamiento — NO toca código.** Roadmap forward-looking de las próximas versiones de los
> dashboards, partiendo de la implementación actual (paquete metrics-IA A/B/C/D + Panorama + sistema). Responde:
> (1) qué estados de mascota NO proyectamos, (2) próximos dashboards lógicos, (3) QOL + buenas prácticas de
> proyección faltantes — especialmente para admins. Evidencia: `db/schema.ts` (enums + comentarios) + recorrido
> en vivo de toda la sesión. Convención: 🟢 incremental · 🔵 paquete nuevo · ⭐ misión.

## 1. Estados de mascota: representados vs. faltantes
`petStatusEnum = ["active","lost","deceased"]` — solo 3 estados duros. El **ciclo de vida real** vive en
`ownershipRoleEnum` (owner / shelter_custody / foster), en el catálogo de eventos (custody/adoption/transfer/
pregnancy) y en flags (`pregnancy_status`, `potentiallyDangerousBreed`, service-dog). **Casi todo eso está
"schema-ready, UI deferred"** (comentario literal en `db/schema.ts:315`).

| Estado / dimensión | Schema | Proyectado en admin/gob | Gap |
|---|---|---|---|
| `active` (al día) | ✅ | parcial (cobertura/registro) | nuance salud-status |
| `lost` | ✅ | ✅ perdidas + Panorama | — |
| `deceased` | ✅ | ✅ mortalidad | — |
| **shelter_custody** (custodia refugio) | ✅ | ❌ | **censo nacional de custodia** |
| **foster / tránsito** | ✅ (`foster_assigned/ended`) | ❌ | pool + utilización |
| **adoptable → adoptada → devuelta** | ✅ (`adoption_finalized` + listing) | ❌ (solo KPI "tasa adopción") | **pipeline + tiempo-en-estado** |
| **pet_transfers** (pending/accepted/expired…) | ✅ | ❌ | actividad de transferencias |
| **custody_disputes** (población) | ✅ | ❌ (existe la cola, no la proyección) | — |
| **preñez / reproducción** | ✅ (`pregnancy_status`) | ❌ | **⭐ North Star (control poblacional)** |
| **esterilización vs natalidad** (balance) | ✅ | ❌ | **⭐ métrica-misión inexistente** |
| **perro de asistencia** (vigente/vencida/revocada) | ✅ | ❌ | población + vigencia de credencial |
| **PPP** como población | ✅ | ❌ (solo % registro) | mapa de riesgo PPP |
| **dormant / perfil incompleto** | derivable | ❌ | salud del registro |
| **identificación** (active/replaced/removed/unreadable) | ✅ | ❌ (solo penetración) | calidad de identificación |
| **unowned animals** (denuncias sin dueño) | ✅ (`temporary_pet_descriptions`) | parcial (denuncias) | — |

**Conclusión:** las proyecciones cubren bien **vigilancia sanitaria** y **bienestar/fiscalización**, pero el
**ciclo de población/custodia** (la North Star del producto) está casi sin representar.

## 2. Próximos dashboards lógicos (paquetes que siguen al A/B/C/D)

### 🔵 Paquete E — Censo poblacional & salud del registro *(lo que más le importa a un admin nacional)*
- Total registradas; **activas vs dormant** (sin eventos en N meses); perfiles incompletos (sin chip/sexo/localidad).
- **Crecimiento de altas en el tiempo** (la curva que muestra si el programa escala hacia Mi Argentina).
- Embudo de identificación: registrada → con chip → chip ISO-válido → credencial usada (scans).
- Por jurisdicción + especie + edad/sexo (cohortes).

### 🔵 Paquete F — Pipeline de custodia & adopción
- Embudo intake → tránsito → adopción → devolución, con **tiempo-en-estado** y tasa de retorno.
- Utilización del **pool de foster** y de capacidad de refugios (ocupación vs cupo declarado).
- Outcomes por org (ranking de colocación) + post-adoption check-ins.

### ⭐ Paquete G — Control poblacional (North Star)
- **Esterilización vs natalidad** (preñez/eventos reproductivos) → tasa neta de crecimiento de la población.
- Cobertura de esterilización por jurisdicción vs meta; impacto de campañas (anotar lanzamientos en la serie).
- Es la métrica que **justifica el proyecto** y hoy no existe.

### 🔵 Paquete H — Salud operativa del programa (admin-specific)
- **SLA**: aging de colas, ENO-notification SLA, drain del outbox, salud de crons (sistema ya tiene base).
- **Comparación cross-jurisdicción + outliers** (quién está muy abajo de meta) como vista de primera clase.
- **Calidad de datos**: completitud por campo, tasa de supresión k-anon, registros huérfanos, drift.
- **Oversight de auditoría/PII**: quién buscó qué (el logging existe — falta el dashboard).

## 3. QOL + buenas prácticas de proyección faltantes

**Buenas prácticas de proyección (subutilizadas):**
1. **Deltas período-a-período + sparklines** en cada KPI (`OpKpi` ya lo soporta) — "vs período anterior".
2. **Targets/benchmarks** en TODA métrica (la meta 80% de cobertura existe; extender con línea de meta + color divergente).
3. **Tendencias en todos lados** (D1 llegó a 2 dashboards; small-multiples por KPI).
4. **Drill consistente** KPI → breakdown → registros (hoy disparejo).
5. **Cohortes/segmentación** pivotable (especie/edad/sexo/raza/jurisdicción).
6. **Denominador & confianza transparentes**: mostrar n, % de completitud del denominador, celdas suprimidas.
7. **Frescura del dato**: "calculado al …", último evento ingestado (los dashboards no dicen *cuándo*).
8. **Anomalías/alertas** sistematizadas: el `OpBreach` puntual → reglas de umbral + **suscripciones** ("avisame si zoonosis activas > X en cualquier jurisdicción").
9. **Forecast simple** (proyección de tendencia: ¿hacia dónde va la cobertura vs meta?).
10. **Anotaciones** en la línea de tiempo (lanzamiento de campaña → ver impacto).

**QOL específico de admin:**
1. **Resumen ejecutivo / "program health"** de una página: las KPI North-Star + alertas activas + outliers.
2. **Comparación temporal** (mes vs mes anterior, YoY) y **cross-jurisdicción** como vistas nativas.
3. **Vistas guardadas + reportes programados** (CSV existe; falta digest por mail + export PDF para un nacional).
4. **Dashboard customizable / pin de KPIs** que el admin mira siempre.
5. **Glosario de métricas central** (los ⓘ existen; falta el índice navegable con fórmula + ancla legal).
6. **Empty-states que explican** (KPI en 0: "sin datos" vs "verdadero cero" — distinguir).
7. **Modo demo explícito** (flag #20): banner solo cuando el dataset es sintético, no siempre.

## 4. Secuencia recomendada
1. **Incrementales primero (🟢, alto ROI, bajo costo):** deltas+sparklines + targets + frescura + drill consistente en los KPIs que ya existen → sube la calidad percibida de TODO sin paquetes nuevos.
2. **Paquete E (censo & registro)** — el que un admin nacional pide primero (¿crece el programa?).
3. **⭐ Paquete G (control poblacional)** — la métrica-misión; alto impacto narrativo para el ejecutivo.
4. **Paquete F (custodia & adopción)** — desbloquea el valor del ciclo "UI deferred".
5. **Paquete H (salud operativa) + alertas/suscripciones + resumen ejecutivo** — madurez operativa.

> Todo se apoya en `lib/metrics` (projection primitives + k-anon + period) y en eventos que **ya existen** en el
> catálogo — el grueso es **proyección + UI**, no schema. Coordinar con el Panorama v2 (`2026-06-23-panorama-v2-design.md`):
> los nuevos estados (custodia/adopción/reproducción) entran como capas/presets de esa misma consola.
