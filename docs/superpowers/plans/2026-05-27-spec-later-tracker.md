# Spec-later tracker

> ## ⏳ LAS TRES ENTRADAS ESPERAN A TERCEROS (marcado 2026-08-04)
>
> Ninguna de estas tres es trabajo de ingeniería pendiente: **las tres están
> bloqueadas por una decisión o un dato que no depende de nosotros.** Se
> marcan así para que ningún agente ni persona las levante como tarea.
>
> 1. **PPP CABA export** — falta saber si la Ciudad expone API o es carga
>    manual de PDF, y con qué campos/firma. Producto + legal con la
>    Subsecretaría de Bienestar Animal.
> 2. **Credencial de perro de asistencia (Ley 26.858)** — decisión de producto
>    y de validación documental.
> 3. **Documentos de viaje (`pet_attachments`)** — decisión de esquema (tabla
>    dedicada vs. `attachments` polimórfica) + la pregunta de producto de una
>    página de documentos vs. CTAs por documento.
>
> El resto del documento explica cada bloqueo con su evidencia. **No arrancar
> ninguna sin que la decisión de afuera esté cerrada.**


> Created: 2026-05-27 · Owner: producto + ingeniería · Cadence: revisar en cada planning de sprint.

This document holds features that have a `// TODO(spec-later)` or `// DEFERRED`
marker in code but **no committed plan or spec**. They are intentionally
parked until the listed decision is made. Code comments that reference
"spec-later" should link to the anchor for the specific entry below.

When a feature is ready to spec, move its entry to `docs/superpowers/specs/`
under a new design doc and delete the corresponding section here.

---

## 1. PPP card — Ley CABA 4078 export {#ppp-card}

**Where in code:**
- `app/(app)/mis-mascotas/[publicToken]/page.tsx` — `{/* §4.9 (3) PPP card */}` block (renders `<PpPCard>` when the pet is a `potentially_dangerous_breed`).

> **2026-07-02 (wave-3 D15):** `components/PppExportCabaButton.tsx` was deleted — the pet-document-redesign (two-face) rewrite no longer renders it anywhere (`page.tsx`'s PPP card block dropped the export button along with the rest of the old v2.1 flat layout; the PPP row now lives on `CredentialFace`, see AGENTS.md rule 5). This entry stays open for the underlying CABA export DECISION, which is still unresolved — only the dead button component is gone.

**What's there today:** the PPP card renders for PPP-flagged pets in CABA. The export button posts to a stub server action. The on-device flow works (user sees the card, can fill it).

**What's blocked / deferred:** the **export to the provincial registry**. Ley CABA 4078 requires PPP owners to register the dog with the city; we don't know yet whether the city accepts an API submission or only a PDF.

**Decision needed before spec:**
1. Does CABA expose an API for PPP registration, or is it manual upload of a PDF? (Legal / producto to confirm with the city.)
2. If PDF: which fields, which signature scheme (CUIT? captcha?), what's the file format spec?
3. If API: auth model, rate limits, retry semantics.

**Who should respond:** producto + legal (Argentina), with input from the CABA Subsecretaría de Bienestar Animal.

**Bloquea:** export gubernamental para owners en CABA (no bloquea funcionalidad core de la app — el card sigue mostrándose).

---

## 2. Service Dog credential — Ley 26.858 {#service-dog-card}

**Where in code:**
- `app/(app)/mis-mascotas/[publicToken]/page.tsx` — `{/* §4.9 (4) Service Dog credential card */}` block (renders `<ServiceDogCredentialCard>` when `serviceDogRow.credentialStatus === "vigente"`).

**What's there today:** the card renders if there's a `service_dog` row with `credential_status='vigente'`. Owners can see the credential and its expiry. There is no flow yet to **emit or refresh** the credential — the card just reads cached state.

**What's blocked / deferred:** the **issuance model**. Ley 26.858 regulates assistance/service dogs at the federal level, but the credential historically comes from a registered training entity (escuela), not from the state directly. Open question: should DIM emit the credential itself (becoming the registering authority) or cache one issued by an external escuela?

**Decision needed before spec:**
1. Does DIM want to be a registering authority? Doing so triggers legal/compliance scope we don't currently have.
2. If we cache external credentials: which entities are recognized, what's the verification flow, who flips `credential_status` to `vigente` / `vencido`?

**Who should respond:** producto + legal. Lower urgency than PPP — no public-facing flow demands a service-dog credential today.

**Bloquea:** nothing in v1. Service-dog owners see a static card with whatever state the DB has.

---

## 3. Travel docs — `pet_attachments` table {#travel-docs}

**Where in code:**
- `app/(app)/mis-mascotas/[publicToken]/page.tsx:39` — top-of-file comment "TODO(J-followup): Travel docs — no pet_attachments table yet."
- `app/(app)/mis-mascotas/[publicToken]/page.tsx:809-814` — `<PetTravelDocs docs={[]} />` renders with a hardcoded empty array.

**What's there today:** the UI card exists and links to an editor section. The data source is hardcoded to `[]` because the schema decision below is open.

**What's blocked / deferred:** the **storage shape** for travel documents (passport, international certificate, rabies title, etc.).

**Decision needed before spec:**
1. Dedicated `pet_attachments` table with a controlled `kind` enum (`passport | intl_cert | rabies_title | ...`)? More explicit, easier to query, but adds a table.
2. Reuse the existing polymorphic `attachments` table with `kind` + `pet_id` references? Less schema but every consumer has to filter by kind.

**Who should respond:** ingeniería (schema design) + producto (do we want a single travel-docs page or per-doc-type CTAs?).

**Bloquea:** the "documentos de viaje" feature for owners traveling abroad. Not on the v1 critical path; the card stays empty.

---

## How to add an entry

When you find a new `TODO(spec-later)` while implementing:

1. Add a section above with the same shape (Where / What's there / Blocked / Decision / Who / Bloquea).
2. Change the code comment to `// TODO(spec-later): see docs/superpowers/plans/2026-05-27-spec-later-tracker.md#anchor`.
3. Re-link the bullet from `AGENTS.md → Open questions` if it touches a question listed there.

## How to retire an entry

When the decision lands:

1. Move the work to `docs/superpowers/specs/YYYY-MM-DD-feature-design.md`.
2. Delete the section from this tracker (history stays in git).
3. Replace the in-code comment with a link to the new spec.
