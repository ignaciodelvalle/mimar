// PERRO DE ASISTENCIA — la designación de Ley 26.858, desde la app (D3,
// 2026-09-25). Until today the "⋯ Más" list showed an inert row that said
// "Se hace desde la web".
//
// THE SAME FOUR ACTS AS THE WEB, THROUGH THE SAME USE-CASES. Guardar datos,
// solicitar verificación, el banner público y retirar del servicio all post to
// `POST /pets/{token}/profile`, whose commands call the functions
// `app/actions/service-dog.ts` calls. Who may act is `canManageServiceDog` on
// the GET — the legal owner alone, like the web page — and which act is offered
// in which state is `serviceDogActions`, transcribed from `ServiceDogForm`.
//
// AFTER EVERY ACT THE SCREEN RE-READS, the way the web form reloads its page:
// the acks carry no state, and the banner a person turns on here is a public
// legal statement, so the screen shows what the server stored rather than what
// it sent.

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { ServiceDogDesignationV1 } from "@dim/contract/api";
import type { PetProfileCommandInput } from "@dim/contract/input";
import { apiFailureMessage } from "../api/client";
import { fetchPetProfileEdit, sendPetProfileCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Unavailable } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  type CalloutTone,
  Choice,
  CollapsibleModule,
  DateField,
  Eyebrow,
  ListRow,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";
import {
  SERVICE_DOG_TYPE_OPTIONS,
  type ServiceDogDraft,
  type ServiceDogScreenView,
  buildSaveServiceDog,
  serviceDogActions,
  serviceDogDraftFrom,
  serviceDogSavedLabel,
  serviceDogScreenView,
  serviceDogStatusExplanation,
  serviceDogStatusLabel,
  serviceDogSummary,
  serviceDogTypeLabel,
} from "./service-dog-view-model";

type State =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "loaded"; view: ServiceDogScreenView };

export function ServiceDogScreen({ publicToken }: { publicToken: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [draft, setDraft] = useState<ServiceDogDraft>(serviceDogDraftFrom(null));
  const [busy, setBusy] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  // "Datos de la credencial" starts folded on an existing credential: the
  // state and its one act lead, the twelve fields wait behind a tap.
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; message: string } | null>(null);

  const load = useCallback(async () => {
    const result = await fetchPetProfileEdit(sessionPort, publicToken);
    if (result.outcome !== "ok") {
      setState({
        kind: "unavailable",
        message: apiFailureMessage(result) ?? "No pudimos leer esta sección.",
      });
      return;
    }
    const view = serviceDogScreenView(result.payload);
    setState({ kind: "loaded", view });
    if (view.kind === "ready") setDraft(serviceDogDraftFrom(view.designation));
  }, [publicToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (input: PetProfileCommandInput) => {
      setNotice(null);
      setBusy(true);
      const result = await sendPetProfileCommand(sessionPort, publicToken, input);
      setBusy(false);
      setConfirmRetire(false);
      if (result.outcome !== "ok") {
        setNotice({
          tone: "err",
          message: apiFailureMessage(result) ?? "No pudimos guardar los cambios.",
        });
        return;
      }
      const label = serviceDogSavedLabel(result.payload);
      setNotice(
        label === null
          ? { tone: "err", message: "La respuesta del servidor no se pudo leer." }
          : { tone: "ok", message: label },
      );
      await load();
    },
    [load, publicToken],
  );

  const save = useCallback(() => {
    const built = buildSaveServiceDog(draft);
    if (!built.ok) {
      setNotice({ tone: "err", message: built.message });
      return;
    }
    void run(built.input);
  }, [draft, run]);

  if (state.kind === "loading") {
    return (
      <Screen>
        <Title>Perro de asistencia</Title>
        <ListSkeleton rows={2} label="Leyendo…" />
      </Screen>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <Screen>
        <Unavailable title="Perro de asistencia" message={state.message} />
        <PrimaryButton
          label="Volver a intentar"
          onPress={() => {
            setState({ kind: "loading" });
            void load();
          }}
        />
      </Screen>
    );
  }

  const { view } = state;

  if (view.kind === "forbidden") {
    return (
      <Screen>
        <Title>Perro de asistencia</Title>
        {/* The web page's own notice for every holder who is not the legal owner. */}
        <Callout
          tone="warn"
          title="La credencial de asistencia se registra solo bajo dueño legal permanente."
        >
          <Body>
            Para registrar al animal como de asistencia, primero debe completarse la transferencia
            legal de custodia.
          </Body>
        </Callout>
      </Screen>
    );
  }

  if (view.kind === "not_a_dog") {
    return (
      <Screen>
        <Title>{`Perro de asistencia · ${view.petName}`}</Title>
        <Callout tone="warn">
          <Body>
            La Ley 26.858 reconoce este derecho de acceso solo para perros. Esta sección no aplica a{" "}
            {view.petName}.
          </Body>
        </Callout>
      </Screen>
    );
  }

  const { designation } = view;
  const actions = serviceDogActions(designation);
  const locked = busy || !actions.canSave;
  // Saving is the primary when nothing else is: a registration, or a credential
  // whose state offers no act of its own (vencida, retired). Otherwise the
  // state's act leads and saving is secondary (custody polish).
  const hasStateAct =
    actions.canRequestVerification ||
    (actions.canToggleVisibility && designation?.publicVisibility !== "full_banner");
  const form = (
    <ServiceDogForm
      draft={draft}
      onDraft={setDraft}
      locked={locked}
      busy={busy}
      // Never a second primary beside the retire confirmation either.
      tone={hasStateAct || confirmRetire ? "secondary" : "primary"}
      onSave={save}
    />
  );

  return (
    <Screen>
      <Title>{`Perro de asistencia · ${view.petName}`}</Title>

      {notice !== null ? (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      ) : null}

      {designation === null ? (
        <>
          <PrivacyNote />
          <View style={styles.section}>
            <Eyebrow>Registrar como perro de asistencia</Eyebrow>
            {form}
          </View>
        </>
      ) : (
        <>
          <Callout
            tone={STATUS_TONE[designation.credentialStatus]}
            title={serviceDogStatusLabel(designation.credentialStatus)}
          >
            <Body>{serviceDogSummary(designation)}</Body>
            {serviceDogStatusExplanation(designation) !== null ? (
              <Body>{serviceDogStatusExplanation(designation)}</Body>
            ) : null}
          </Callout>

          <DesignationActions
            designation={designation}
            busy={busy}
            confirmRetire={confirmRetire}
            onConfirmRetire={setConfirmRetire}
            onRun={(input) => void run(input)}
          />

          <CollapsibleModule
            title="Datos de la credencial"
            summary={actions.canSave ? "Centro, certificado y número RUPGA." : "Solo lectura."}
            open={formOpen}
            onToggle={() => setFormOpen((open) => !open)}
          >
            <View style={styles.moduleBody}>{form}</View>
          </CollapsibleModule>

          <PrivacyNote />
        </>
      )}

      <Text style={styles.fine}>
        Marco legal: Ley 26.858 (acceso, deambulación y permanencia). Reglamentación: Decreto
        792/2019. Registro: RUPGA (ANDIS, Res. 2588/2022).
      </Text>
    </Screen>
  );
}

/** The status callout's tone: the credential's state, said in colour too. */
const STATUS_TONE: Record<ServiceDogDesignationV1["credentialStatus"], CalloutTone> = {
  en_entrenamiento: "neutral",
  pendiente_verificacion: "neutral",
  vigente: "ok",
  vencida: "warn",
  revocada: "err",
};

function PrivacyNote() {
  return (
    <Callout tone="neutral" title="Sobre tu privacidad (Ley 25.326)">
      <Body>
        Registrar a tu perro como de asistencia revela información sobre tu discapacidad, que es un
        dato sensible. Por eso el banner público arranca apagado y tenés que activarlo vos. Solo se
        muestra cuando tu credencial está vigente y elegís hacerlo visible.
      </Body>
    </Callout>
  );
}

/**
 * The acts on an existing credential, ONE PRIMARY PER STATE (custody polish,
 * 2026-10-07): "Solicitar verificación" while the authority has not validated
 * it, "Activar banner público" once it is vigente and private. Turning the
 * banner off and retiring are rows. Retiring keeps its two steps.
 */
function DesignationActions({
  designation,
  busy,
  confirmRetire,
  onConfirmRetire,
  onRun,
}: {
  designation: ServiceDogDesignationV1;
  busy: boolean;
  confirmRetire: boolean;
  onConfirmRetire: (confirming: boolean) => void;
  onRun: (input: PetProfileCommandInput) => void;
}) {
  const actions = serviceDogActions(designation);
  const bannerOn = designation.publicVisibility === "full_banner";
  // Inert rows (no `onPress`) while a command is in flight.
  const unlessBusy = (press: () => void) => (busy ? undefined : press);

  if (confirmRetire && actions.canRetire) {
    return (
      <Callout tone="warn" title="¿Retirar el perro del servicio?">
        <Body>
          Va a perder los derechos de acceso bajo la Ley 26.858 y el banner público deja de
          aparecer.
        </Body>
        <PrimaryButton
          tone="seal"
          label={busy ? "Retirando…" : "Confirmar retiro"}
          disabled={busy}
          onPress={() => onRun({ command: "retire_service_dog" })}
        />
        <SecondaryButton label="Cancelar" disabled={busy} onPress={() => onConfirmRetire(false)} />
      </Callout>
    );
  }

  return (
    <>
      {actions.canRequestVerification ? (
        <PrimaryButton
          label="Solicitar verificación"
          disabled={busy}
          onPress={() => onRun({ command: "request_service_dog_verification" })}
        />
      ) : null}
      {/* The old button's accessibilityHint, now said to everyone: the kit's
          PrimaryButton takes no hint, and what the act does matters to a
          sighted reader too. */}
      {actions.canRequestVerification ? (
        <Body>Envía los datos a la autoridad para que valide la credencial.</Body>
      ) : null}
      {actions.canToggleVisibility && !bannerOn ? (
        <PrimaryButton
          label="Activar banner público"
          disabled={busy}
          onPress={() =>
            onRun({ command: "set_service_dog_visibility", publicVisibility: "full_banner" })
          }
        />
      ) : null}
      {actions.canToggleVisibility ? (
        <Body>
          Cuando lo activás, el perfil público de tu perro muestra el texto del derecho de acceso
          (Arts. 1 y 7, Ley 26.858). Podés mostrarlo en la puerta de un local o transporte.
        </Body>
      ) : null}
      {actions.canToggleVisibility && bannerOn ? (
        <ListRow
          label="Mantener privado"
          caption="Saca el banner del perfil público."
          onPress={unlessBusy(() =>
            onRun({ command: "set_service_dog_visibility", publicVisibility: "private_only" }),
          )}
        />
      ) : null}
      {actions.canRetire ? (
        <ListRow
          label="Retirar del servicio"
          caption="Pierde los derechos de acceso. Te pedimos confirmación."
          onPress={unlessBusy(() => onConfirmRetire(true))}
        />
      ) : null}
    </>
  );
}

/** The designation's fields — the web's `ServiceDogForm`, field for field. */
function ServiceDogForm({
  draft,
  onDraft,
  locked,
  busy,
  tone,
  onSave,
}: {
  draft: ServiceDogDraft;
  onDraft: (update: (current: ServiceDogDraft) => ServiceDogDraft) => void;
  locked: boolean;
  busy: boolean;
  tone: "primary" | "secondary";
  onSave: () => void;
}) {
  const set =
    <K extends keyof ServiceDogDraft>(key: K) =>
    (value: ServiceDogDraft[K]) =>
      onDraft((current) => ({ ...current, [key]: value }));
  const SaveButton = tone === "primary" ? PrimaryButton : SecondaryButton;
  return (
    <>
      <Choice
        label="Tipo de servicio"
        required
        options={SERVICE_DOG_TYPE_OPTIONS}
        selected={draft.serviceType}
        optionLabel={serviceDogTypeLabel}
        onSelect={set("serviceType")}
        disabled={locked}
      />
      <Body>
        Las 5 categorías ANDIS habilitan el banner público. "Otro" guarda los datos pero no muestra
        banner (Res. ANDIS 2588/2022).
      </Body>
      <TextField
        label="Centro de entrenamiento"
        required
        value={draft.trainingCenter}
        onChangeText={set("trainingCenter")}
        placeholder="Ej.: Bocalan Argentina, miembro IGDF/ADI"
        editable={!locked}
      />
      <DateField
        label="Fecha del certificado del centro"
        value={draft.trainingCertDate}
        onChangeText={set("trainingCertDate")}
        editable={!locked}
      />
      <TextField
        label="Número RUPGA"
        mono
        value={draft.rupgaCredential}
        onChangeText={set("rupgaCredential")}
        placeholder="Si ya lo tenés"
        editable={!locked}
      />
      <DateField
        label="Emisión de la credencial"
        value={draft.credentialIssueDate}
        onChangeText={set("credentialIssueDate")}
        editable={!locked}
      />
      <DateField
        label="Vencimiento de la credencial"
        value={draft.credentialExpiryDate}
        onChangeText={set("credentialExpiryDate")}
        editable={!locked}
      />
      <TextField
        label="Notas (opcional)"
        value={draft.notes}
        onChangeText={set("notes")}
        multiline
        editable={!locked}
      />
      <SaveButton
        label={busy ? "Guardando…" : "Guardar datos"}
        disabled={locked}
        onPress={onSave}
      />
    </>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.lg },
  moduleBody: { gap: SPACE.lg, padding: SPACE.md + 2 },
  fine: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.xs,
    lineHeight: TYPE.xs * LEADING.xs,
    color: COLORS.inkMuted,
  },
});
