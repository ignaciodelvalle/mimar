"use client";

// DecomisoForm -- client component for the govt decomiso execution form.
//
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md section 6.
//
// Mode toggle (DC3):
//   - "registered_pet": existing token-lookup path. DC2 double-confirm applies
//     when the pet has an owner.
//   - "unowned_animal": stray with no prior registration. Collects descriptive
//     fields (species required; breed/color/sex/approx age/distinguishing
//     features). DC2 double-confirm NOT shown (no prior owner).
//
// Fields (registered_pet mode):
//   - petPublicToken:               search/enter by public token -> show pet preview
//
// Fields (unowned_animal mode):
//   - unownedSpecies:               required
//   - unownedSex:                   male | female | unknown
//   - unownedBreed:                 optional
//   - unownedColor:                 optional
//   - unownedDistinguishingFeatures: optional
//   - unownedApproxAgeMonths:       optional
//
// Shared fields (both modes):
//   - seizureMotive:                Select (enum, required)
//   - seizureMotiveOtherDetail:     shown when motive === 'otro'
//   - judicialProceedingReference:  optional text
//   - originatingWelfareReportId:   optional, prefilled from ?welfareReportId=
//   - intendedReceiverOrganizationId: combobox over verified shelters
//   - intakeCondition:              optional text
//   - attachmentFiles:              >= 2 mandatory files (photo + acta)

import { Icon } from "@/components/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { OpButton, OpFileInput, OpInput, OpSelect, OpTextarea } from "@/components/ui/dashboard";
import { useRef, useState, useTransition } from "react";

import {
  type ExecuteDecomisoInput,
  type ExecuteDecomisoResult,
  type SeizureMotive,
  type UnownedAnimalInput,
  executeDecomisoAction,
} from "@/app/actions/decomiso";
import {
  type GovtPetLookupResult,
  lookupPetForDecomisoAction,
} from "@/app/actions/decomiso-pet-lookup";
import { normalizeDimTokenInput } from "@/lib/domain/dim-token";
import {
  DECOMISO_EVIDENCE_MIME_LIST,
  MAX_DECOMISO_EVIDENCE_BYTES,
  MAX_DECOMISO_EVIDENCE_TOTAL_BYTES,
} from "@/lib/media/limits";
import { formatRate, sexLabel, speciesLabel, statusLabel } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReceiverOrg = {
  id: string;
  displayName: string;
  orgType: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

type PetPreview = Extract<GovtPetLookupResult, { found: true }>;

type AttachmentEntry = {
  file: File;
  objectUrl: string | null;
};

type SubjectMode = "registered_pet" | "unowned_animal";

type DecomisoFormProps = {
  receiverOrgs: ReceiverOrg[];
  prefillWelfareReportId: string | null;
  /** Public DEN-XXXX-XXXX code of the linked denuncia, shown instead of the raw id. */
  prefillWelfareReportRef: string | null;
  prefillPetToken: string | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEIZURE_MOTIVE_LABELS: Record<SeizureMotive, string> = {
  maltrato_fisico: "Maltrato físico",
  abandono_extremo: "Abandono extremo",
  acumulacion: "Acumulación / hoarding",
  trafico: "Tráfico / comercio ilegal",
  sin_refugio_critico: "Sin resguardo adecuado (situación crítica)",
  pelea_de_perros: "Pelea de perros",
  otro: "Otro",
};

const MAX_ATTACHMENTS = 10;
// Bucket `decomiso-evidence` (db/migrations/0234, PO decision D10) accepts
// JPG/PNG/WEBP photos and the PDF acta, up to 10 MiB each — the same
// server-enforced values from lib/media/limits.ts, so the client rejects early
// with the numbers the server and the bucket would refuse anyway. The TOTAL
// cap keeps the whole form under the Server Action body limit. The server
// re-decides every type by its bytes; this pre-check is a courtesy.
// (Only lib/media/limits.ts here: lib/media/validate.ts pulls sharp.)
const MAX_ATTACHMENT_BYTES = MAX_DECOMISO_EVIDENCE_BYTES;
const MAX_ATTACHMENT_MB = MAX_DECOMISO_EVIDENCE_BYTES / (1024 * 1024);
const MAX_TOTAL_MB = MAX_DECOMISO_EVIDENCE_TOTAL_BYTES / (1024 * 1024);
const ALLOWED_MIME = new Set<string>(DECOMISO_EVIDENCE_MIME_LIST);

// ---------------------------------------------------------------------------
// DecomisoForm
// ---------------------------------------------------------------------------

export function DecomisoForm({
  receiverOrgs,
  prefillWelfareReportId,
  prefillWelfareReportRef,
  prefillPetToken,
}: DecomisoFormProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // RA-9 BR-1: focus returns here when the DC2 confirm modal closes.
  const submitRef = useRef<HTMLButtonElement>(null);

  // --- Subject mode toggle (DC3) ---
  const [subjectMode, setSubjectMode] = useState<SubjectMode>("registered_pet");

  // --- Registered pet state ---
  const [petToken, setPetToken] = useState(prefillPetToken ?? "");
  const [petPreview, setPetPreview] = useState<PetPreview | null>(null);
  const [petLookupPending, setPetLookupPending] = useState(false);
  const [petLookupError, setPetLookupError] = useState<string | null>(null);

  // --- Unowned animal state ---
  const [unownedSpecies, setUnownedSpecies] = useState("");
  const [unownedSex, setUnownedSex] = useState<"male" | "female" | "unknown">("unknown");
  const [unownedBreed, setUnownedBreed] = useState("");
  const [unownedColor, setUnownedColor] = useState("");
  const [unownedFeatures, setUnownedFeatures] = useState("");
  const [unownedAgeMonths, setUnownedAgeMonths] = useState("");

  // --- Shared state ---
  const [seizureMotive, setSeizureMotive] = useState<SeizureMotive | "">("");
  const [seizureMotiveOtherDetail, setSeizureMotiveOtherDetail] = useState("");
  const [judicialRef, setJudicialRef] = useState("");
  // Linkage is prefill-only (resolved server-side); the operator never types the
  // raw id, so this is a plain value, not editable state.
  const welfareReportId = prefillWelfareReportId ?? "";
  const [intakeCondition, setIntakeCondition] = useState("");
  const [receiverOrgId, setReceiverOrgId] = useState("");
  const [receiverSearch, setReceiverSearch] = useState("");

  const [attachments, setAttachments] = useState<AttachmentEntry[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const [formError, setFormError] = useState<string | null>(null);
  // The decomiso was RECORDED: the form becomes its receipt (L-13). The public
  // code IS the receipt — it used to be thrown into a redirect URL, so the
  // funcionario never saw it as the thing to write on the acta. The case page
  // is still one tap away, as the screen's first action.
  //
  // `warning` is set when one or more notifications could not be delivered.
  // Not an error — we do not undo a seizure over a delivery blip — but it is
  // the only message telling the funcionario that the owner or the refugio was
  // never informed (an in-app row is the entire notification instrument here),
  // so it renders ON the receipt, never behind a navigation.
  const [success, setSuccess] = useState<{
    publicCode: string;
    receiverName: string | null;
    warning: string | null;
  } | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isPending, startTransition] = useTransition();

  // --- Pet lookup ---
  async function lookupPet() {
    const token = normalizeDimTokenInput(petToken);
    if (!token) return;
    setPetLookupError(null);
    setPetPreview(null);
    setPetLookupPending(true);
    try {
      const result = await lookupPetForDecomisoAction(token);
      if (!result.found) {
        setPetLookupError(result.error);
        return;
      }
      setPetPreview(result);
    } catch {
      setPetLookupError("Error al buscar la mascota. Intenta nuevamente.");
    } finally {
      setPetLookupPending(false);
    }
  }

  // --- Attachment handling ---
  function handleFilesSelected(incoming: FileList | null) {
    if (!incoming || incoming.length === 0) return;
    setAttachmentError(null);
    const newFiles = Array.from(incoming);
    const combined = [...attachments.map((e) => e.file), ...newFiles];

    if (combined.length > MAX_ATTACHMENTS) {
      setAttachmentError(`Máximo ${MAX_ATTACHMENTS} archivos en total.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    for (const f of newFiles) {
      if (!ALLOWED_MIME.has(f.type)) {
        setAttachmentError(
          `Tipo no permitido: "${f.name}". Aceptamos imágenes JPG, PNG o WEBP y actas en PDF.`,
        );
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentError(`"${f.name}" supera el límite de ${MAX_ATTACHMENT_MB} MB.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
    }
    const totalBytes = combined.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_DECOMISO_EVIDENCE_TOTAL_BYTES) {
      setAttachmentError(`Los archivos juntos superan los ${MAX_TOTAL_MB} MB.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const added: AttachmentEntry[] = newFiles.map((f) => ({
      file: f,
      objectUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
    }));
    setAttachments((prev) => [...prev, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => {
      const entry = prev[index];
      if (entry?.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      return prev.filter((_, i) => i !== index);
    });
    setAttachmentError(null);
  }

  // --- Validation ---
  function validate(): string | null {
    if (subjectMode === "registered_pet") {
      if (!petPreview) return "Buscá y confirmá la mascota antes de continuar.";
    } else {
      if (!unownedSpecies.trim()) return "Indicá la especie del animal sin registrar.";
    }
    if (!seizureMotive) return "Seleccioná el motivo del decomiso.";
    if (seizureMotive === "otro" && !seizureMotiveOtherDetail.trim()) {
      return "Especificá el detalle cuando el motivo es 'Otro'.";
    }
    if (!receiverOrgId) return "Seleccioná el refugio o red de rescate destinataria.";
    if (attachments.length < 2) {
      return "Adjuntá al menos 2 archivos: una foto del animal y el acta administrativa.";
    }
    return null;
  }

  // --- Submit flow ---
  function handleSubmit() {
    setFormError(null);
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    // DC2: registered pet with owner -> double-confirm modal.
    // Unowned path skips DC2 (no prior owner to dispossess).
    if (subjectMode === "registered_pet" && petPreview?.hasOwner) {
      setShowConfirmModal(true);
      return;
    }
    executeDecomiso();
  }

  function executeDecomiso() {
    setShowConfirmModal(false);
    setFormError(null);
    startTransition(async () => {
      let input: ExecuteDecomisoInput;

      if (subjectMode === "registered_pet") {
        input = {
          subjectKind: "registered_pet",
          petPublicToken: petPreview?.publicToken ?? "",
          seizureMotive: seizureMotive as SeizureMotive,
          seizureMotiveOtherDetail: seizureMotiveOtherDetail.trim() || null,
          judicialProceedingReference: judicialRef.trim() || null,
          originatingWelfareReportId: welfareReportId.trim() || null,
          intendedReceiverOrganizationId: receiverOrgId,
          intakeCondition: intakeCondition.trim() || null,
          attachmentFiles: attachments.map((e) => e.file),
        };
      } else {
        const approxAgeMonthsRaw = unownedAgeMonths.trim();
        const approxAgeMonths = approxAgeMonthsRaw
          ? Math.max(0, Number.parseInt(approxAgeMonthsRaw, 10) || 0)
          : null;

        const unownedAnimal: UnownedAnimalInput = {
          species: unownedSpecies.trim(),
          sex: unownedSex,
          breed: unownedBreed.trim() || null,
          color: unownedColor.trim() || null,
          distinguishingFeatures: unownedFeatures.trim() || null,
          approxAgeMonths,
        };
        input = {
          subjectKind: "unowned_animal",
          unownedAnimal,
          seizureMotive: seizureMotive as SeizureMotive,
          seizureMotiveOtherDetail: seizureMotiveOtherDetail.trim() || null,
          judicialProceedingReference: judicialRef.trim() || null,
          originatingWelfareReportId: welfareReportId.trim() || null,
          intendedReceiverOrganizationId: receiverOrgId,
          intakeCondition: intakeCondition.trim() || null,
          attachmentFiles: attachments.map((e) => e.file),
        };
      }

      const result: ExecuteDecomisoResult = await executeDecomisoAction(input);
      if ("error" in result) {
        setFormError(result.error);
        return;
      }
      setShowConfirmModal(false);
      setSuccess({
        publicCode: result.publicCode,
        receiverName: receiverOrgs.find((o) => o.id === receiverOrgId)?.displayName ?? null,
        warning: result.warning ?? null,
      });
    });
  }

  // --- Receiver combobox filter ---
  const filteredOrgs =
    receiverSearch.trim().length > 0
      ? receiverOrgs.filter((o) =>
          o.displayName.toLowerCase().includes(receiverSearch.toLowerCase()),
        )
      : receiverOrgs;

  const selectedOrg = receiverOrgs.find((o) => o.id === receiverOrgId);

  // --- Render ---
  if (success) {
    const receiver = success.receiverName ?? "el refugio destinatario";
    return (
      <div className="space-y-4">
        {success.warning && (
          <output className="text-md text-ln-op-warn rounded-[var(--radius-md)] border border-ln-op-line px-4 py-3 block">
            {success.warning}
          </output>
        )}
        <LnSuccessScreen
          title="Decomiso registrado"
          code={success.publicCode}
          codeLabel="Código del decomiso"
          codeWarning="Anotá este código en el acta: identifica el decomiso en el registro."
          description={`${receiver} recibe la propuesta de custodia y tiene 7 días para aceptarla o rechazarla. Mientras tanto, la custodia queda a cargo de tu autoridad.`}
          official
          next={[
            { label: "Ver el caso", href: `/casos/${success.publicCode}?origin=decomiso` },
            { label: "Volver a decomisos", href: "/gob/decomisos" },
          ]}
        />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* --- Sujeto del decomiso (mode toggle + conditional fields) --- */}
        <section className="rounded-[var(--radius-md)] border border-ln-op-line p-5 space-y-4">
          <h2 className="text-sm font-semibold text-ln-op-ink uppercase tracking-wider">
            1. Sujeto del decomiso
          </h2>

          {/* Mode toggle */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setSubjectMode("registered_pet")}
              className={`flex-1 py-2.5 px-4 rounded-[var(--radius-md)] border text-md font-medium transition-colors ${
                subjectMode === "registered_pet"
                  ? "border-ln-op-azul bg-ln-op-blue-bg text-ln-op-azul"
                  : "border-ln-op-line bg-ln-op-card text-ln-op-mute hover:bg-ln-op-stripe"
              }`}
            >
              Mascota registrada (chapita)
            </button>
            <button
              type="button"
              onClick={() => setSubjectMode("unowned_animal")}
              className={`flex-1 py-2.5 px-4 rounded-[var(--radius-md)] border text-md font-medium transition-colors ${
                subjectMode === "unowned_animal"
                  ? "border-ln-op-azul bg-ln-op-blue-bg text-ln-op-azul"
                  : "border-ln-op-line bg-ln-op-card text-ln-op-mute hover:bg-ln-op-stripe"
              }`}
            >
              Animal sin registrar (callejero)
            </button>
          </div>

          {/* Registered pet fields */}
          {subjectMode === "registered_pet" && (
            <div className="space-y-3">
              <p className="text-sm text-ln-op-mute">
                Ingresá el token DIM-XXXX-XXXX de la mascota registrada.
              </p>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label
                    htmlFor="petToken"
                    className="block text-sm font-medium text-ln-op-ink mb-1"
                  >
                    Token de la mascota
                  </label>
                  <OpInput
                    id="petToken"
                    type="text"
                    value={petToken}
                    onChange={(e) => {
                      setPetToken(normalizeDimTokenInput(e.target.value));
                      setPetPreview(null);
                      setPetLookupError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        lookupPet();
                      }
                    }}
                    placeholder="DIM-XXXX-XXXX"
                    className="font-ln-mono"
                  />
                </div>
                <OpButton
                  type="button"
                  onClick={lookupPet}
                  disabled={petLookupPending || !petToken.trim()}
                  variant="primary"
                  // Matches the token field it sits beside. OpField's `md` step
                  // carries a 44px touch floor and OpButton deliberately does
                  // not (see the note on its `sizes`), so the pairing states
                  // the height here rather than moving every console button.
                  className="self-end min-h-[44px]"
                >
                  {petLookupPending ? "Buscando..." : "Buscar"}
                </OpButton>
              </div>

              {petLookupError && (
                <p className="text-md text-ln-op-danger rounded-[var(--radius-md)] bg-ln-op-danger-bg border border-ln-op-danger-bd px-3 py-2">
                  {petLookupError}
                </p>
              )}

              {petPreview && (
                <div
                  className={`rounded-[var(--radius-md)] border p-4 space-y-1 ${
                    petPreview.hasOwner
                      ? "border-ln-op-warn-bd bg-ln-op-warn-bg"
                      : "border-ln-op-line bg-ln-op-stripe"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-md font-semibold text-ln-op-ink">
                      {petPreview.name}{" "}
                      <span className="font-normal text-ln-op-mute">
                        ({speciesLabel(petPreview.species)}, {sexLabel(petPreview.sex)})
                      </span>
                    </p>
                    <span
                      className={`text-sm px-2 py-0.5 rounded-full ${
                        petPreview.status === "active"
                          ? "bg-ln-op-ok-bg text-ln-op-ok"
                          : "bg-ln-op-stripe text-ln-op-mute"
                      }`}
                    >
                      {statusLabel(petPreview.status)}
                    </span>
                  </div>
                  <p className="text-sm font-ln-mono text-ln-op-mute">{petPreview.publicToken}</p>
                  {petPreview.hasOwner ? (
                    <p className="text-sm text-ln-op-warn mt-1">
                      Esta mascota tiene un dueño registrado
                      {petPreview.ownerDisplayName ? ` (${petPreview.ownerDisplayName})` : ""}. Al
                      continuar, se le quitará la custodia legal.
                    </p>
                  ) : (
                    <p className="text-sm text-ln-op-mute mt-1">
                      Sin dueño registrado actualmente.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Unowned animal fields */}
          {subjectMode === "unowned_animal" && (
            <div className="space-y-3">
              <p className="text-sm text-ln-op-mute">
                Describí el animal. Se creará un registro en el sistema para este decomiso. La
                jurisdicción se asignará desde tu organización sanitaria.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="unownedSpecies"
                    className="block text-sm font-medium text-ln-op-ink mb-1"
                  >
                    Especie <span className="text-ln-op-danger">*</span>
                  </label>
                  <OpSelect
                    id="unownedSpecies"
                    value={unownedSpecies}
                    onChange={(e) => setUnownedSpecies(e.target.value)}
                  >
                    <option value="">{"— Seleccioná —"}</option>
                    <option value="dog">Perro</option>
                    <option value="cat">Gato</option>
                    <option value="other">Otro</option>
                  </OpSelect>
                </div>

                <div>
                  <label
                    htmlFor="unownedSex"
                    className="block text-sm font-medium text-ln-op-ink mb-1"
                  >
                    Sexo
                  </label>
                  <OpSelect
                    id="unownedSex"
                    value={unownedSex}
                    onChange={(e) => setUnownedSex(e.target.value as "male" | "female" | "unknown")}
                  >
                    <option value="unknown">Desconocido</option>
                    <option value="male">Macho</option>
                    <option value="female">Hembra</option>
                  </OpSelect>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="unownedBreed"
                    className="block text-sm font-medium text-ln-op-ink mb-1"
                  >
                    Raza (opcional)
                  </label>
                  <OpInput
                    id="unownedBreed"
                    type="text"
                    value={unownedBreed}
                    onChange={(e) => setUnownedBreed(e.target.value)}
                    placeholder="Mestizo, labrador, etc."
                  />
                </div>

                <div>
                  <label
                    htmlFor="unownedColor"
                    className="block text-sm font-medium text-ln-op-ink mb-1"
                  >
                    Color (opcional)
                  </label>
                  <OpInput
                    id="unownedColor"
                    type="text"
                    value={unownedColor}
                    onChange={(e) => setUnownedColor(e.target.value)}
                    placeholder="Negro, blanco y marrón, etc."
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="unownedFeatures"
                  className="block text-sm font-medium text-ln-op-ink mb-1"
                >
                  Marcas distintivas (opcional)
                </label>
                <OpInput
                  id="unownedFeatures"
                  type="text"
                  value={unownedFeatures}
                  onChange={(e) => setUnownedFeatures(e.target.value)}
                  placeholder="Cicatriz en lomo, mancha en ojo derecho, etc."
                />
              </div>

              <div>
                <label
                  htmlFor="unownedAgeMonths"
                  className="block text-sm font-medium text-ln-op-ink mb-1"
                >
                  Edad aproximada en meses (opcional)
                </label>
                <OpInput
                  id="unownedAgeMonths"
                  type="number"
                  min="0"
                  max="360"
                  step="1"
                  value={unownedAgeMonths}
                  onChange={(e) => setUnownedAgeMonths(e.target.value)}
                  placeholder="Ej: 24 (2 años)"
                />
              </div>
            </div>
          )}
        </section>

        {/* --- Motivo --- */}
        <section className="rounded-[var(--radius-md)] border border-ln-op-line p-5 space-y-4">
          <h2 className="text-sm font-semibold text-ln-op-ink uppercase tracking-wider">
            2. Motivo del decomiso
          </h2>
          <div>
            <label
              htmlFor="seizureMotive"
              className="block text-sm font-medium text-ln-op-ink mb-1"
            >
              Motivo <span className="text-ln-op-danger">*</span>
            </label>
            <OpSelect
              id="seizureMotive"
              value={seizureMotive}
              onChange={(e) => setSeizureMotive(e.target.value as SeizureMotive | "")}
            >
              <option value="">{"— Seleccioná un motivo —"}</option>
              {(Object.entries(SEIZURE_MOTIVE_LABELS) as [SeizureMotive, string][]).map(
                ([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ),
              )}
            </OpSelect>
          </div>

          {seizureMotive === "otro" && (
            <div>
              <label
                htmlFor="seizureMotiveOtherDetail"
                className="block text-sm font-medium text-ln-op-ink mb-1"
              >
                Detalle del motivo <span className="text-ln-op-danger">*</span>
              </label>
              <OpTextarea
                id="seizureMotiveOtherDetail"
                value={seizureMotiveOtherDetail}
                onChange={(e) => setSeizureMotiveOtherDetail(e.target.value)}
                rows={3}
                placeholder="Describí el motivo específico del decomiso"
                className="resize-none"
              />
            </div>
          )}

          <div>
            <label htmlFor="judicialRef" className="block text-sm font-medium text-ln-op-ink mb-1">
              Expediente judicial (opcional)
            </label>
            <OpInput
              id="judicialRef"
              type="text"
              value={judicialRef}
              onChange={(e) => setJudicialRef(e.target.value)}
              placeholder="Ej: EXP-2025-123456"
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-ln-op-ink mb-1">
              Denuncia de maltrato vinculada
            </span>
            {prefillWelfareReportRef ? (
              <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe/40 px-3 py-2">
                <p className="text-md font-ln-mono text-ln-op-ink">{prefillWelfareReportRef}</p>
                <p className="text-sm text-ln-op-mute mt-1">
                  Vinculada desde la denuncia de maltrato.
                </p>
              </div>
            ) : (
              <p className="text-sm text-ln-op-mute">
                Para vincular una denuncia, iniciá el decomiso desde la denuncia de maltrato con el
                botón “Ejecutar decomiso”.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="intakeCondition"
              className="block text-sm font-medium text-ln-op-ink mb-1"
            >
              Estado del animal al momento del decomiso (opcional)
            </label>
            <OpTextarea
              id="intakeCondition"
              value={intakeCondition}
              onChange={(e) => setIntakeCondition(e.target.value)}
              rows={2}
              placeholder="Descripción de la condición física / comportamental del animal"
              className="resize-none"
            />
          </div>
        </section>

        {/* --- Refugio destinatario --- */}
        <section className="rounded-[var(--radius-md)] border border-ln-op-line p-5 space-y-4">
          <h2 className="text-sm font-semibold text-ln-op-ink uppercase tracking-wider">
            3. Refugio destinatario
          </h2>
          <p className="text-sm text-ln-op-mute">
            Solo refugios y redes de rescate verificados. El refugio tiene 7 días para aceptar o
            rechazar el handoff.
          </p>

          {selectedOrg ? (
            <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-ln-op-blue-bd bg-ln-op-blue-bg px-4 py-3">
              <div>
                <p className="text-md font-medium text-ln-op-ink">{selectedOrg.displayName}</p>
                {/* Sin `capitalize`: el contenido ya viene bien escrito
                    ("Red de rescate", y una localidad con su nombre propio).
                    text-transform: capitalize sube la inicial de CADA palabra,
                    asi que convertia eso en "Red De Rescate". */}
                <p className="text-sm text-ln-op-mute">
                  {selectedOrg.orgType === "rescue_network" ? "Red de rescate" : "Refugio"}
                  {selectedOrg.jurisdictionLocality
                    ? ` · ${selectedOrg.jurisdictionLocality}, ${selectedOrg.jurisdictionProvince ?? ""}`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReceiverOrgId("")}
                className="text-sm text-ln-op-mute hover:text-ln-op-ink transition-colors"
              >
                Cambiar
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor="receiverSearch" className="block text-sm font-medium text-ln-op-ink">
                Buscar por nombre <span className="text-ln-op-danger">*</span>
              </label>
              <OpInput
                id="receiverSearch"
                type="text"
                value={receiverSearch}
                onChange={(e) => setReceiverSearch(e.target.value)}
                placeholder="Escribí para filtrar…"
              />
              {receiverOrgs.length === 0 ? (
                <p className="text-sm text-ln-op-mute py-2">
                  No hay refugios verificados disponibles. Contactá al administrador.
                </p>
              ) : (
                <ul className="max-h-48 overflow-y-auto divide-y divide-ln-op-line-2 rounded-[var(--radius-md)] border border-ln-op-line">
                  {filteredOrgs.slice(0, 50).map((org) => (
                    <li key={org.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setReceiverOrgId(org.id);
                          setReceiverSearch("");
                        }}
                        className="w-full text-left px-4 py-2.5 hover:bg-ln-op-stripe transition-colors"
                      >
                        <p className="text-md text-ln-op-ink">{org.displayName}</p>
                        {/* Sin `capitalize`: el contenido ya viene bien escrito
                    ("Red de rescate", y una localidad con su nombre propio).
                    text-transform: capitalize sube la inicial de CADA palabra,
                    asi que convertia eso en "Red De Rescate". */}
                        <p className="text-sm text-ln-op-mute">
                          {org.orgType === "rescue_network" ? "Red de rescate" : "Refugio"}
                          {org.jurisdictionLocality
                            ? ` · ${org.jurisdictionLocality}, ${org.jurisdictionProvince ?? ""}`
                            : ""}
                        </p>
                      </button>
                    </li>
                  ))}
                  {filteredOrgs.length === 0 && (
                    <li className="px-4 py-3 text-md text-ln-op-mute">
                      Sin resultados para &ldquo;{receiverSearch}&rdquo;.
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* --- Adjuntos --- */}
        <section className="rounded-[var(--radius-md)] border border-ln-op-line p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ln-op-ink uppercase tracking-wider">
              4. Adjuntos
            </h2>
            <span
              className={`text-sm px-2 py-0.5 rounded-full ${
                attachments.length >= 2
                  ? "bg-ln-op-ok-bg text-ln-op-ok"
                  : "bg-ln-op-warn-bg text-ln-op-warn"
              }`}
            >
              {attachments.length} / min. 2
            </span>
          </div>
          <p className="text-sm text-ln-op-mute">
            Obligatorio: al menos 1 foto del animal y el acta administrativa (foto o PDF, o el
            oficio judicial). Hasta {MAX_ATTACHMENTS} archivos JPG, PNG, WEBP o PDF de hasta{" "}
            {MAX_ATTACHMENT_MB} MB cada uno ({MAX_TOTAL_MB} MB en total).
          </p>

          {/* `status={null}` — the attachment list right below already names
              every selected file, so a second summary would say it twice. */}
          <OpFileInput
            ref={fileInputRef}
            multiple
            accept={DECOMISO_EVIDENCE_MIME_LIST.join(",")}
            onChange={(e) => handleFilesSelected(e.target.files)}
            status={null}
          />

          {attachmentError && (
            <p className="text-sm text-ln-op-danger rounded-[var(--radius-md)] bg-ln-op-danger-bg px-3 py-2">
              {attachmentError}
            </p>
          )}

          {attachments.length > 0 && (
            <ul className="space-y-2">
              {attachments.map((entry, i) => (
                <li
                  // name+size+index is a stable-enough composite key for this append-only list.
                  key={`${entry.file.name}-${entry.file.size}-${i}`}
                  className="flex items-center gap-3 rounded-[var(--radius-md)] border border-ln-op-line px-3 py-2"
                >
                  {entry.objectUrl ? (
                    <img
                      src={entry.objectUrl}
                      alt={entry.file.name}
                      className="w-10 h-10 object-cover rounded-[var(--radius-sm)] flex-shrink-0 border border-ln-op-line"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-[var(--radius-sm)] bg-ln-op-stripe flex items-center justify-center flex-shrink-0 text-ln-op-mute">
                      {entry.file.type === "application/pdf" ? (
                        <Icon name="nota" size={20} decorative />
                      ) : (
                        <Icon name="reproducir" size={20} decorative />
                      )}
                    </div>
                  )}
                  <span className="text-sm text-ln-op-ink truncate flex-1">{entry.file.name}</span>
                  <span className="text-sm text-ln-op-mute flex-shrink-0">
                    {formatRate(entry.file.size / 1024 / 1024)} MB
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    aria-label={`Quitar ${entry.file.name}`}
                    // 24px, the WCAG 2.5.8 AA target floor. This one was always
                    // VISIBLE (unlike its two denuncia twins) but shared their
                    // 20px size. e2e/mobile-390.spec.ts checks that floor on
                    // this very page and passed anyway — it never attaches a
                    // file, so the button does not exist when it measures.
                    className="flex-shrink-0 w-6 h-6 rounded-full bg-ln-op-stripe text-ln-op-mute hover:bg-ln-op-line hover:text-ln-op-ink transition-colors inline-flex items-center justify-center"
                  >
                    <Icon name="close" size={14} decorative />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- Error global --- */}
        {formError && (
          <p
            className="text-md text-ln-op-danger rounded-[var(--radius-md)] bg-ln-op-danger-bg border border-ln-op-danger-bd px-4 py-3"
            role="alert"
          >
            {formError}
          </p>
        )}

        {/* --- Submit --- */}
        <OpButton
          ref={submitRef}
          type="button"
          onClick={handleSubmit}
          disabled={isPending}
          loading={isPending}
          variant="primary"
          block
          className="py-4"
        >
          {isPending ? "Ejecutando decomiso..." : "Ejecutar decomiso"}
        </OpButton>

        {/* CORRECTED 2026-08-17 (PO fix list, engram
            roadmap/decisiones-legales-flujos-2026-08-17 item 2b/2c). This said
            "Esta acción es irreversible". It is not, and our own codebase says
            so: returnCustodyToOwnerAction and reassignDecomisoToAnotherReceiver
            Action exist. What IS true is that the reversal has a hard expiry
            nobody was told about — validateReturnCustodyToOwner requires the
            seizing authority to still hold active shelter_custody, and
            accept-decomiso-handoff ends that row the instant the refugio
            accepts. So the window closes on a THIRD PARTY's action, not on a
            timer the funcionario controls. */}
        <p className="text-sm text-ln-op-mute text-center">
          El decomiso queda registrado en el sistema de casos y auditado. Podés devolver el animal
          al dueño o reasignar el destinatario{" "}
          <strong>mientras el refugio no acepte el traspaso</strong>; una vez que lo acepta, la
          custodia pasa a esa organización y esta autoridad ya no puede devolverla. El refugio
          destinatario recibirá una notificación de handoff y tiene 7 días para responder.
        </p>
      </div>

      {/* DC2 -- double-confirm modal for pets with an owner.
          RA-9 BR-1: this used to be a hand-rolled `<dialog open>` — the ATTRIBUTE,
          not showModal(). Non-modal by definition: no top layer, no inertness, no
          native `cancel`/Escape, and focus stayed on the submit button behind the
          overlay, so the funcionario could re-submit from behind the panel. Now it
          rides the vetted ConfirmDialog primitive (showModal focus trap + Escape +
          focus restore to the trigger + aria-describedby consequence). */}
      {petPreview && (
        <ConfirmDialog
          open={showConfirmModal}
          onClose={() => setShowConfirmModal(false)}
          onConfirm={executeDecomiso}
          title="Ejecutar decomiso"
          /* CORRECTED 2026-08-17 (PO fix list item 2a). This said "Esta acción
             está amparada en Ley 14.346". Ley 14.346 art. 1 establishes a CRIME
             ("Será reprimido con prisión de quince días a un año…"); it confers
             no administrative power of seizure. The product was telling the
             funcionario his act was legally covered at the exact moment he
             should have been doubting it. Nothing in this codebase sources the
             authority for the seizure, so the honest output is to make NO legal
             claim — not to swap in a different one. "Queda auditada" stays,
             because it is true (execute-decomiso writes decomiso_executed). */
          description={`Esta mascota tiene un dueño registrado. Vas a quitarle la custodia legal de ${petPreview.name}${
            petPreview.ownerDisplayName ? ` a ${petPreview.ownerDisplayName}` : " al dueño actual"
          }. El sistema le notificará que el animal fue decomisado. La acción queda auditada. Podés revertirla mientras el refugio destinatario no acepte el traspaso.`}
          confirmLabel="Ejecutar decomiso"
          tone="danger"
          pending={isPending}
          triggerRef={submitRef}
        >
          <p className="px-5 pb-1 text-md text-[var(--color-ln-ink-2)]">
            Motivo:{" "}
            <span className="font-medium text-[var(--color-ln-ink)]">
              {SEIZURE_MOTIVE_LABELS[seizureMotive as SeizureMotive]}
            </span>
            {seizureMotive === "otro" && seizureMotiveOtherDetail
              ? ` — ${seizureMotiveOtherDetail}`
              : ""}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
