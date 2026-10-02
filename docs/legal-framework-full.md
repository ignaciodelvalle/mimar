# Marco legal completo — DIM

> Inventario exhaustivo de leyes, decretos, resoluciones, tratados y estándares internacionales argentinos vigentes (mayo 2026) que tocan a perros, gatos y otros animales de compañía. Complementa la tabla resumen de `AGENTS.md → Legal framework`. Cuando una norma tiene implicancia directa sobre el modelo de datos o sobre un evento del Libreta, se anota como **DIM:**.
>
> Estructura: **Nacional → Provincia de Buenos Aires → CABA → Internacional**. Dentro de cada jurisdicción, por categoría temática.
>
> Última verificación: 2026-05-18. **Erratas de la revisión legal de octubre de 2026 aplicadas el 2026-10-02** (E1 a E24): cada corrección lleva su fuente entre paréntesis. Lo que esa revisión no pudo leer en el texto oficial queda marcado **(a confirmar)** y no se usa como fundamento de nada en el producto.

---

## 1. NACIONAL (federal)

### 1.1 Bienestar animal / crueldad

- **Ley 14.346 / 1954** — Malos tratos y actos de crueldad contra los animales. Tipifica penalmente actos de maltrato (Art. 1) y crueldad (Art. 3); pena de 15 días a 1 año de prisión. **No tipifica el abandono de animales de compañía:** solo menciona el abandono de animales de experimentación (art. 3 inc. 5). *(Corregido 2026-10: se quitó el apodo "Ley Sarmiento/Benítez"; "Ley Sarmiento" designa a la Ley 2.786 de 1891, su antecedente — fuente: fundamentos del Expte. HCDN 5273-D-2019.)* [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-14346-153011/texto)
  - **DIM:** `maltreatment_reported.payload` debería poder anclarse a un eventual circuito de denuncia 14.346.

- **Ley 27.330 / 2016** — Prohibición de carreras de perros en todo el territorio nacional. Pena de 3 meses a 4 años + multa. Complementaria del Código Penal. Promulgada por Decreto 1221/2016. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-27330-268503/texto)

- **Decreto 1221 / 2016** — Promulga la Ley 27.330. [Fuente](https://leyesargentinas.com/norma/268505/decreto-1221-carreras-de-perros-ley-n-27-330-promulgacion)

### 1.2 Zoonosis y salud pública

- **Ley 22.953 / 1983** — Lucha antirrábica. Declara de interés nacional la lucha contra la rabia transmitida por perros y gatos; base legal de las campañas antirrábicas. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-22953-184650)
  - **DIM:** ancla legal de `antirabies_vaccinated`. La edad mínima y la frecuencia anual de la vacuna las fijan normas provinciales y municipales (DL 8056/73 en PBA, Ord. 41.831 en CABA); atribuirlas a esta ley queda **(a confirmar)**.

- **Ley 12.732 / 1941** — Profilaxis de la hidatidosis (equinococosis). Zoonosis con reservorio canino. [Fuente](https://argentina.gob.ar/normativa/nacional/ley-12732-196049/texto)

- **Ley 11.843 / 1934** — Profilaxis de la peste / exterminio de roedores. Reglamentada por Decreto 92.767. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-11843-195173/texto)

- **Ley 15.465 / 1960** — Régimen legal de enfermedades de notificación obligatoria. Reglamentada por Decreto 3640/1964. Incluye rabia, hidatidosis, leptospirosis, leishmaniasis, brucelosis. [Fuente](https://www.argentina.gob.ar/normativa/nacional/ley-15465-195093/texto)
  - Obliga por **casos humanos**. Su Manual ENO (Res. MS 2827/2022) lista el carbunco cutáneo y extracutáneo y la toxoplasmosis congénita y en embarazadas, siempre como eventos humanos: no hace notificable a un perro o gato con esas enfermedades. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/425000-429999/425539/disp1-anexo2.pdf)

- **Resolución SENASA 153 / 2021** — Enfermedades de denuncia obligatoria del lado animal. **Grupo I** ("enfermedades comunes a varias especies", entre ellas el carbunco): notificación inmediata, dentro de las 24 h de la sospecha, a SENASA; rige para cualquier especie. **Grupo II**: notificación según la norma específica de cada enfermedad (ahí figura la tuberculosis, sin plazo en horas). Su art. 22 **deroga la Res. SENASA 422/2003**. [Fuente](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-153-2021-348400/texto) · [Boletín Oficial](https://www.boletinoficial.gob.ar/detalleAviso/primera/242544/20210331)
  - **DIM:** ancla del carbunco en el catálogo ENO (24 h, destino SENASA, sólo lo dispara un veterinario o un laboratorio). La toxoplasmosis no figura en ningún grupo y dejó de marcarse como notificable. Ningún código cita ya la 422/2003.

- **Resolución MS 1715 / 2007** — Normas de vigilancia y control de ENO; lista oficial de eventos. Modificada por Res. MS 54/2008, 2827/2022 y 3517/2022. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/175000-179999/175879/norma.htm)

- **Resolución MS 1144 / 2018** — Guía de Prevención, Vigilancia y Control de la Rabia en Argentina. Define APR (atención post-exposición), profilaxis y técnicas diagnósticas. [Fuente](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-1144-2018-311546/texto)

- **Resolución MS 1811 / 2011** — Programa Nacional de Control de Enfermedades Zoonóticas (hidatidosis, triquinosis, hantavirus, leishmaniasis visceral, psitacosis). [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/185000-189999/189688/norma.htm)

- **Resolución MS 546 / 1985** — Manual de procedimientos de control de hidatidosis. **(a confirmar)**: la revisión de 2026-10 no encontró su texto en ninguna fuente oficial. No se usa como fuente de un plazo de notificación. [Fuente](http://www.legisalud.gov.ar/atlas/categorias/zoonosis.html)

- **Disposición DE-MSAL 1 / 2026** — Sustituye los anexos I y II de la Res. MSAL 2827/2022 (Manual de normas y procedimientos de vigilancia de ENO). Define la periodicidad: **inmediata** = dentro de las 24 h de la atención del caso; **semanal** = dentro de los 7 días. Obliga también a los médicos veterinarios que participan en la detección o seguimiento de una ENO. *(Agregado 2026-10; fuente: InfoLEG 425539.)* [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=425539) · [Anexo II](https://servicios.infoleg.gob.ar/infolegInternet/anexos/425000-429999/425539/disp1-anexo2.pdf)
  - **DIM:** es el ancla del número "24 h" del catálogo ENO. Brucelosis, leptospirosis y leishmaniasis canina figuran como **semanales**; la hidatidosis también (evento humano; falta confirmar si cubre el hallazgo canino).

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

- **Res. SENASA 654 / 2026** (BO 21/07/2026) — Crea el SIGTRAZAVET y extiende la Receta Electrónica Veterinaria a los **animales de compañía** (art. 17), según los principios activos que vaya incorporando la Dirección Nacional de Sanidad Animal (esa disposición no se halló). Tipo "Prescripción en mascotas" con nombre y DNI del titular (art. 18 d) y código CUVE (art. 18 e). Permite usar el botiquín sin receta electrónica si se lleva una **ficha clínica** (art. 20). **No deroga** la Res. 80/2025. *(Agregado 2026-10; verificado en el Boletín Oficial.)* [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/344632/20260721)
  - **DIM:** miMAR no emite recetas ni es la ficha clínica del art. 20. Una receta en la libreta solo puede ser una **referencia** a la emitida en SENASA (CUVE, fecha, principio activo, vigencia), sin copiar el DNI del titular.

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

- **Res. SENASA 580 / 2014** — Exime a los **animales de servicio o asistencia** del cobro de servicios extraordinarios en el ingreso, egreso o tránsito; exige documentación que identifique al animal y su función, y el certificado de discapacidad. **No regula** la documentación general de traslado ni ningún formulario antirrábico. *(Corregido 2026-10; fuente: InfoLEG 239892.)* [Fuente](http://servicios.infoleg.gob.ar/infolegInternet/anexos/235000-239999/239892/norma.htm)
  - **DIM:** no es ancla de la constancia antirrábica ni del CVI. Para el traslado interno, la referencia es la página de SENASA "Traslados de perros y/o gatos dentro de Argentina" y la Res. MEcon 2076/2025, Anexo, art. 4.

- **Res. ex-SENASA 1354 / 1994** — Requisitos para ingreso de perros y gatos a Argentina; CVI traducido. [Fuente](http://www.senasa.gob.ar/normativas/resolucion-1354-1994-senasa-servicio-nacional-de-sanidad-y-calidad-agroalimentaria)

- **Res. ex-SAGPyA 709 / 1997** — Complementa Res. 1354/1994. [Fuente](https://www.argentina.gob.ar/senasa/informacion-al-viajero/ingresar-o-regresar-al-pais/ingresos-con-perros-yo-gatos)

- **Res. SENASA 76 / 2019** — Procedimiento para ingreso definitivo de caninos y felinos. Certificación antirrábica >3 meses, 30 días antes del ingreso. [Fuente](http://www.senasa.gob.ar/normativas/resolucion-76-2019-senasa-servicio-nacional-de-sanidad-y-calidad-agroalimentaria)

- **Res. MAGyP 727 / 2015** — Incorpora la Res. GMC 17/2015: requisitos de **ingreso** de perros y gatos entre los Estados del Mercosur, que en espejo rigen los viajes de la Argentina a Brasil, Paraguay y Uruguay (CVI de la autoridad del país exportador, válido 60 días; examen clínico dentro de los 10 días previos). El egreso a otros destinos sigue los requisitos de cada país, certificados por SENASA (Res. ex-SENASA 1353/1994). *(Corregido 2026-10; fuente: InfoLEG 253664.)* [Fuente](https://www.ecofield.net/Legales/Sanidad_vegetal/res727-15_MAGyP.htm)

- **Res. SENASA 923 / 2019** — Trámites urgentes y fuera de horario en SENASA (mascotas incluidas). **(a confirmar)** si sigue vigente: las modalidades de urgencia vigentes son las de la Res. SENASA 440/2026 (que derogó la 453/2024), con base en la Res. SAGyP 54/2026. [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/212974/20190806)

- **Res. Ministerio de Economía 2076 / 2025** (BO 23/12/2025) — Autoriza el traslado de animales domésticos en **ómnibus y trenes de larga distancia** de jurisdicción nacional. Anexo, art. 4: portar la constancia antirrábica; art. 5: un animal por pasajero adulto; art. 7: cada empresa fija las restricciones de especie, raza, peso y tamaño. *(Corregido 2026-10; organismo y alcance verificados en el Boletín Oficial. Se quitaron "aviones", "mínimo 4 meses" y "excluye braquicéfalas": el cuerpo de la norma no los menciona; **(a confirmar)** en el anexo.)* [Fuente](https://www.boletinoficial.gob.ar/detalleAviso/primera/336643/20251223)

- **Res. SENASA 284 / 2024** — Identificación electrónica animal (microchips ISO 11784/11785). Foco en équidos pero estándar técnico de referencia. No crea una obligación de identificar perros y gatos: **no hay una obligación nacional general de microchip**; en PBA, los perros potencialmente peligrosos deben identificarse con chip **o** tatuaje (Ley 14.107, art. 8 b), y algunos municipios lo exigen por ordenanza. [Fuente](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-284-2024-398615/texto)
  - **DIM:** estándar ISO 11784/11785 es el que debe leer la app para `microchip_implanted.payload.iso_id`.

- **Ley 24.449 / 1994** — Ley Nacional de Tránsito. Prohíbe animales sueltos en la vía pública; requisitos de transporte. [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/0-4999/818/texact.htm)

### 1.5 Código Civil y Comercial — estatuto jurídico del animal

- **Ley 26.994 / 2014 — Código Civil y Comercial de la Nación**. Vigente desde 1/8/2015. Animales como "cosas muebles" (semovientes). [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=235975)

- **CCyCN Art. 227** — Cosas muebles. [Fuente](https://leyfacil.com.ar/codigo-civil-y-comercial/articulo-227/)

- **CCyCN Art. 1.947** — Apropiación. Los animales domésticos y domesticados NO son susceptibles de apropiación aunque escapen. [Fuente](https://codigocivilonline.com.ar/articulo-1947/)
  - **DIM:** clave para el caso "vecino encuentra perro en la calle" → no se vuelve dueño por apropiación. **(a confirmar en la edición oficial del CCyC):** el art. 1955 haría al hallador que toma la cosa depositario, obligado a restituirla o a entregarla a la policía, que da intervención al juez; el dueño puede reclamar (arts. 1955 y 1956). Que el modelo use la custodia y no la titularidad es una decisión de miMAR, no una regla que imponga el art. 1947.

- **CCyCN Art. 1.948** — Caza; animal salvaje o domesticado que recobra libertad. [Fuente](https://codigocivilonline.com.ar/etiquetas/articulo-1948/)

- **CCyCN Art. 1.759** — Daño causado por animales (responsabilidad objetiva). [Fuente](http://universojus.com/codigo-civil-comercial-comentado/articulo-1759)
  - **DIM:** justifica la centralidad del dato `potentially_dangerous_breed` y la atestación.

- **CCyCN Art. 1.757** — Hecho de las cosas y actividades riesgosas. [Fuente](https://www.rpba.gob.ar/files/Normas/Leyes/CCCN1757-1759.pdf)

- **Ley 26.944 / 2014** — Responsabilidad del Estado. La Ciudad de Buenos Aires tiene ley propia, la **Ley CABA 6.325** (2020), con el mismo estándar de "deber expreso y determinado" (art. 2 inc. d). Que la Provincia de Buenos Aires no adhirió es **(a confirmar)**. *(Agregado 2026-10.)* [Ley CABA 6.325](https://documentosboletinoficial.buenosaires.gob.ar/publico/ck_PL-LEY-LCABA-LCBA-6325-20-5957.pdf)

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
- **Proyecto de reforma integral de protección de datos personales** (Exp. 3397-D-2026, reingresado el 16/07/2026) — En etapa temprana; no cambia obligaciones vigentes. [Fuente](https://www.argentina.gob.ar/aaip/datospersonales/proyecto-ley-datos-personales)
- **Proyectos de microchip nacional obligatorio** — Diversos, sin sanción a la fecha. [Fuente](https://www.infobae.com/tendencias/2022/04/14/caba-proponen-colocar-un-microchip-en-perros-y-gatos-para-su-cuidado-responsable/)

### 1.8 Datos personales (AAIP)

- **Ley 25.326, art. 21** — Inscripción de las bases de datos en el Registro Nacional de la AAIP. Alcanza a bases públicas y privadas destinadas a dar información sobre personas; la única exención es el uso exclusivamente personal, sin excepción por tamaño ni por ser persona humana. [Trámites](https://www.argentina.gob.ar/aaip/datospersonales/tramites)
  - **DIM:** el registro muestra datos de terceros (página del QR, autoridad, veterinaria), así que la exención no aplica. La política de privacidad no debe decir "inscripta" hasta contar con el certificado.
- **Transferencia internacional** — Hay transferencia a Brasil (Supabase; funciones de Vercel) y a Estados Unidos (Vercel Inc., Sentry, Expo, Google FCM, Resend), ninguno con nivel de protección adecuado, y al Reino Unido (OpenStreetMap), que sí lo tiene. La lista está en la **Disp. DNPDP 60-E/2016, art. 3** (texto según Res. AAIP 34/2019). Cláusulas modelo: los Anexos I y II de la 60-E/2016 y las de la Red Iberoamericana (Res. AAIP 198/2023), que coexisten; usadas tal cual no requieren aprobación. Un contrato que se aparta del modelo debe **someterse a aprobación** de la AAIP dentro de los 30 días corridos (Disp. 60-E/2016, art. 2). La alternativa es el consentimiento expreso (Dec. 1558/2001, art. 12). *(Corregido 2026-10: la disposición la dictó la Dirección Nacional, no la AAIP, y el plazo de 30 días es para pedir la aprobación; Disp. 60-E/2016 verificada en InfoLEG.)* [Fuente](https://www.argentina.gob.ar/transferencias-internacionales)
  - **DIM:** la infraestructura corre en São Paulo: las transferencias a esos proveedores necesitan ese mecanismo.
- **Res. AAIP 47/2018** — Medidas de seguridad recomendadas para el tratamiento de datos personales; se declaran en la inscripción de la base. [Trámites](https://www.argentina.gob.ar/aaip/datospersonales/tramites)
- **Res. AAIP 14/2018, arts. 2 y 3** — Obliga a exhibir la información del art. 6 de la Ley 25.326 antes de recolectar datos y a incluir una **leyenda textual** sobre la AAIP como órgano de control. *(Agregado 2026-10; verificado en InfoLEG.)* [Fuente](https://servicios.infoleg.gob.ar/infolegInternet/anexos/305000-309999/307621/norma.htm)
  - **DIM:** la leyenda está en `/privacidad`, sección "Tus derechos", copiada textual.
- **Res. AAIP 4/2019, Anexo I** — Criterios orientadores: el Criterio 3 trata la disociación (cuándo una persona no es determinable); el Criterio 5, el consentimiento de los menores de edad según su autonomía progresiva. [Anexo](https://servicios.infoleg.gob.ar/infolegInternet/anexos/315000-319999/318874/res4AAIP.pdf)
- **Ley 27.483** (Convenio 108 y su Protocolo Adicional, vigentes) y **Ley 27.699** (Protocolo que modifica el Convenio 108, "108+"; ratificado y todavía no vigente en el plano internacional). [Ley 27.699](https://www.argentina.gob.ar/normativa/nacional/ley-27699-375738/texto)
- **Ley 27.275** (acceso a la información pública) — **No alcanza a miMAR:** un operador privado no es sujeto obligado (art. 7). Los datos abiertos de miMAR son voluntarios y se apoyan en la disociación (Ley 25.326, arts. 2 y 11 inc. 3.e). *(Agregado 2026-10.)*
- **Disp. SSCyDC 377/2026** (BO 11/03/2026) — Sustituye el anexo de la Res. 53/2003 y declara abusivas, entre otras, la modificación unilateral de las condiciones (inc. b), la limitación de responsabilidad (inc. g) y la aceptación "por la simple navegación" (inc. p). *(Agregado 2026-10; verificado.)* [Fuente](https://www.argentina.gob.ar/normativa/nacional/disposici%C3%B3n-377-2026-423801/texto)
- **Dec. PBA 961/2026** — Marco Provincial de Gobernanza de Datos: crea el Registro de Bases de Datos de la Provincia, obligatorio para la administración provincial (art. 4), e invita a los municipios a adherir (art. 5). Su anexo no se leyó. *(Agregado 2026-10; verificado.)* [Fuente](https://normas.gba.gob.ar/documentos/0Z7XeYFE.html)
- **Ley CABA 1845** — Protección de datos personales en el sector público de la Ciudad de Buenos Aires. *(Agregado 2026-10.)*

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

- **Ley 6115 / 1959** — Profilaxis de la **brucelosis**. Su art. 9 encarga a una comisión extender la profilaxis a otras zoonosis, entre ellas la hidatidosis. **No fija un deber de denuncia ni un plazo.** *(Corregido 2026-10; leída en normas.gba.)* [Fuente](https://normas.gba.gob.ar/documentos/0vGaATex.html)

- **Manual de notificación de ENO en pequeños animales del CVPBA (actualización 05/2020)** — No es una resolución: es un manual del Colegio que remite a la Res. CVPBA 44/2016. *(Corregido 2026-10; fuente: cvpba.org.)* Enfermedades de denuncia obligatoria en pequeños animales: brucelosis canina, clamidiosis aviar, dirofilariosis, esporotricosis, leishmaniasis visceral canina, leptospirosis canina, micobacteriosis en pequeños animales (tuberculosis), rabia animal y SARS-CoV-2 (sospecha clínica). **Plazo único para toda la lista:** el profesional informa "de forma inmediata". **Canal:** formulario web o planilla al Centro de Zoonosis municipal, que sigue a Zoonosis Urbanas (Ministerio de Salud PBA) y al SNVS 2.0. **Alcance:** obliga a los matriculados de PBA; no rige en CABA ni en otras provincias. Vigente según la página ENO del Colegio. [Fuente](https://cvpba.org/wp-content/uploads/2022/03/ENO-05-2020-1.pdf) · [cvpba.org/eno](https://cvpba.org/eno/)
  - **DIM:** "inmediata" se toma como **24 h** en el catálogo ENO. El número se ancla en el Manual nacional (Disp. DE-MSAL 1/2026: inmediata = 24 h desde la atención), no en este manual, que no define horas; coincide con SENASA 153/2021 Grupo I y la Ley PBA 5325. Fuera de PBA el plazo queda marcado "a confirmar". Esporotricosis y dirofilariosis entraron al catálogo; la clamidiosis aviar queda fuera de alcance porque el registro no toma aves; SARS-CoV-2 no se incorporó hasta confirmar su vigencia. La hidatidosis no está en esta lista: en el Manual nacional 2026 es un evento **semanal** (7 días). Ni la Res. MS 546/85 (a confirmar) ni la Ley PBA 6115 fijan un plazo.

### 2.3 Ejercicio veterinario

- **Decreto-Ley 9686 / 1981** — Régimen del Colegio de Veterinarios de la PBA (CVPBA) y ejercicio profesional. [Fuente](https://normas.gba.gob.ar/documentos/VJ9qrfJB.html)

- **Decreto 1420 / 1983** — Reglamenta el DL 9686 (matrícula, ética, organización). [Fuente](https://normas.gba.gob.ar/ar-b/decreto/1983/1420/155146)

- **Ley 10.526 / 1987** — Establecimientos donde se ejerce la medicina veterinaria. Condiciones edilicias, venta de zooterápicos, depósitos, locales de venta de animales. [Fuente](https://normas.gba.gob.ar/documentos/xq98GIpx.html)

- **Decreto 154 / 1989** (mod. Decreto 1546/1992) — Reglamenta Ley 10.526. Arts. 12 y 16: las **clínicas, hospitales y sanatorios** veterinarios (no los consultorios) llevan un registro **foliado y rubricado** de historias clínicas; el art. 40 delega el plazo de conservación en la Dirección de Ganadería (no se halló esa norma). *(Ampliado 2026-10; verificado en normas.gba.)* [Fuente](https://normas.gba.gob.ar/documentos/0zQGbwT8.html)
  - **DIM:** la libreta de miMAR no es ese registro rubricado ni lo reemplaza.

- **Decreto 1420 / 1983, arts. 44-45 y 66** — Receta con firma y sello; despacho contra receta (arts. 44-45). El art. 66 prohíbe delegar actos profesionales. *(Agregado 2026-10.)*

- **Decreto-Ley 9686 / 1981, art. 84** — Los certificados del art. 78 inc. 8 se extienden en formularios del Colegio. **(a confirmar con el CVPBA):** SENASA acepta certificados en cualquier formato con firma y sello, y el Colegio llama "orientativos" a sus modelos; nadie reconcilió las dos cosas.

### 2.4 Específico de animales de compañía

- **Ley 14.107 / 2010** — Régimen de tenencia de perros potencialmente peligrosos. Registro Provincial con delegaciones municipales; inscripción <6 meses; identificación por chip **o** tatuaje (art. 8 b); correa <1 m; bozal y collar; prohíbe el abandono de estos perros (art. 8 f). Lista de razas en Anexo I. No se halló reglamentación ni autoridad de aplicación designada (art. 13). *(Corregido 2026-10.)* [Fuente](https://normas.gba.gob.ar/documentos/0PNzEIAB.html)
  - **DIM:** matriz canónica de `potentially_dangerous_breed=true` para residentes en PBA. La identificación se cumple con `microchip_implanted` **o** con `tattoo_registered`.

- **Ley 13.879 / 2008** — (También en 2.1.) Prohíbe el sacrificio de perros y gatos en dependencias oficiales (art. 1), fija la esterilización quirúrgica como único método de control poblacional (art. 3) y declara obligatorio el tratamiento antiparasitario (art. 4). **No impone deberes de tenencia a los dueños:** su reglamento (Dec. 400/2011, Anexo, art. 5) define la "tenencia responsable" solo como contenido de campañas. *(Corregido 2026-10.)* [Fuente](https://normas.gba.gob.ar/documentos/BK86vtoV.html)

- **Ley 15.409 / 2022** — Perros de asistencia para personas con discapacidad. Crea Registro Provincial. [Fuente](https://normas.gba.gob.ar/documentos/xq9nMXCp.html)

### 2.5 Ordenanzas municipales notables

- **Ordenanza La Plata 12.145 / 2021** — Municipio "no eutanásico"; crea el CMSAZ; esterilización gratuita, masiva, extendida y temprana. [Fuente](https://sibom.slyt.gba.gob.ar/bulletins/6358/contents/1658236)

- **Ordenanza Gral. Pueyrredon (Mar del Plata) 22.031** — Reglamento de tenencia responsable de mascotas; esterilización como único método. [Fuente](https://www.mardelplata.gob.ar/documentos/salud/ord%20%2022031.pdf)

---

## 3. CABA

### 3.1 Bienestar animal / crueldad

- **Ley CABA 6173 / 2019** — Protección y cuidado de animales domésticos. Incorpora Título VI Libro II del Código Contravencional (Ley 1472): tipifica omisión de cuidados (Art. 126), abandono (Art. 127), instalaciones inadecuadas, hostigamiento. *(Nota 2026-10: el abandono, incorporado como art. 127 por esta ley, es hoy el **art. 141** del Código Contravencional, texto según Ley 6.839; no se identificó la ley de consolidación que renumeró.)* [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/479417)

- **Ley CABA 6839 / 2025** (BO 20/10/2025) — Modifica el Código Contravencional: reescribe los arts. 140 a 143 e incorpora el 142 bis y el 143 bis (animal encerrado en vehículo, cría ilegal). **Abandono (art. 141):** 60 a 90 días de trabajo de utilidad pública, o multa de 3.000 a 5.000 unidades fijas, o 15 a 30 días de arresto. Crea el "Registro de infractores a la Ley de Maltrato Animal" dentro del Registro de Contravenciones. Prescripción de la acción contravencional: 18 meses (art. 43 del Código). *(Corregido 2026-10: las multas se fijan en unidades fijas, no en pesos; el abandono tiene 60 a 90 días, no "hasta 60"; se quitó el apodo "Ley Huellas", que no figura en ninguna fuente oficial.)* [Fuente](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/819902) · [Texto](https://documentosboletinoficial.buenosaires.gob.ar/publico/ck_PL-LEY-LCABA-LCBA-6839-25-7228.pdf)
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

1. **Identificación canina** — el estándar técnico de microchip es ISO 11784/11785 (Res. SENASA 284/2024 + WOAH Cap. 7.7 + Res. GMC 17/15). Para residentes en PBA, las razas listadas en la Ley 14.107 deben identificarse con chip **o** tatuaje (art. 8 b); en CABA, la Ordenanza 41.831 admite tatuaje o microchip; a nivel nacional aún no hay obligatoriedad universal.

2. **Vacunación antirrábica** — obligatoria desde los 3 meses, anual; ancla: Ley nac. 22.953 + Res. MS 1144/2018 + DL 8056/73 (PBA) + Ord. 41.831 (CABA). *(2026-10: se quitó la Res. SENASA 580/2014, que trata de animales de asistencia.)*

3. **Perros potencialmente peligrosos** — doble régimen: Ley 14.107 (PBA, registro provincial) y Ley 4078 (CABA, registro local + seguro RC). DIM debe modelar ambos.

4. **Esterilización** — política pública nacional (Decreto 1088/2011), provincial (Ley 13.879 PBA) y local (Leyes 1338 y 4351 CABA con CAV/CMAV).

5. **Cremación** — Ley CABA 5470/2015 es la única jurisdicción que la regula explícitamente. `death_recorded.payload.disposition_method` debe poder anclar a esta norma.

6. **Movimiento internacional** — Res. GMC MERCOSUR 17/15, incorporada por la Res. MAGyP 727/2015 (ingreso entre Estados del Mercosur, en espejo para los viajes a BR, PY y UY) + Res. SENASA 76/2019 (ingreso) + requisitos de cada destino, certificados por SENASA (egreso) + reconocimiento UE Pet Passport.

7. **Estatuto jurídico** — Hoy "cosa mueble" (Art. 227 CCyCN); proyecto "Ley Sintientes" (2025) busca reclasificación. El Art. 1.947 CCyCN impide que quien encuentra un animal doméstico se lo apropie; que el modelo hable de "vecino en custodia temporal" es una decisión de miMAR (sobre los arts. 1955 y 1956, **a confirmar** en la edición oficial).

8. **Maltrato y denuncia** — Ley nac. 14.346 (penal, maltrato y crueldad) + Código Contravencional de CABA, arts. 140 a 143 bis (texto Ley 6.839; abandono en el art. 141) + Manual ENO del CVPBA (act. 05/2020) y Manual nacional (Disp. DE-MSAL 1/2026) para la notificación de zoonosis.

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

- Owner → Vet matriculado → constancia antirrábica con firma y sello con matrícula → queda en poder del propietario.
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

- Vet → carga caso → autoridad sanitaria (Min. Salud nac. y/o provincial): inmediata (24 h) o semanal (7 días) según la enfermedad. Ley 15.465/1960 (Decreto 3640/64); Disp. DE-MSAL 1/2026 (Manual nacional); Ley 5325/1948 (PBA); Res. MS 1715/2007; Manual ENO del CVPBA, act. 05/2020 (inmediata); Res. SENASA 153/2021 (lado animal, Grupo I 24 h a SENASA).
  - DIM: el veterinario registra el diagnóstico (`clinical_info_logged`, `sub_kind='disease_diagnosis'`) desde la ficha clínica o desde Atender; eso abre el aviso en la Cola ENO con el plazo de la enfermedad contado desde la fecha del diagnóstico. Lo que escribe el tutor o un denunciante es una **señal** para la autoridad, nunca un aviso legal. Mientras no exista un receptor, el aviso queda pendiente hasta que la autoridad lo marca "recibido" desde su bandeja.

### 6.6 Receta veterinaria

- Vet → emite receta → si incluye un principio activo alcanzado, receta electrónica obligatoria en el sistema de SENASA → farmacia veterinaria valida. Res. SENASA 80/2025 (fosfomicina, polimixina B) y Res. SENASA 654/2026 (SIGTRAZAVET; extiende la receta electrónica a los animales de compañía, art. 17, con CUVE y DNI del titular, art. 18).
  - DIM: `treatment_administered.payload.senasa_prescription_id` cuando aplica: una referencia a la receta emitida en SENASA, nunca una copia (la copia lleva el DNI del titular).

### 6.7 Muerte y cremación

- Owner → Vet matriculado (certificado de defunción) → crematorio habilitado (CABA: Ley 5470/2015) → asiento en Registro de Cremaciones GCBA. Plazo mínimo 24 hs salvo causa infectocontagiosa/zoonótica.
  - DIM: `death_recorded` + `disposition_method ∈ {cremation, burial, rendering, other}` + `facility_organization_id`.

### 6.8 Custodia, adopción y transferencia

- **Vecino encuentra animal**: ciudadano → custodia temporal sin volverse "dueño" (CCyCN Art. 1.947: no hay apropiación) → puede entregar a refugio o devolver. DIM: `Ownership.role='shelter_custody'` con `owner_user_id`.
- **Refugio adopta animal**: refugio → custodia → adopción → transfer Ownership a persona. Que un refugio no figure como `owner` es una **decisión de modelado** de miMAR para animales hallados: quien recibe un animal perdido no es su dueño (CCyC arts. 1947 y 1955, **a confirmar** el 1955 en la edición oficial). Ninguna norma impide que un refugio sea dueño, por ejemplo si el dueño le cede el animal. *(Corregido 2026-10: la Ley PBA 13.879 y el Dec. 400/2011 no mencionan refugios.)*
  - DIM: `custody_transferred` + `adoption_finalized`.
- **Foster**: refugio → asigna fostering a un voluntario con `organization_membership` activa. DIM: `foster_assigned` / `foster_ended`.

### 6.9 Denuncia de maltrato / abandono → decomiso

- **Maltrato:** cualquier persona → Fiscalía (Ley 14.346, arts. 1 a 3). En CABA interviene **UFEMA**. La Ley 14.346 no tipifica el abandono de mascotas (solo el de animales de experimentación, art. 3 inc. 5).
- **Abandono:** en CABA es contravención (Código Contravencional, art. 141, texto Ley 6.839; arts. 140 a 143 bis para el resto de las figuras). En PBA no hay una figura general: solo la Ley 14.107, art. 8 f, para los perros potencialmente peligrosos.
- Fiscalía / autoridad → decomiso del animal → autoridad de bienestar → refugio (vía `custody_transferred`).
- Sanción + inscripción en **Registro de infractores a la Ley de Maltrato Animal** (Ley CABA 6839/2025).
  - DIM: `maltreatment_reported` / `abandonment_reported` + cadena de `custody_transferred` para reflejar el flujo decomiso→refugio.

### 6.10 Movimiento internacional

- **Egreso**: Owner → Vet matriculado emite el certificado de salud, la constancia antirrábica y los demás certificados del destino, con firma y sello con matrícula → **SENASA emite el CVI** (presencial o digital) sobre esa documentación. Para MERCOSUR (Res. GMC 17/2015, incorporada por la Res. MAGyP 727/2015): CVI de la autoridad del país exportador, validez 60 días, examen clínico dentro de los 10 días previos; chip ISO obligatorio (Uruguay), antirrábica ≥21 días pre-viaje, desparasitación 15 días. *(Corregido 2026-10: el veterinario no emite el CVI; se quitó la Res. 580/2014.)*
- **Ingreso**: Vet del país origen emite CVI → SENASA puesto fronterizo valida (Res. SENASA 76/2019). Reconocimiento UE Pet Passport para ingresos temporales (Reg. UE 576/2013).
  - DIM: `travel_certificate_issued` + `border_crossed`. Útil para diseñar interoperabilidad de la credencial pública DIM con el CVI digital SENASA.

### 6.11 Transporte interno (público y privado)

- **Subte CABA**: Owner → 1 animal por adulto + contenedor + antirrábica vigente. Ley 5687/2016 + Decreto GCBA 31/2017.
- **Larga distancia nacional (ómnibus y trenes)**: Owner → constancia antirrábica (Anexo, art. 4) + un animal por pasajero adulto (art. 5); cada empresa fija sus restricciones de especie, raza, peso y tamaño (art. 7). Res. MEcon 2076/2025.
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

El esquema mínimo que ninguna "libreta sanitaria" o credencial pública en Argentina puede omitir surge de la intersección de Ord. 41.831, Ley 4078, Ley 14.107, Res. GMC MERCOSUR 17/15 y Ley CABA 5470. Cuadro por procedimiento:

| Procedimiento | Datos exigidos por la norma | Anclaje |
|---|---|---|
| Inscripción municipal CABA | Nombre, especie, raza, sexo, color, marcas distintivas, fecha de nacimiento (o edad estimada), tatuaje o microchip, datos del propietario (DNI, domicilio). | Ord. 41.831/1987 |
| Inscripción PPP CABA | Todo lo anterior + foto del animal, número de microchip, vacuna antirrábica vigente, número y vencimiento de póliza de seguro RC, comprobante de curso virtual del propietario. | Ley 4078/2012; Res. 93/APRA/2021 |
| Inscripción PPP PBA | Identificación por microchip **o** tatuaje (obligatoria, art. 8 b), datos del propietario, edad <6 meses al registrar. Sin reglamentación hallada. | Ley 14.107/2010 |
| Constancia antirrábica | Fecha de vacunación, marca/lote de la vacuna, veterinario matriculado (matrícula + jurisdicción), especie, sexo, edad, identificación del animal, datos del propietario. | Página de SENASA "Traslados de perros y/o gatos dentro de Argentina"; Res. MEcon 2076/2025, Anexo, art. 4 (la Res. SENASA 580/2014 no la regula) |
| CVI MERCOSUR (perros y gatos) | Chip ISO 11784/11785 (obligatorio para perros >90 días destino Uruguay); raza, sexo, color, edad; vacuna antirrábica con fecha, lote, marca, validez; desparasitación interna y externa con fecha, principio activo y dosis; examen clínico pre-embarque; datos completos del propietario y del destinatario. | Res. GMC 17/15; Res. SENASA 76/2019 |
| Cremación CABA | Identificación del animal, fecha y causa probable de muerte, datos del propietario, profesional veterinario firmante, plazo ≥24 hs salvo excepción sanitaria, crematorio habilitado. | Ley CABA 5470/2015 |
| Observación antirrábica (mordedura) | Identificación del animal, antirrábica vigente o no, datos del propietario, datos del mordido, fecha y lugar del hecho. | DL 4669/1973 PBA; Ord. 41.831 CABA; Res. MS 1144/2018 |
| Denuncia ENO | Caso clínico, agente etiológico sospechado, especie, edad, sexo, fecha de inicio, lugar geográfico, propietario, vet notificante. | Ley 15.465; Res. MS 1715/2007; Disp. DE-MSAL 1/2026; Manual ENO del CVPBA (act. 05/2020) |
| Patente canina PBA | Identificación, antirrábica del año en curso, propietario; comprobante portado físicamente. | Ley 5664/1952 |
| Receta electrónica veterinaria | Identificación del animal, especie, peso, principio activo, dosis y posología, vet matriculado, propietario (nombre y DNI del titular en la "Prescripción en mascotas", art. 18 d), CUVE. | Res. SENASA 80/2025 y 654/2026 |
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
- Para refugios: personería jurídica, CUIT, rol `shelter_custody` (por decisión de modelado de miMAR para animales hallados, no por una norma)

**Transferencia**
- Custodia / adopción / decomiso: fecha, actor cedente, actor receptor, motivo

---

## 8. Obligaciones exigibles por actor

Catálogo de "qué le exige el sistema legal a cada actor", agrupado por rol. Útil para diseñar permisos, formularios y verificaciones en DIM.

### 8.1 Propietarios / tenedores

**Genéricas (todo el país)**
- No incurrir en maltrato ni crueldad. Ley nac. 14.346 — penal, 15 días a 1 año de prisión.
- Tenencia responsable: alimento, agua, refugio, atención veterinaria. Código Contravencional de CABA, arts. 140 a 143 bis (texto Ley 6.839). *(2026-10: se quitó la Ley PBA 13.879, que no impone deberes a los dueños.)*
- No abandonar al animal: Código Contravencional de CABA, art. 141 (texto según Ley 6.839, BO 20/10/2025). En PBA no hay una figura general (solo Ley 14.107, art. 8 f, para PPP).

**Identificación y registración**
- CABA: inscripción en el Registro Municipal al 4° mes; chip o tatuaje. Ord. 41.831/1987.
- PBA: patente canina anual con antirrábica asociada. Ley 5664/1952.
- PBA PPP: chip o tatuaje + Registro Prov. 14.107 antes de los 6 meses.
- CABA PPP: Registro 4078 antes de los 3 meses + póliza de seguro RC vigente + curso virtual + foto + chip + renovación anual + notificación de incidentes <48 hs.

**Vacunación**
- Antirrábica obligatoria desde 3 meses, anual, con constancia en poder del propietario. Ley nac. 22.953; DL 8056/1973 PBA; Ord. 41.831 CABA.

**Vía pública**
- Correa obligatoria. Ley CABA 5471/2015 + DL provincial.
- Recolección de deyecciones. Ley CABA 5471.
- PPP CABA: bozal + correa <2 m.
- PPP PBA: bozal + correa <1 m + collar.

**Transporte**
- Subte CABA: contenedor + antirrábica + 1 mascota por adulto. Ley 5687/2016.
- Larga distancia nacional (ómnibus y trenes): constancia antirrábica, un animal por pasajero adulto; restricciones de cada empresa. Res. MEcon 2076/2025.
- Internacional: CVI vigente, emitido por SENASA. Res. GMC 17/15 (incorporada por la Res. MAGyP 727/2015); Res. SENASA 76/2019 (ingreso).

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
- Contravencional CABA (Código Contravencional, texto Ley 6.839): abandono (art. 141) con 60 a 90 días de trabajo de utilidad pública, o multa de 3.000 a 5.000 unidades fijas, o 15 a 30 días de arresto; inscripción en el Registro de Infractores. La acción prescribe a los 18 meses (art. 43).
- Faltas CABA: multas + decomiso + clausura comercial.
- Tránsito: retención del animal si circula suelto (Ley 24.449).

### 8.2 Organizaciones (clínicas, refugios, redes, crematorios, paseadores, pet shops, transportistas)

**Veterinarios y clínicas**
- Matrícula vigente. Ley nac. 14.072/1951 (CABA + jurisdicción federal); DL 9686/1981 PBA + Dec. 1420/83 (CVPBA).
- Habilitación edilicia y de actividad. Ley PBA 10.526/1987 + Dec. 154/1989; en CABA bajo Ord. 41.831.
- BPM si elabora productos veterinarios. Res. SENASA 416/2024.
- Receta electrónica para los principios activos alcanzados: fosfomicina y polimixina B (Res. SENASA 80/2025) y los que la Res. SENASA 654/2026 extiende a los animales de compañía. Con la 654/2026, el botiquín sin receta electrónica exige ficha clínica (art. 20).
- Extender la constancia antirrábica con firma y sello con matrícula. *(2026-10: la Res. 580/2014 no regula un formulario antirrábico.)*
- Extender el certificado de salud y la constancia antirrábica que SENASA pide para emitir el CVI (el CVI lo emite SENASA). Res. MAGyP 727/2015; Res. SENASA 76/2019.
- Notificar ENO: inmediata (24 h) o semanal (7 días) según la enfermedad. Ley nac. 15.465; Disp. DE-MSAL 1/2026; Ley PBA 5325; Manual ENO del CVPBA (act. 05/2020).
- PBA, clínicas, hospitales y sanatorios: registro foliado y rubricado de historias clínicas. Dec. 154/1989, art. 16.
- Documentar productos veterinarios. Dec. 583/67; Res. SENASA 11/2025.
- Bioterios: BPM y principio 3R. Disp. ANMAT 9236/2023.

**Refugios y redes de rescate**
- Personería jurídica para operar formalmente.
- Para animales hallados, custodia temporal pendiente adopción: el refugio es depositario (CCyC arts. 1947 y 1955, **a confirmar** el 1955) y el dueño puede reclamar (arts. 1955 y 1956). Que no figure como "dueño" es una decisión de modelado de miMAR; si el dueño le cede el animal, la regla puede ser otra.
- No maltratar a ningún animal bajo custodia. Ley nac. 14.346; en CABA, Código Contravencional, arts. 140 a 143 bis.
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
- Fijar sus restricciones de especie, raza, peso y tamaño (Res. MEcon 2076/2025, Anexo, art. 7, ómnibus y trenes de larga distancia) y aceptar contenedores conforme a la Ley CABA 5687 (subte).
- Excepción y acceso obligatorio para perros guía/asistencia. Ley 26.858; Ley PBA 15.409.

### 8.3 Oficinas gubernamentales

**SENASA (federal)**
- Mantener Registro Nacional de Productos Veterinarios. Dec. 583/67; Res. 11/2025.
- Emitir el CVI (presencial o digital) sobre la documentación del veterinario. Res. MAGyP 727/2015 (Mercosur); Res. SENASA 76/2019 (ingreso).
- Internalizar resoluciones GMC MERCOSUR. Res. GMC 17/15.
- Sanidad fronteriza para ingreso de mascotas.
- Operar el sistema de receta electrónica veterinaria (SIGTRAZAVET). Res. 80/2025 y 654/2026.
- Vigilancia zoonosis a nivel federal (One Health MoU).

**Ministerio de Salud de la Nación**
- Coordinar Programa Nacional de Control de Enfermedades Zoonóticas. Res. 1811/2011.
- Mantener Guía Nacional de Rabia. Res. 1144/2018.
- Recibir notificaciones ENO. Ley 15.465; Res. 1715/2007.
- Producir/distribuir antirrábica humana postexposición.

**Ministerio de Salud PBA**
- Autoridad de aplicación de Ley 13.879. Decreto 400/2011.
- Operar dispensarios antirrábicos provinciales y articular con municipales. DL 8056/1973.
- Profilaxis de la brucelosis. Ley 6115/1959 (no fija deber de denuncia ni plazo).
- Recibir denuncias ENO provinciales. Ley 5325/1948.

**Ministerio de Asuntos Agrarios PBA**
- Autoridad de aplicación de Ley 10.526 (habilitación de establecimientos veterinarios).

**Colegio de Veterinarios PBA (CVPBA)**
- Matriculación y régimen ético-disciplinario. DL 9686/1981; Decreto 1420/1983.
- Difusión de ENO en pequeños animales: Manual de notificación del CVPBA (act. 05/2020), que remite a la Res. CVPBA 44/2016.

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
- **Interoperabilidad futura**: receta electrónica SENASA (Res. 80/2025 y 654/2026, como referencia y sin copiar el DNI del titular), CVI digital SENASA, Animales BA (CABA), Registro PPP de cada jurisdicción.

---

*Fuentes principales:* InfoLEG, SAIJ, SENASA Digesto, Boletín Oficial de la Nación, Normas PBA, Boletín Oficial CABA, CEDOM, Cancillería Argentina, WOAH, MERCOSUR Normas. Última verificación general: 18 de mayo de 2026.
