# Marco legal completo — DIM

> Inventario exhaustivo de leyes, decretos, resoluciones, tratados y estándares internacionales argentinos vigentes (mayo 2026) que tocan a perros, gatos y otros animales de compañía. Complementa la tabla resumen de `AGENTS.md → Legal framework`. Cuando una norma tiene implicancia directa sobre el modelo de datos o sobre un evento del Libreta, se anota como **DIM:**.
>
> Estructura: **Nacional → Provincia de Buenos Aires → CABA → Internacional**. Dentro de cada jurisdicción, por categoría temática.
>
> Última verificación: 2026-05-18.

---

## 1. NACIONAL (federal)

### 1.1 Bienestar animal / crueldad

- **Ley 14.346 / 1954** — Malos tratos y actos de crueldad contra los animales. Tipifica penalmente actos de maltrato (Art. 1) y crueldad (Art. 3); pena de 15 días a 1 año de prisión. Base del derecho penal animal argentino ("Ley Sarmiento/Benítez"). [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-14346-153011/texto)
  - **DIM:** `maltreatment_reported.payload` debería poder anclarse a un eventual circuito de denuncia 14.346.

- **Ley 27.330 / 2016** — Prohibición de carreras de perros en todo el territorio nacional. Pena de 3 meses a 4 años + multa. Complementaria del Código Penal. Promulgada por Decreto 1221/2016. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-27330-268503/texto)

- **Decreto 1221 / 2016** — Promulga la Ley 27.330. [Fuente](https://leyesargentinas.com/norma/268505/decreto-1221-carreras-de-perros-ley-n-27-330-promulgacion)

### 1.2 Zoonosis y salud pública

- **Ley 22.953 / 1983** — Lucha antirrábica. Declara de interés nacional la lucha contra la rabia transmitida por perros y gatos; base legal de las campañas antirrábicas. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-22953-184650)
  - **DIM:** ancla legal de `antirabies_vaccinated` y de la obligatoriedad de la vacuna anual desde los 3 meses.

- **Ley 12.732 / 1941** — Profilaxis de la hidatidosis (equinococosis). Zoonosis con reservorio canino. [Fuente](https://argentina.gob.ar/normativa/nacional/ley-12732-196049/texto)

- **Ley 11.843 / 1934** — Profilaxis de la peste / exterminio de roedores. Reglamentada por Decreto 92.767. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-11843-195173/texto)

- **Ley 15.465 / 1960** — Régimen legal de enfermedades de notificación obligatoria. Reglamentada por Decreto 3640/1964. Incluye rabia, hidatidosis, leptospirosis, leishmaniasis, brucelosis. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-15465-195093/texto)

- **Resolución MS 1715 / 2007** — Normas de vigilancia y control de ENO; lista oficial de eventos. Modificada por Res. MS 54/2008, 2827/2022 y 3517/2022. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/175000-179999/175879/norma.htm)

- **Resolución MS 1144 / 2018** — Guía de Prevención, Vigilancia y Control de la Rabia en Argentina. Define APR (atención post-exposición), profilaxis y técnicas diagnósticas. [Fuente](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-1144-2018-311546/texto)

- **Resolución MS 1811 / 2011** — Programa Nacional de Control de Enfermedades Zoonóticas (hidatidosis, triquinosis, hantavirus, leishmaniasis visceral, psitacosis). [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/185000-189999/189688/norma.htm)

- **Resolución MS 546 / 1985** — Manual de procedimientos de control de hidatidosis. [Fuente](http://www.legisalud.gov.ar/atlas/categorias/zoonosis.html)

### 1.3 Ejercicio veterinario y productos veterinarios

- **Ley 14.072 / 1951** — Ejercicio profesional de la medicina veterinaria en jurisdicción nacional y CABA. Matriculación obligatoria; sanción por ejercicio ilegal (Art. 247 CP). [Fuente](https://www.saij.gob.ar/legislacion/ley-nacional-14072-ejercicio_profesional_medicina_veterinaria.htm)
  - **DIM:** condición de verificación de `Organization.org_type='clinic'` y de profesionales que firman eventos clínicos.

- **Ley 13.636 / 1949** — Productos veterinarios. Ley marco de importación, exportación, elaboración, tenencia, distribución y venta. Reglamentada por Decreto 583/1967 y normativa SENASA posterior. [Fuente](https://digesto.senasa.gob.ar/items/show/728)

- **Ley 3.959 / 1900** — Policía Sanitaria Animal. Ley fundacional de la policía sanitaria; base de las atribuciones de SENASA. Modificada por Leyes 14.305 y 17.160. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/45000-49999/49274/texact.htm)

- **Decreto-Ley 6.704 / 1963** — Defensa sanitaria animal y vegetal. Complementa la Ley 3.959. [Fuente](https://www.argentina.gob.ar/normativa/nacional/decreto_ley-6704-1963-70723)

- **Decreto 583 / 1967** — Reglamentación de la Ley 13.636; crea el Registro Nacional de Productos Veterinarios (SENASA). Modificado por Decreto 3.899/1972. [Fuente](https://digesto.senasa.gob.ar/items/show/727)

- **Decreto 4.238 / 1968** — Reglamento de Inspección de Productos, Subproductos y Derivados de Origen Animal. [Fuente](https://www.argentina.gob.ar/normativa/nacional/decreto-4238-1968-24788/actualizacion)

- **Res. SENASA 11 / 2025** — Marco regulatorio integral de productos veterinarios. Reemplaza Res. 1642/2019. CUC válido por 10 años, trámite virtual. [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/319474/20250110)

- **Res. SENASA 1642 / 2019** — Predecesora del marco regulatorio actual (aplicada hasta 2025). [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/223664/20191211)

- **Res. SENASA 681 / 2002** — Inscripción de medicamentos y cosméticos veterinarios (parcialmente vigente). [Fuente](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-681-2002-76980)

- **Res. SENASA 416 / 2024** — Buenas Prácticas de Manufactura (BPM) de productos veterinarios. Abroga Res. 482/2002. [Fuente](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-416-2024-398328)

- **Res. SENASA 80 / 2025** — Receta Electrónica Veterinaria. Obligatoria para fosfomicina y polimixina B (antibióticos críticos). Vigente desde 17/03/2025. [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/321082/20250213)
  - **DIM:** primer sistema digital nacional de trazabilidad de medicamentos veterinarios. Integración futura natural con `treatment_administered.payload`.

- **Res. SENASA 433 / 2025** — Certificado de Inscripción y Elaboración o Importación (CIE) de biológicos veterinarios. [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/326943/20250613)

- **Res. SENASA 333 / 2025 y 338 / 2025** — Autorización por equivalencia de biológicos veterinarios. [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/325427/20250516)

- **Res. SENASA 749 / 2025 y 750 / 2025** — Actualización de controles para vacunas e insumos veterinarios; modifica Res. 609/2017. [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/332100/20250930)

- **Res. SENASA 1 / 2018** — Procedimiento unificado de acreditación de veterinarios y técnicos privados. [Fuente](https://digesto.senasa.gob.ar/items/show/399)

- **Disposición ANMAT 9236 / 2023** — Buenas Prácticas en Bioterios. Abroga Disp. ANMAT 6344/1996. Aplica principio de las 3R. [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/297786/20231103)

### 1.4 Específico de animales de compañía (tenencia, identificación, transporte, importación/exportación)

- **Decreto 1088 / 2011** — Programa Nacional de Tenencia Responsable y Sanidad de Perros y Gatos (PNTRySPyG / Protenencia). Establece presupuestos mínimos, esterilización masiva y gratuita, vacunación y desparasitación. [Fuente](https://www.argentina.gob.ar/normativa/nacional/decreto-1088-2011-184639/texto)
  - **DIM:** marco operacional dentro del cual `sterilization_performed`, `antirabies_vaccinated` y `dewormed` cobran sentido como eventos de programa.

- **Ley 26.858 / 2013** — Acceso, deambulación y permanencia de personas con discapacidad acompañadas por perro guía o de asistencia. Reglamentada por Decreto 792/2019. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-26858-216286)
  - **DIM:** podría justificar un flag `assistance_dog: boolean` en `pets`.

- **Decreto 792 / 2019** — Reglamenta Ley 26.858; designa a ANDIS como autoridad de aplicación. [Fuente](https://www.saij.gob.ar/792-nacional-reglamentacion-ley-26858-sobre-derecho-acceso-deambulacion-permanencia-lugares-publicos-privados-acceso-publico-servicios-transporte-publico-toda-persona-discapacidad-acompanada-perro-guia-asistencia-designacion-como-autoridad-aplicacion-agencia-nacional-discapacidad-andis-dn20190000792-2019-11-27/123456789-0abc-297-0000-9102soterced)

- **Res. SENASA 580 / 2014** — Documentación para traslado de perros y gatos / formulario antirrábico. Constancia en poder del propietario. [Fuente](https://www.argentina.gob.ar/senasa/consideraciones-generales-y-legislacion)
  - **DIM:** este formulario es exactamente lo que la Libreta digitaliza.

- **Res. ex-SENASA 1354 / 1994** — Requisitos para ingreso de perros y gatos a Argentina; CVI traducido. [Fuente](http://www.senasa.gob.ar/normativas/resolucion-1354-1994-senasa-servicio-nacional-de-sanidad-y-calidad-agroalimentaria)

- **Res. ex-SAGPyA 709 / 1997** — Complementa Res. 1354/1994. [Fuente](https://www.argentina.gob.ar/senasa/informacion-al-viajero/ingresar-o-regresar-al-pais/ingresos-con-perros-yo-gatos)

- **Res. SENASA 76 / 2019** — Procedimiento para ingreso definitivo de caninos y felinos. Certificación antirrábica >3 meses, 30 días antes del ingreso. [Fuente](http://www.senasa.gob.ar/normativas/resolucion-76-2019-senasa-servicio-nacional-de-sanidad-y-calidad-agroalimentaria)

- **Res. MAGyP 727 / 2015** — Traslado al exterior de perros y gatos. CVI internacional; articula con Res. GMC MERCOSUR 17/2015. [Fuente](https://www.ecofield.net/Legales/Sanidad_vegetal/res727-15_MAGyP.htm)

- **Res. SENASA 923 / 2019** — Trámites urgentes y fuera de horario en SENASA (mascotas incluidas). [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/212974/20190806)

- **Res. Secretaría de Transporte 2076 / 2025** — Traslado de animales domésticos en micros y trenes de larga distancia y aviones de jurisdicción nacional. Un animal por pasajero adulto; vacuna antirrábica obligatoria; mínimo 4 meses; excluye razas braquicéfalas; excepción para perros guía/asistencia. [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/336643/20251223)

- **Res. SENASA 284 / 2024** — Identificación electrónica animal (microchips ISO 11784/11785). Foco en équidos pero estándar técnico de referencia. [Fuente](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-284-2024-398615/texto)
  - **DIM:** estándar ISO 11784/11785 es el que debe leer la app para `microchip_implanted.payload.iso_id`.

- **Ley 24.449 / 1994** — Ley Nacional de Tránsito. Prohíbe animales sueltos en la vía pública; requisitos de transporte. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/0-4999/818/texact.htm)

### 1.5 Código Civil y Comercial — estatuto jurídico del animal

- **Ley 26.994 / 2014 — Código Civil y Comercial de la Nación**. Vigente desde 1/8/2015. Animales como "cosas muebles" (semovientes). [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=235975)

- **CCyCN Art. 227** — Cosas muebles. [Fuente](https://leyfacil.com.ar/codigo-civil-y-comercial/articulo-227/)

- **CCyCN Art. 1.947** — Apropiación. Los animales domésticos y domesticados NO son susceptibles de apropiación aunque escapen. [Fuente](https://codigocivilonline.com.ar/articulo-1947/)
  - **DIM:** clave para el caso "vecino encuentra perro en la calle" → no se vuelve dueño por apropiación; sostiene la `Ownership.role='shelter_custody'` con `owner_user_id`.

- **CCyCN Art. 1.948** — Caza; animal salvaje o domesticado que recobra libertad. [Fuente](https://codigocivilonline.com.ar/etiquetas/articulo-1948/)

- **CCyCN Art. 1.759** — Daño causado por animales (responsabilidad objetiva). [Fuente](http://universojus.com/codigo-civil-comercial-comentado/articulo-1759)
  - **DIM:** justifica la centralidad del dato `potentially_dangerous_breed` y la atestación.

- **CCyCN Art. 1.757** — Hecho de las cosas y actividades riesgosas. [Fuente](https://www.rpba.gob.ar/files/Normas/Leyes/CCCN1757-1759.pdf)

- **Ley 22.939 / 1983** — Régimen de marcas y señales de ganado. Marco federal de identificación de semovientes (referencia doctrinal). [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-22939-56748/texto)

### 1.6 Marco adyacente (fauna silvestre — relevante para tenencia de exóticos)

- **Ley 22.421 / 1981** — Conservación de la Fauna Silvestre. Reglamentada por Decreto 666/1997. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-22421-38116/texto)

### 1.7 Legislación pendiente (proyectos)

- **Proyecto "Ley Sintientes"** (Dip. Sotolano, 19/11/2025) — Reconoce a los animales como personas físicas no humanas; modifica Arts. 16 y 227 CCyCN. [Fuente](https://www.infobae.com/sociedad/2025/12/05/el-proyecto-de-ley-sintientes-llega-al-congreso-la-norma-que-busca-que-los-animales-dejen-de-ser-considerados-cosas/)
- **Proyecto de Ley de Bienestar Animal** (Min. Ambiente) — Presupuestos mínimos en zoológicos, santuarios, centros de rescate. [Fuente](https://www.argentina.gob.ar/noticias/se-presento-el-primer-proyecto-de-ley-de-bienestar-animal-en-el-congreso-de-la-nacion)
- **Proyecto "Ley Conan"** (Exp. 2489-D-2024) — Endurece penas de Ley 14.346. [Fuente](https://www4.hcdn.gob.ar/dependencias/dsecretaria/Periodo2024/PDF2024/TP2024/2489-D-2024.pdf)
- **Proyecto integral de protección y bienestar animal** (Dip. Juliano, 2026) — Penas hasta 3 años; excluye prácticas SENASA. [Fuente](https://www.lanacion.com.ar/economia/campo/seres-sintientes-impulsan-una-nueva-ley-de-proteccion-y-bienestar-animal-con-prision-y-millonarias-nid05032026/)
- **Proyecto sobre experimentación animal en investigación** (AACyTAL). [Fuente](https://argentinainvestiga.edu.ar/noticia.php?titulo=animales_en_laboratorio_una_cuestin_tica&id=1466)
- **Proyecto Exp. 1473-D-2019** — Notificación obligatoria de leishmaniasis. [Fuente](https://www2.hcdn.gob.ar/proyectos/proyectoTP.jsp?exp=1473-D-2019)
- **Proyectos de microchip nacional obligatorio** — Diversos, sin sanción a la fecha. [Fuente](https://www.infobae.com/tendencias/2022/04/14/caba-proponen-colocar-un-microchip-en-perros-y-gatos-para-su-cuidado-responsable/)

---

## 2. PROVINCIA DE BUENOS AIRES

### 2.1 Bienestar animal / crueldad

- **Ley 13.879 / 2008** — Prohibición del sacrificio de perros y gatos en dependencias oficiales. Esterilización quirúrgica como único método de control poblacional; alineada con Ley nacional 14.346. [Fuente](https://normas.gba.gob.ar/documentos/BK86vtoV.html)

- **Decreto 400 / 2011** — Reglamenta Ley 13.879. Min. de Salud bonaerense como autoridad de aplicación; desparasitación obligatoria en centros de zoonosis. [Fuente](https://normas.gba.gob.ar/documentos/VWWErYtG.html)

- *Nota:* la Ley nacional 14.346 se aplica directamente en territorio bonaerense; no existe ley provincial de adhesión formal.

### 2.2 Zoonosis y salud pública

- **Decreto-Ley 8056 / 1973** — Profilaxis de la rabia en PBA. Vacunación obligatoria, dispensarios antirrábicos municipales, notificación obligatoria. [Fuente](https://normas.gba.gob.ar/documentos/eBMP7tqx.html)

- **Decreto 4669 / 1973** — Reglamenta DL 8056. Vacunación antirrábica obligatoria de perros y gatos con asiento habitual, transitorio o circunstancial en PBA; observación antirrábica 10 días para mordedores. [Fuente](https://normas.gba.gob.ar/documentos/VGOWA8fW.html)

- **Ley 5664 / 1952** — Profilaxis de la rabia y patente canina. Inscripción y vacunación gratuitas; obligación de chapa patente del año en curso. [Fuente](https://normas.gba.gob.ar/documentos/BO41rukV.html)

- **Ley 5325 / 1948** — Denuncia obligatoria de enfermedades contagiosas/transmisibles dentro de las 24 hs. [Fuente](https://normas.gba.gob.ar/documentos/BKaq1Co0.html)

- **Ley 6115 / 1959** — Profilaxis obligatoria de brucelosis, hidatidosis, tuberculosis y triquinosis. [Fuente](https://normas.gba.gob.ar/documentos/0vGaATex.html)

- **Resolución CVPBA 05 / 2020** — Enfermedades de denuncia obligatoria en pequeños animales (brucelosis canina, clamidiosis aviar, filariasis, esporotricosis, leishmaniasis visceral canina, leptospirosis, micobacterias, rabia animal). [Fuente](https://cvpba.org/wp-content/uploads/2022/03/ENO-05-2020-1.pdf)
  - **DIM:** lista de enfermedades base para `symptom_observed`/`disease_diagnosed` con flag de denuncia obligatoria.

### 2.3 Ejercicio veterinario

- **Decreto-Ley 9686 / 1981** — Régimen del Colegio de Veterinarios de la PBA (CVPBA) y ejercicio profesional. [Fuente](https://normas.gba.gob.ar/documentos/VJ9qrfJB.html)

- **Decreto 1420 / 1983** — Reglamenta el DL 9686 (matrícula, ética, organización). [Fuente](https://normas.gba.gob.ar/ar-b/decreto/1983/1420/155146)

- **Ley 10.526 / 1987** — Establecimientos donde se ejerce la medicina veterinaria. Condiciones edilicias, venta de zooterápicos, depósitos, locales de venta de animales. [Fuente](https://normas.gba.gob.ar/documentos/xq98GIpx.html)

- **Decreto 154 / 1989** (mod. Decreto 1546/1992) — Reglamenta Ley 10.526. [Fuente](https://normas.gba.gob.ar/documentos/0zQGbwT8.html)

### 2.4 Específico de animales de compañía

- **Ley 14.107 / 2010** — Régimen de tenencia de perros potencialmente peligrosos. Registro Provincial; inscripción <6 meses; identificación por microchip o tatuaje obligatoria; correa <1 m; bozal y collar. Lista de razas en Anexo I. [Fuente](https://normas.gba.gob.ar/documentos/0PNzEIAB.html)
  - **DIM:** matriz canónica de `potentially_dangerous_breed=true` para residentes en PBA + obligatoriedad de chip → `microchip_implanted` no es opcional.

- **Ley 13.879 / 2008** — Tenencia responsable (también en 2.1). Esterilización como único método de control poblacional. [Fuente](https://normas.gba.gob.ar/documentos/BK86vtoV.html)

- **Ley 15.409 / 2022** — Perros de asistencia para personas con discapacidad. Crea Registro Provincial. [Fuente](https://normas.gba.gob.ar/documentos/xq9nMXCp.html)

### 2.5 Ordenanzas municipales notables

- **Ordenanza La Plata 12.145 / 2021** — Municipio "no eutanásico"; crea el CMSAZ; esterilización gratuita, masiva, extendida y temprana. [Fuente](https://sibom.slyt.gba.gob.ar/bulletins/6358/contents/1658236)

- **Ordenanza Gral. Pueyrredon (Mar del Plata) 22.031** — Reglamento de tenencia responsable de mascotas; esterilización como único método. [Fuente](https://www.mardelplata.gob.ar/documentos/salud/ord%20%2022031.pdf)

---

## 3. CABA

### 3.1 Bienestar animal / crueldad

- **Ley CABA 6173 / 2019** — Protección y cuidado de animales domésticos. Incorpora Título VI Libro II del Código Contravencional (Ley 1472): tipifica omisión de cuidados (Art. 126), abandono (Art. 127), instalaciones inadecuadas, hostigamiento. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/479417)

- **Ley CABA 6839 / 2025** ("Ley Huellas") — Endurece sanciones por maltrato, abandono y cría ilegal. Arts. 142 bis y 143 bis (animal encerrado en vehículo, cría ilegal). Crea el "Registro de infractores a la Ley de Maltrato Animal" dentro del Registro de Contravenciones. Multas hasta $8M, trabajo comunitario hasta 60 días. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/819902)
  - **DIM:** registro de infractores es un dato externo a integrar eventualmente en verificación de adoptantes.

- **Ley CABA 1472 / 2004** — Código Contravencional. Marco general donde se insertan los tipos de maltrato y abandono. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/62598)

- **Ley CABA 451 / 2000** — Régimen de Faltas. Sanciona tiro al pichón, destrucción de nidos, cebos tóxicos, venta/exhibición irregular (inc. 1.2.9). [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/8540)

- *Aplicación directa de la Ley nacional 14.346:* CABA no requiere adhesión formal. Interviene UFEMA en denuncias.

### 3.2 Zoonosis y salud pública

- **Ordenanza CABA 41.831 / 1987** (texto consolidado por Leyes 5454, 6347 y 6764/2024) — Tenencia de animales domésticos. Registro Municipal de Animales Domésticos, Registro Municipal de Profesionales Veterinarios, vacunación antirrábica obligatoria desde los 3 meses, observación antirrábica, venta/alojamiento/tránsito. Inscripción al 4° mes; identificación por tatuaje o microchip. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/30564)
  - **DIM:** la 41.831 es probablemente la norma operativa más cercana a lo que DIM digitaliza en CABA.

- **Decreto GCBA 5334 / 1988** — Misiones y funciones del Instituto de Zoonosis Luis Pasteur (diagnóstico, prevención, producción antirrábica, observación de mordedores, vigilancia). [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/95006)

- **Decreto GCBA 7322 / 1988** — Norma complementaria sobre estructura del Instituto Pasteur. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/44345)

- **Ley CABA 2628 / 2008** — Creación de la Agencia de Protección Ambiental (APrA), de la que depende el Depto. de Sanidad y Protección Animal. [Fuente](http://www2.cedom.gob.ar/es/legislacion/normas/leyes/ley2628.html)

### 3.3 Ejercicio veterinario en CABA

- **Ley Nacional 14.072 / 1951** (aplicable en CABA — ver § 1.3). Consejo Profesional de Médicos Veterinarios (CPMV) como autoridad de matrícula en la Ciudad. [Fuente](https://cpmv.org.ar/images/Ley14072.pdf)

- **Ordenanza 41.831 / 1987** — Sección Registro Municipal de Profesionales Veterinarios (matriculados que extienden certificados oficiales de vacunación, sanidad, cremación). [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/30564)

- **Ley CABA 6764 / 2024** — Quinta actualización del Digesto Jurídico de la CABA. Consolida la normativa sobre profesionales veterinarios, animales domésticos, antirrábica. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/769095)

### 3.4 Específico de animales de compañía

**Tenencia responsable**

- **Ley CABA 5346 / 2015** — Declara a CABA "Ciudad de Tenencia Responsable de Animales Domésticos de Compañía". Prohíbe sacrificio como control poblacional. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/292009)

**Vía pública, espacios verdes y deyecciones**

- **Ley CABA 5471 / 2015** — Modifica Ordenanza 41.831. Tránsito y permanencia de perros/gatos. Rienda y collar/bozal; plazas/parques solo en caniles; obligación de recoger deyecciones. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/303125)

**Transporte público**

- **Ley CABA 5687 / 2016** — Traslado de perros y gatos en el Subte. Un animal por pasajero adulto, dispositivo cerrado, vacuna antirrábica obligatoria. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/342040)

- **Decreto GCBA 31 / 2017** — Reglamenta Ley 5687. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/346757)

- **Ley CABA 2148 / 2007** — Código de Tránsito y Transporte de la CABA. Prohíbe animales sueltos en vehículos; tracción animal regulada. [Fuente](http://www2.cedom.gob.ar/es/legislacion/normas/leyes/anexos/al2148I.html)

**Perros potencialmente peligrosos**

- **Ley CABA 4078 / 2012** — Tenencia de perros potencialmente peligrosos. Registro de Propietarios. 17 razas + cruzas >20 kg. Inscripción <3 meses, identificación, bozal, correa <2 m, seguro de responsabilidad civil obligatorio. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/302801)
  - **DIM:** ancla el `dangerous_breed_attested` event en CABA (más exigente que la 14.107 PBA — requiere seguro).

- **Resolución 93/APRA/2021** — Reglamenta el Registro de Ley 4078. Procedimiento vía TAD, foto, microchip, antirrábica vigente, póliza, vigencia anual, curso virtual obligatorio, notificación de incidentes en 48 hs. [Fuente](https://buenosaires.gob.ar/noticias/registro-de-propietarios-de-perros-potencialmente-peligrosos)

**Paseo de perros (paseadores)**

- **Decreto GCBA 1972 / 2001** — Registro de Paseadores de Perros. Máximo 8 perros por paseador; edad y residencia requeridas. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/16279)

- **Decreto GCBA 344 / 2018** — Modifica Decreto 1972/2001 (deroga arts. 2 y 3 sobre inscripción obligatoria); operativas se mantienen. [Fuente](https://buenosaires.gob.ar/areas/med_ambiente/higiene_urbana/info_gral/perros.php?menu_id=22687)

**Comercio / pet shops**

- **Ley CABA 6194 / 2019** — Exposición y venta de animales vivos. Prohíbe vidrieras/escaparates con animales con fines de venta o publicidad. Modifica inc. 1.2.9 del Régimen de Faltas. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/489396)

**Cremación**

- **Ley CABA 5470 / 2015** — Proceso especial para cremación de caninos y felinos domésticos. Crea Registro de Cremaciones; mínimo 24 hs tras deceso (excepto infectocontagiosas); certificado veterinario; crematorios habilitados. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/302769)
  - **DIM:** ancla el `death_recorded.payload.disposition_method='cremation'` con `facility` opcional.

### 3.5 Programas: Mascotas BA / Animales BA / castración gratuita

- **Ley CABA 1338 / 2004** — Control de la Población de Animales Domésticos. Marco fundacional de esterilización gratuita, masiva, sistemática y permanente. [Fuente](http://www2.cedom.gov.ar/es/legislacion/normas/leyes/ley1338.html)

- **Ley CABA 4351 / 2012** — Control poblacional de caninos y felinos / sanidad animal. Meta anual mínima del 10%. Crea Centros de Atención Veterinaria Comunal (CAV) y Móviles (CMAV) — al menos uno por Comuna. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/209450)

- **Decreto GCBA 231 / 2013** — Reglamenta Ley 4351. APrA como autoridad de aplicación. [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/221804)

- **Programa "Animales BA" / "Mascotas BA"** — Plataforma del GCBA que opera las Leyes 1338, 4351, 5346 y 4078 (no tiene ley creadora autónoma; opera por vía reglamentaria de APrA). Registro voluntario, denuncia de pérdida/encontrado, adopción, turnos castración/antirrábica, denuncia de maltrato. [Fuente](https://buenosaires.gob.ar/inicio/animales-ba)
  - **DIM:** Animales BA es el sistema con el que DIM debe coexistir (idealmente alimentándolo, no compitiendo) en CABA.

---

## 4. INTERNACIONAL (tratados, convenciones y estándares vinculantes)

### 4.1 Bienestar animal (declaraciones y soft-law)

- **Declaración Universal de los Derechos del Animal (UNESCO, Londres 1978; revisión 1989)** — Soft-law, sin ley argentina de ratificación; algunas provincias adhirieron (Río Negro Ley 3.362/2007). [Fuente](https://www.produccion-animal.com.ar/veterinaria_forense/20-Declaracion_Universal.pdf)

- **Universal Declaration on Animal Welfare (UDAW)** — Borrador no abierto a ratificación; Argentina no ha firmado instrumento vinculante. [Fuente](https://yolcati.es/declaracion-universal-sobre-bienestar-animal-world-animal-proteccion/)

- **WOAH/OIE Terrestrial Animal Health Code — Sección 7 (Bienestar Animal)**; en particular Cap. 7.7 (control de poblaciones de perros vagabundos) y Cap. 8.14 (rabia). Vinculante para Argentina por membresía WOAH (ver § 4.3). Estándar técnico para identificación canina (microchip ISO 11784/11785), registración, vacunación y esterilización. [Fuente](https://www.woah.org/fileadmin/Home/eng/Health_standards/tahc/2023/chapitre_aw_stray_dog.pdf)
  - **DIM:** la referencia técnica más directa que tiene Argentina sobre cómo debe lucir un sistema de identificación canina.

### 4.2 Vida silvestre y cross-cutting (afectan tenencia de exóticos)

- **CITES — Convención sobre el Comercio Internacional de Especies Amenazadas (Washington 1973)**. Ratificada por **Ley 22.344 / 1980**; reglamentada por Decreto 522/1997. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/40000-44999/44770/norma.htm)
  - **DIM:** aplica a tortugas, loros, reptiles y primates comúnmente tenidos como "mascotas".

- **CMS — Convención sobre Especies Migratorias (Bonn 1979)**. Ratificada por **Ley 23.918 / 1991** (con reserva sobre vicuña y Malvinas). [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-23918-318/texto)

- **CBD — Convenio sobre la Diversidad Biológica (Río 1992)**. Ratificado por **Ley 24.375 / 1994**. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=29276)

- **Convención para la Protección de la Flora, Fauna y Bellezas Escénicas Naturales (Washington 1940)**. Ratificada por **Decreto-Ley 16.864 / 1946**. [Fuente](https://www.oas.org/juridico/spanish/tratados/c-8.html)

- **Convención de Ramsar sobre Humedales (1971)**. Ratificada por **Ley 23.919 / 1991**. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/0-4999/319/norma.htm)

- **Protocolo al Tratado Antártico sobre Protección del Medio Ambiente (Madrid 1991)**. Ratificado por **Ley 24.216 / 1993**. Anexo II Art. 4 prohíbe expresamente la introducción de perros en el área del Tratado — único tratado que veda movimiento canino vinculante para Argentina. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-24216-614/texto)

### 4.3 Salud animal y zoonosis

- **Acuerdo Internacional para la Creación de la OIE (París, 25/01/1924)**. Ratificado por **Ley 11.632 / 1932**. Núcleo de las obligaciones argentinas en notificación de enfermedades animales (rabia, leptospirosis, leishmaniasis, brucelosis canina) y cumplimiento del Terrestrial Code. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-11632-203556/texto)

- **WOAH Terrestrial Animal Health Code — Cap. 8.14 (Rabia)** y **Cap. 7.7 (Control de perros vagabundos)**. Vinculantes por membresía. [Fuente](https://www.woah.org/fileadmin/Home/esp/Health_standards/tahc/current/es_chapitre_rabies.htm)

- **Código Sanitario Panamericano (La Habana 1924)**. Firmado y ratificado por Argentina (14/11/1924). Base de la cooperación PAHO/OPS / CEPANZO / PANAFTOSA. [Fuente](https://www.paho.org/en/documents/pan-american-sanitary-code)

- **Constitución OPS (Buenos Aires 1947) y Constitución OMS (1946)** — Argentina miembro fundador. Constitución OMS aprobada por **Decreto-Ley 9.298 / 1956**. [Fuente](https://www.paho.org/en/documents/constitution-pan-american-health-organization)

- **Reglamento Sanitario Internacional — RSI (2005), WHA Res. 58.3**. Vinculante por membresía OMS; vigencia 15/06/2007. Obliga a notificar PHEIC, incluyendo spillover zoonótico. [Fuente](https://www.who.int/health-topics/international-health-regulations)

- **Acuerdo CEPANZO (Centro Panamericano de Zoonosis, Azul, PBA)** — Acuerdo bilateral Argentina–OPS, 1956–1990; sucedido por mandato PANAFTOSA (1997). [Fuente](https://www.paho.org/en/panaftosa/about-panaftosa)

- **Acuerdo OMC sobre Aplicación de Medidas Sanitarias y Fitosanitarias (SPS, Marrakech 1994)**. Ratificado por **Ley 24.425 / 1994**. Base legal del régimen sanitario de SENASA para importación de mascotas (debe basarse en WOAH/Codex/IPPC). [Fuente](https://www.argentina.gob.ar/normativa/recurso/799/l24425-7/htm)

- **Codex Alimentarius (FAO/WHO, 1963)** — Argentina miembro vía FAO y OMS. CCRVDF fija MRLs aplicados vía SENASA. [Fuente](https://www.fao.org/fao-who-codexalimentarius/es/)

- **MoU Cuatripartito One Health (FAO–OMS–WOAH–PNUMA, 2022)** — Compromiso político no-tratado; marco bajo el cual coordinan SENASA, Min. Salud y Min. Ambiente la rabia canina y leishmaniasis. [Fuente](https://www.who.int/teams/one-health-initiative/quadripartite-secretariat-for-one-health)

### 4.4 Transporte

- **Convenio de Chicago sobre Aviación Civil Internacional (Chicago 1944)**. Ratificado por **Decreto-Ley 15.110 / 1946** (Ley 13.891/1946). Anexo 18 / Doc 9284 referencian transporte de animales vivos. [Fuente](https://www.saij.gob.ar/15110-nacional-aprobacion-adhesion-convenios-aviacion-civil-internacional-convenio-chicago-1944-lnt0002165-1946-05-24/123456789-0abc-defg-g56-12000tcanyel)

- **IATA Live Animals Regulations (LAR), 46.ª ed. 2026** — Estándar industrial, no tratado. Aplicado de facto por aerolíneas. [Fuente](https://www.iata.org/en/publications/manuals/live-animals-regulations/)

- **Instrumentos OMI (SOLAS, IMDG)** — Sin instrumento específico sobre transporte marítimo de mascotas; bandera y guía WOAH aplican.

### 4.5 MERCOSUR

- **Tratado de Asunción (Asunción 1991)**. Ratificado por **Ley 23.981 / 1991**. Base de toda la normativa GMC subordinada. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=380)

- **Acuerdo Marco sobre Medio Ambiente del MERCOSUR (Asunción 2001)**. Ratificado por **Ley 25.841 / 2003**. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-25841-91816/texto)

- **Resolución GMC MERCOSUR Nº 17/15** — Requisitos zoosanitarios para ingreso de caninos y felinos domésticos entre Estados Partes. CVI armonizado, validez 60 días; vacunación antirrábica ≥21 días pre-ingreso; desparasitación 15 días; microchip ISO 11784/11785 obligatorio para perros >90 días que ingresan a Uruguay. Deroga Res. GMC 04/96 y 05/96. [Fuente](https://www.argentina.gob.ar/senasa/resolucion-172015)
  - **DIM:** la norma operativa más relevante para movimiento regional de mascotas.

- **Resolución GMC MERCOSUR Nº 11/93** — Marco regulatorio para productos veterinarios. [Fuente](https://normas.mercosur.int/public/normativas/2204)

- **Resoluciones GMC MERCOSUR Nº 44/93 y 39/96** — Reglamentos complementarios. [Fuente](http://www.sice.oas.org/trade/mrcsrs/resolutions/Res3996.asp)

- **Reglamento Técnico MERCOSUR — Residuos de Medicamentos Veterinarios en Productos de Origen Animal** (Res. SENASA 58/01). [Fuente](https://argentinambiental.com/legislacion/nacional/resolucion-5801-sanidad-animal-reglamento-tecnico-mercosur/)

### 4.6 Regional / bilateral (movimiento de mascotas)

- **CVI MERCOSUR / "Pasaporte de Animales de Compañía"** (Res. GMC 17/15 operativa desde 2015; SENASA digital desde 2023). Pet passport regional de facto entre AR, BR, PY, UY. [Fuente](https://www.argentina.gob.ar/senasa/requisitos-particulares-por-destino/mercosur-brasil-paraguay-uruguay)

- **Arreglo operativo SENASA–SAG (Argentina–Chile)** para movimiento de caninos y felinos, bajo el ACE Nº 35. [Fuente](https://www.argentina.gob.ar/senasa/requisitos-particulares-por-destino/chile)

- **Reconocimiento por SENASA del Pasaporte Pet UE (Reg. UE 576/2013)** para ingresos temporales — acuerdo administrativo, no tratado. [Fuente](https://www.argentina.gob.ar/senasa/informacion-al-viajero/ingresar-o-regresar-al-pais/ingresos-con-perros-yo-gatos/procedimiento-para-autorizar-los-ingresos-de-caracter-temporal-de-caninos-yo-felinos)
  - **DIM:** referencia natural para diseñar interoperabilidad de la credencial pública.

- **Convención de Basilea sobre Movimientos Transfronterizos de Desechos Peligrosos (1989)**. Ratificada por **Ley 23.922 / 1991**. Aplica a residuos clínicos veterinarios y medicamentos vencidos. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-23922-322)

---

## 5. Lecturas operativas para DIM (síntesis)

Los instrumentos más estructurantes para el modelo de datos y eventos:

1. **Identificación canina** — el estándar técnico de microchip es ISO 11784/11785 (Res. SENASA 284/2024 + WOAH Cap. 7.7 + Res. GMC 17/15). Para residentes en PBA, el chip es obligatorio para razas listadas en la Ley 14.107; en CABA, la Ordenanza 41.831 admite tatuaje o microchip; a nivel nacional aún no hay obligatoriedad universal.

2. **Vacunación antirrábica** — obligatoria desde los 3 meses, anual; ancla: Ley nac. 22.953 + Res. MS 1144/2018 + Res. SENASA 580/2014 + DL 8056/73 (PBA) + Ord. 41.831 (CABA).

3. **Perros potencialmente peligrosos** — doble régimen: Ley 14.107 (PBA, registro provincial) y Ley 4078 (CABA, registro local + seguro RC). DIM debe modelar ambos.

4. **Esterilización** — política pública nacional (Decreto 1088/2011), provincial (Ley 13.879 PBA) y local (Leyes 1338 y 4351 CABA con CAV/CMAV).

5. **Cremación** — Ley CABA 5470/2015 es la única jurisdicción que la regula explícitamente. `death_recorded.payload.disposition_method` debe poder anclar a esta norma.

6. **Movimiento internacional** — Res. GMC MERCOSUR 17/15 + Res. SENASA 76/2019 (ingreso) + Res. MAGyP 727/2015 (egreso) + reconocimiento UE Pet Passport.

7. **Estatuto jurídico** — Hoy "cosa mueble" (Art. 227 CCyCN); proyecto "Ley Sintientes" (2025) busca reclasificación. El Art. 1.947 CCyCN sostiene la figura de "vecino en custodia temporal".

8. **Maltrato y denuncia** — Ley nac. 14.346 (penal) + Ley CABA 6173 / 6839 (contravencional) + Resolución CVPBA 05/2020 (denuncia obligatoria de zoonosis).

---

## 6. Workflows entre actores (Owner ↔ Organización ↔ Estado)

Cada flujo lista: (1) actor que lo inicia, (2) qué se dispara, (3) anclaje normativo, (4) qué evento DIM lo materializa.

### 6.1 Inscripción / identificación del animal

- **CABA — registro municipal**: Owner → Vet matriculado (chip/tatuaje + datos sanitarios) → Registro Municipal de Animales Domésticos del GCBA, al 4° mes de edad. Ord. 41.831/1987.
  - DIM: `pet_registered` + `microchip_implanted` (o `tattoo_registered`) + entrada en `Organization`-clinic como autor.
- **PBA — patente canina**: Owner → Municipio → emisión anual de "chapa patente"; vacunación obligatoria asociada. Ley 5664/1952; DL 8056/1973.
  - DIM: payload `municipal_license` opcional en `pet_registered.payload`.
- **PBA — registro PPP**: Owner de perro de raza listada → Delegación Municipal del Registro Provincial 14.107, antes de los 6 meses, con identificación obligatoria por chip o tatuaje. Ley 14.107/2010.
  - DIM: `dangerous_breed_attested` con `jurisdiction_province='AR-B'`.
- **CABA — registro PPP**: Owner → APrA via TAD (foto, chip, antirrábica vigente, póliza de seguro RC, curso virtual), antes de los 3 meses; renovación anual; notificación de incidentes <48 hs. Ley 4078/2012, Res. 93/APRA/2021.
  - DIM: `dangerous_breed_attested` con `jurisdiction_city='AR-C'` y payload de póliza.

### 6.2 Vacunación antirrábica (anual, desde 3 meses)

- Owner → Vet matriculado → constancia oficial (formulario Res. SENASA 580/2014) → queda en poder del propietario.
- Vet → carga la dosis en sistema municipal cuando aplica (campañas Mascotas BA, dispensarios antirrábicos PBA).
- Estado (Min. Salud Nac. / GCBA / municipios PBA) → coordina campañas masivas y gratuitas; Instituto Pasteur produce y distribuye antirrábica en CABA. Ley 22.953/1983; DL 8056/1973 (PBA); Ord. 41.831/1987 (CABA); Decreto GCBA 5334/1988.
  - DIM: `antirabies_vaccinated` con `vet_matricula`, `vaccine_batch`, `valid_until` (próximo vencimiento anual).

### 6.3 Mordedura → observación antirrábica de 10 días

- Mordido (humano) → centro de salud → denuncia obligatoria (Ley 15.465 nac.; Ley 5325 PBA).
- Centro de salud → autoridad sanitaria local → dispensario antirrábico (PBA) o Instituto Pasteur (CABA).
- Owner → somete al animal a observación de 10 días, in situ o en sede oficial. DL 4669/1973 (PBA); Ord. 41.831/1987 (CABA); Res. MS 1144/2018.
  - DIM: `bite_inflicted` + `rabies_observation_started` / `rabies_observation_ended`.

### 6.4 Esterilización (control poblacional)

- Owner → CAV / CMAV de su Comuna (CABA, turno vía Mascotas BA) o dispensario municipal PBA → cirugía gratuita.
- Estado: ejecuta meta del 10% anual de la población (Ley 4351/2012 CABA); políticas masivas y permanentes (Ley 1338/2004 CABA; Ley 13.879/2008 PBA; Decreto 1088/2011 Nac.).
  - DIM: `sterilization_performed` con `facility_organization_id` apuntando al CAV/CMAV.

### 6.5 Notificación de Enfermedades de Denuncia Obligatoria (ENO)

- Vet → carga caso → autoridad sanitaria (Min. Salud nac. y/o provincial) en <24 hs. Ley 15.465/1960 (Decreto 3640/64); Ley 5325/1948 (PBA); Res. MS 1715/2007; Res. CVPBA 05/2020 (rabia animal, leishmaniasis visceral canina, leptospirosis, brucelosis canina, esporotricosis, etc.).
  - DIM: `disease_diagnosed.payload.eno_reportable: bool` + `eno_reported_to` + `eno_reported_at`.

### 6.6 Receta veterinaria

- Vet → emite receta → si incluye antibiótico crítico (fosfomicina, polimixina B), receta electrónica obligatoria en sistema SENASA → farmacia veterinaria valida. Res. SENASA 80/2025.
  - DIM: `treatment_administered.payload.senasa_prescription_id` cuando aplica.

### 6.7 Muerte y cremación

- Owner → Vet matriculado (certificado de defunción) → crematorio habilitado (CABA: Ley 5470/2015) → asiento en Registro de Cremaciones GCBA. Plazo mínimo 24 hs salvo causa infectocontagiosa/zoonótica.
  - DIM: `death_recorded` + `disposition_method ∈ {cremation, burial, rendering, other}` + `facility_organization_id`.

### 6.8 Custodia, adopción y transferencia

- **Vecino encuentra animal**: ciudadano → custodia temporal sin volverse "dueño" (CCyCN Art. 1.947) → puede entregar a refugio o devolver. DIM: `Ownership.role='shelter_custody'` con `owner_user_id`.
- **Refugio adopta animal**: refugio → custodia → adopción → transfer Ownership a persona. Refugios nunca son `owner` (Ley 13.879 PBA + práctica nacional).
  - DIM: `custody_transferred` + `adoption_finalized`.
- **Foster**: refugio → asigna fostering a un voluntario con `organization_membership` activa. DIM: `foster_assigned` / `foster_ended`.

### 6.9 Denuncia de maltrato / abandono → decomiso

- Cualquier persona → Fiscalía (Ley nac. 14.346 — penal) o autoridad local (Ley CABA 6173 + 6839 — contravencional). En CABA interviene **UFEMA**.
- Fiscalía / autoridad → decomiso del animal → autoridad de bienestar → refugio (vía `custody_transferred`).
- Sanción + inscripción en **Registro de infractores a la Ley de Maltrato Animal** (Ley CABA 6839/2025).
  - DIM: `maltreatment_reported` / `abandonment_reported` + cadena de `custody_transferred` para reflejar el flujo decomiso→refugio.

### 6.10 Movimiento internacional

- **Egreso**: Owner → Vet matriculado emite CVI nacional → SENASA endosa antes del viaje (Res. 727/2015 + Res. 580/2014). Para MERCOSUR: chip ISO obligatorio (Uruguay), antirrábica ≥21 días pre-viaje, desparasitación 15 días, validez CVI 60 días (Res. GMC 17/15).
- **Ingreso**: Vet del país origen emite CVI → SENASA puesto fronterizo valida (Res. SENASA 76/2019). Reconocimiento UE Pet Passport para ingresos temporales (Reg. UE 576/2013).
  - DIM: `travel_certificate_issued` + `border_crossed`. Útil para diseñar interoperabilidad de la credencial pública DIM con el CVI digital SENASA.

### 6.11 Transporte interno (público y privado)

- **Subte CABA**: Owner → 1 animal por adulto + contenedor + antirrábica vigente. Ley 5687/2016 + Decreto GCBA 31/2017.
- **Larga distancia nacional**: Owner → contenedor + antirrábica + edad ≥4 meses + no raza braquicéfala (excepción asistencia). Res. Transporte 2076/2025.
- **Discapacidad — perro guía/asistencia**: acceso sin contenedor; ANDIS autoridad de aplicación. Ley 26.858/2013 + Decreto 792/2019; Ley PBA 15.409/2022.
  - DIM: campo `assistance_dog: bool` + `antirabies_valid_until` accesible vía credential pública para presentación en transporte.

### 6.12 Habilitación y verificación de organizaciones

- Clínica veterinaria → matrícula vigente (Ley nac. 14.072; DL 9686 PBA) + habilitación edilicia (Ley 10.526 PBA con Decreto 154/89; Ord. 41.831/1987 sección Registro de Profesionales en CABA).
- Refugio / rescue network → personería jurídica + (en CABA) inscripción operativa en Animales BA.
  - DIM: `Organization.verified=true` se ancla en una matrícula/personería verificada por admin DIM. Cruce contra CUIT, matrícula, número de personería.

### 6.13 Paseadores de perros (CABA)

- Paseador → Registro de Paseadores del GCBA (Decreto 1972/2001, mod. por Decreto 344/2018) → máximo 8 perros + edad mínima + residencia + recolección de deyecciones.
  - DIM: rol futuro `dog_walker` en `Ownership` o tabla aparte; v1 fuera de alcance.

### 6.14 Comercialización (pet shops, cría)

- Comercio → no exhibir animales vivos en vidrieras (Ley CABA 6194/2019, modificó Régimen de Faltas Ley 451/2000).
- Cría → prohibida la cría ilegal (Ley CABA 6839/2025); regulada por habilitaciones provinciales/municipales.
- Carreras de perros → prohibidas en todo el país (Ley nac. 27.330/2016).
  - DIM: `pet_registered.payload.acquisition_method` revela tendencia (adoptado vs comprado vs criado).

---

## 7. Información del animal que la ley exige conocer

El esquema mínimo que ninguna "libreta sanitaria" o credencial pública en Argentina puede omitir surge de la intersección de Ord. 41.831, Ley 4078, Ley 14.107, Res. SENASA 580/2014, Res. GMC MERCOSUR 17/15 y Ley CABA 5470. Cuadro por procedimiento:

| Procedimiento | Datos exigidos por la norma | Anclaje |
|---|---|---|
| Inscripción municipal CABA | Nombre, especie, raza, sexo, color, marcas distintivas, fecha de nacimiento (o edad estimada), tatuaje o microchip, datos del propietario (DNI, domicilio). | Ord. 41.831/1987 |
| Inscripción PPP CABA | Todo lo anterior + foto del animal, número de microchip, vacuna antirrábica vigente, número y vencimiento de póliza de seguro RC, comprobante de curso virtual del propietario. | Ley 4078/2012; Res. 93/APRA/2021 |
| Inscripción PPP PBA | Identificación por microchip o tatuaje (obligatoria), datos del propietario, edad <6 meses al registrar. | Ley 14.107/2010 |
| Constancia antirrábica | Fecha de vacunación, marca/lote de la vacuna, veterinario matriculado (matrícula + jurisdicción), especie, sexo, edad, identificación del animal, datos del propietario. | Res. SENASA 580/2014 |
| CVI MERCOSUR (perros y gatos) | Chip ISO 11784/11785 (obligatorio para perros >90 días destino Uruguay); raza, sexo, color, edad; vacuna antirrábica con fecha, lote, marca, validez; desparasitación interna y externa con fecha, principio activo y dosis; examen clínico pre-embarque; datos completos del propietario y del destinatario. | Res. GMC 17/15; Res. SENASA 76/2019 |
| Cremación CABA | Identificación del animal, fecha y causa probable de muerte, datos del propietario, profesional veterinario firmante, plazo ≥24 hs salvo excepción sanitaria, crematorio habilitado. | Ley CABA 5470/2015 |
| Observación antirrábica (mordedura) | Identificación del animal, antirrábica vigente o no, datos del propietario, datos del mordido, fecha y lugar del hecho. | DL 4669/1973 PBA; Ord. 41.831 CABA; Res. MS 1144/2018 |
| Denuncia ENO | Caso clínico, agente etiológico sospechado, especie, edad, sexo, fecha de inicio, lugar geográfico, propietario, vet notificante. | Ley 15.465; Res. MS 1715/2007; Res. CVPBA 05/2020 |
| Patente canina PBA | Identificación, antirrábica del año en curso, propietario; comprobante portado físicamente. | Ley 5664/1952 |
| Receta electrónica veterinaria | Identificación del animal, especie, peso, principio activo, dosis y posología, vet matriculado, propietario. | Res. SENASA 80/2025 |
| Perro guía / asistencia | Certificación de adiestramiento, certificación veterinaria (esterilizado + vacunado + desparasitado), beneficiario humano. | Ley 26.858/2013; Ley PBA 15.409/2022 |

### 7.1 Campos canónicos consolidados (qué espera DIM modelar)

**Identidad del animal**
- Especie (canino / felino — núcleo legal; otras especies aparecen sólo lateralmente)
- Raza, con flag `potentially_dangerous_breed` por jurisdicción (CABA usa lista distinta de PBA)
- Sexo
- Color y marcas distintivas
- Fecha de nacimiento (o edad estimada)
- Identificación electrónica: microchip ISO 11784/11785 (o tatuaje en CABA, aunque en desuso)
- Estado reproductivo: esterilizado sí/no/fecha
- Fotografía actual (legalmente exigida sólo para PPP CABA, pero estándar)

**Eventos sanitarios**
- Antirrábica: fecha, marca, lote, vet matrícula, fecha de próximo vencimiento (anual)
- Otras vacunas (séxtuple canina, triple felina, etc.): no obligatorias por ley pero estándar veterinario
- Desparasitación interna y externa: fecha, principio activo, dosis
- Esterilización: fecha, lugar, profesional, técnica
- Enfermedades / diagnósticos, con flag `eno_reportable` para ENO
- Mordedura inflingida / sufrida + ciclo de observación antirrábica
- Tratamientos farmacológicos, con `senasa_prescription_id` cuando aplica

**Datos jurídicos**
- Flag PPP + estado de inscripción en registro (provincia y/o ciudad)
- Para CABA PPP: número de póliza RC y vencimiento
- Para perro asistencia: certificación + registro provincial/nacional
- Fecha y lugar de muerte, método de disposición, crematorio

**Titular**
- DNI / CUIT (persona humana o jurídica)
- Domicilio (jurisdicción crítica: CABA / PBA / otra determina qué marco normativo aplica)
- Teléfono / canal de contacto
- Para refugios: personería jurídica, CUIT, rol `shelter_custody` (nunca `owner`)

**Transferencia**
- Custodia / adopción / decomiso: fecha, actor cedente, actor receptor, motivo

---

## 8. Obligaciones exigibles por actor

Catálogo de "qué le exige el sistema legal a cada actor", agrupado por rol. Útil para diseñar permisos, formularios y verificaciones en DIM.

### 8.1 Propietarios / tenedores

**Genéricas (todo el país)**
- No incurrir en maltrato ni crueldad. Ley nac. 14.346 — penal, 15 días a 1 año de prisión.
- Tenencia responsable: alimento, agua, refugio, atención veterinaria. Ley CABA 6173/2019 + 6839/2025; Ley PBA 13.879/2008.
- No abandonar al animal. Ley CABA 6173 art. 127; práctica derivada de Ley 13.879 PBA.

**Identificación y registración**
- CABA: inscripción en el Registro Municipal al 4° mes; chip o tatuaje. Ord. 41.831/1987.
- PBA: patente canina anual con antirrábica asociada. Ley 5664/1952.
- PBA PPP: chip o tatuaje + Registro Prov. 14.107 antes de los 6 meses.
- CABA PPP: Registro 4078 antes de los 3 meses + póliza de seguro RC vigente + curso virtual + foto + chip + renovación anual + notificación de incidentes <48 hs.

**Vacunación**
- Antirrábica obligatoria desde 3 meses, anual, con constancia en poder del propietario. Ley nac. 22.953; Res. SENASA 580/2014; DL 8056/1973 PBA; Ord. 41.831 CABA.

**Vía pública**
- Correa obligatoria. Ley CABA 5471/2015 + DL provincial.
- Recolección de deyecciones. Ley CABA 5471.
- PPP CABA: bozal + correa <2 m.
- PPP PBA: bozal + correa <1 m + collar.

**Transporte**
- Subte CABA: contenedor + antirrábica + 1 mascota por adulto. Ley 5687/2016.
- Larga distancia nacional (micro/tren/avión nacional): contenedor, antirrábica, edad ≥4 meses, exclusión de braquicéfalos. Res. 2076/2025.
- Internacional: CVI vigente. Res. GMC 17/15 + nacional Res. 580/2014, 76/2019, 727/2015.

**Mordedura**
- Someter al animal a observación antirrábica de 10 días.
- Notificación a autoridad sanitaria.

**Muerte / cremación (CABA)**
- Plazo ≥24 hs (excepto infectocontagiosa) + certificado veterinario + crematorio habilitado. Ley 5470/2015.

**Comerciales / actividades prohibidas**
- Carreras de perros prohibidas a nivel nacional. Ley 27.330/2016.
- Cría ilegal en CABA. Ley 6839/2025.

**Discapacidad**
- Garantizar acceso del perro guía/asistencia si lo posee. Ley nac. 26.858; Ley PBA 15.409.

**Sanciones aplicables al propietario**
- Penal: prisión 15 días a 1 año (Ley 14.346); 3 meses a 4 años + multa (Ley 27.330, carreras de perros).
- Contravencional CABA (Huellas): multas hasta $8M, trabajo comunitario hasta 60 días, arresto en casos graves, inscripción en Registro de Infractores.
- Faltas CABA: multas + decomiso + clausura comercial.
- Tránsito: retención del animal si circula suelto (Ley 24.449).

### 8.2 Organizaciones (clínicas, refugios, redes, crematorios, paseadores, pet shops, transportistas)

**Veterinarios y clínicas**
- Matrícula vigente. Ley nac. 14.072/1951 (CABA + jurisdicción federal); DL 9686/1981 PBA + Dec. 1420/83 (CVPBA).
- Habilitación edilicia y de actividad. Ley PBA 10.526/1987 + Dec. 154/1989; en CABA bajo Ord. 41.831.
- BPM si elabora productos veterinarios. Res. SENASA 416/2024.
- Receta electrónica para antibióticos críticos (fosfomicina, polimixina B). Res. SENASA 80/2025.
- Asentar antirrábica en formulario oficial SENASA. Res. 580/2014.
- Emitir CVI nacional para traslados. Res. 580/2014, 727/2015, 76/2019.
- Notificar ENO en <24 hs. Ley nac. 15.465; Ley PBA 5325; Res. CVPBA 05/2020.
- Documentar productos veterinarios. Dec. 583/67; Res. SENASA 11/2025.
- Bioterios: BPM y principio 3R. Disp. ANMAT 9236/2023.

**Refugios y redes de rescate**
- Personería jurídica para operar formalmente.
- No actuar como "dueños" — custodia temporal pendiente adopción (CCyCN Art. 1.947 + Ley 13.879 + práctica).
- Tenencia responsable de cada animal bajo custodia. Ley 13.879 + Ley nac. 14.346.
- No exhibición vidrieras (CABA). Ley 6194/2019.
- No cría ilegal (CABA). Ley 6839/2025.
- Inscripción operativa en Animales BA (CABA, no normativa pero exigida en programas públicos).

**Crematorios**
- Habilitación municipal. Ley CABA 5470/2015.
- Asiento en Registro de Cremaciones GCBA.
- Plazo mínimo 24 hs salvo excepciones sanitarias.

**Paseadores de perros (CABA)**
- Máximo 8 perros simultáneos. Decreto 1972/2001 mod. 344/2018.
- Recolección de deyecciones.
- Edad mínima y residencia.

**Pet shops**
- No exhibir animales vivos en vidrieras con fines de venta o publicidad. Ley CABA 6194/2019.
- Habilitación municipal estándar.

**Empresas de transporte**
- Aceptación de contenedores conforme Res. 2076/2025 (nacional) y Ley CABA 5687 (subte).
- Excepción y acceso obligatorio para perros guía/asistencia. Ley 26.858; Ley PBA 15.409.

### 8.3 Oficinas gubernamentales

**SENASA (federal)**
- Mantener Registro Nacional de Productos Veterinarios. Dec. 583/67; Res. 11/2025.
- Emitir/endosar CVI internacional. Res. 76/2019, 580/2014, 727/2015.
- Internalizar resoluciones GMC MERCOSUR. Res. GMC 17/15.
- Sanidad fronteriza para ingreso de mascotas.
- Operar el sistema de receta electrónica veterinaria. Res. 80/2025.
- Vigilancia zoonosis a nivel federal (One Health MoU).

**Ministerio de Salud de la Nación**
- Coordinar Programa Nacional de Control de Enfermedades Zoonóticas. Res. 1811/2011.
- Mantener Guía Nacional de Rabia. Res. 1144/2018.
- Recibir notificaciones ENO. Ley 15.465; Res. 1715/2007.
- Producir/distribuir antirrábica humana postexposición.

**Ministerio de Salud PBA**
- Autoridad de aplicación de Ley 13.879. Decreto 400/2011.
- Operar dispensarios antirrábicos provinciales y articular con municipales. DL 8056/1973.
- Profilaxis zoonosis provincial. Ley 6115/1959.
- Recibir denuncias ENO provinciales. Ley 5325/1948.

**Ministerio de Asuntos Agrarios PBA**
- Autoridad de aplicación de Ley 10.526 (habilitación de establecimientos veterinarios).

**Colegio de Veterinarios PBA (CVPBA)**
- Matriculación y régimen ético-disciplinario. DL 9686/1981; Decreto 1420/1983.
- Difusión y reglamentación de ENO en pequeños animales. Res. CVPBA 05/2020.

**Consejo Profesional de Médicos Veterinarios (CPMV — CABA)**
- Matriculación de veterinarios en jurisdicción nacional / CABA. Ley nac. 14.072.

**APrA (Agencia de Protección Ambiental, CABA)**
- Autoridad de aplicación de Leyes 1338, 4078, 4351, 5346. Decreto 231/2013; Res. 93/APRA/2021.
- Mantener Registro de Propietarios de Perros Potencialmente Peligrosos. Ley 4078.
- Operar CAV y CMAV, al menos uno por Comuna. Ley 4351.
- Operar plataforma Animales BA / Mascotas BA.

**Instituto de Zoonosis Luis Pasteur (CABA)**
- Diagnóstico de zoonosis urbana, producción de antirrábica, observación de mordedores, vigilancia epidemiológica. Decreto GCBA 5334/1988.

**Municipios PBA**
- Patente canina anual. Ley 5664.
- Operar dispensarios antirrábicos. DL 8056/1973.
- Esterilización gratuita. Ley 13.879.
- Operar delegaciones del Registro Provincial PPP. Ley 14.107.
- Ordenanzas propias (La Plata 12.145; Mar del Plata 22.031; otras).

**UFEMA (Unidad Fiscal Especializada en Materia Ambiental, CABA)**
- Persecución penal de Ley nac. 14.346 en CABA.

**Ministerio Público Fiscal nacional**
- Persecución penal de Ley 14.346 en el resto del país.

**ANDIS (Agencia Nacional de Discapacidad)**
- Autoridad de aplicación de Ley 26.858 (perros guía/asistencia). Decreto 792/2019.

**ANMAT**
- Regulación de bioterios. Disp. 9236/2023.

**Cancillería Argentina**
- Coordinación de internalización de tratados (CITES, CMS, CBD, MERCOSUR, OMC, OMS, WOAH).

**Compromisos internacionales que el Estado debe cumplir**
- Notificación de enfermedades del Terrestrial Code a WOAH (membresía vía Ley 11.632/1932).
- Notificación PHEIC a OMS bajo IHR 2005.
- Armonización SPS con WOAH/Codex/IPPC (Ley 24.425/1994).

---

## 9. Implicancias de diseño para DIM (síntesis transversal)

Cruzando los §6–§8 con el modelo de eventos descripto en `AGENTS.md`:

- **`Organization.verified`** se ancla en (a) matrícula vigente para clínicas, (b) personería jurídica para refugios, (c) habilitación CAV/CMAV para clínicas públicas — distintas pruebas por `org_type`.
- **`Pet`** necesita: jurisdicción explícita (`AR-C` vs `AR-B` cambia el registro PPP aplicable), chip ISO obligatorio para PPP en PBA, foto + póliza para PPP en CABA.
- **Eventos** que la ley *exige* trazar (no son opcionales si DIM se toma en serio el rol de libreta oficial): `pet_registered`, `microchip_implanted`, `antirabies_vaccinated` (con vencimiento), `sterilization_performed`, `bite_inflicted` + `rabies_observation_*`, `death_recorded` + `disposition_method`, `dangerous_breed_attested`, `custody_transferred`, `adoption_finalized`, `disease_diagnosed` con flag ENO, `travel_certificate_issued`, `maltreatment_reported` / `abandonment_reported`.
- **Constancia digital legalmente útil**: la credencial pública debe mostrar al menos chip, antirrábica vigente, PPP flag, esterilización y datos del titular — porque eso es lo que pide ver cualquier organismo o transporte.
- **Interoperabilidad futura**: receta electrónica SENASA (Res. 80/2025), CVI digital SENASA, Animales BA (CABA), Registro PPP de cada jurisdicción.

---

*Fuentes principales:* InfoLEG, SAIJ, SENASA Digesto, Boletín Oficial de la Nación, Normas PBA, Boletín Oficial CABA, CEDOM, Cancillería Argentina, WOAH, MERCOSUR Normas. Última verificación general: 18 de mayo de 2026.
