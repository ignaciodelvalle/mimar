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

import type { PetProfileCommandInput } from "@dim/contract/input";
import { apiFailureMessage } from "../api/client";
import { fetchPetProfileEdit, sendPetProfileCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Loading, Unavailable } from "../ui/components";
import {
  Callout,
  Choice,
  DateField,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
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
        <Loading label="Leyendo…" />
      </Screen>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <Screen>
        <Unavailable title="Perro de asistencia" message={state.message} />
        <SecondaryButton
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
  const explanation = designation === null ? null : serviceDogStatusExplanation(designation);
  const set =
    <K extends keyof ServiceDogDraft>(key: K) =>
    (value: ServiceDogDraft[K]) =>
      setDraft((current) => ({ ...current, [key]: value }));
  const locked = busy || !actions.canSave;

  return (
    <Screen>
      <Title>{`Perro de asistencia · ${view.petName}`}</Title>
      <Body>
        Marco legal: Ley 26.858 (acceso, deambulación y permanencia). Reglamentación: Decreto
        792/2019. Registro: RUPGA (ANDIS, Res. 2588/2022).
      </Body>

      {designation !== null ? (
        <Card title="Estado de la credencial">
          <Body>{serviceDogStatusLabel(designation.credentialStatus)}</Body>
          <Body>{serviceDogSummary(designation)}</Body>
          {explanation !== null ? <Body>{explanation}</Body> : null}
        </Card>
      ) : null}

      <Callout tone="neutral" title="Sobre tu privacidad (Ley 25.326)">
        <Body>
          Registrar a tu perro como de asistencia revela información sobre tu discapacidad, que es
          un dato sensible. Por eso el banner público arranca apagado y tenés que activarlo vos.
          Solo se muestra cuando tu credencial está vigente y elegís hacerlo visible.
        </Body>
      </Callout>

      {designation !== null && actions.canToggleVisibility ? (
        <Card title="Banner público de acceso">
          <Body>
            Cuando lo activás, el perfil público de tu perro muestra el texto del derecho de acceso
            (Arts. 1 y 7, Ley 26.858). Podés mostrarlo en la puerta de un local o transporte.
          </Body>
          {designation.publicVisibility === "full_banner" ? (
            <SecondaryButton
              label="Mantener privado"
              disabled={busy}
              onPress={() =>
                void run({
                  command: "set_service_dog_visibility",
                  publicVisibility: "private_only",
                })
              }
            />
          ) : (
            <PrimaryButton
              label="Activar banner público"
              disabled={busy}
              onPress={() =>
                void run({ command: "set_service_dog_visibility", publicVisibility: "full_banner" })
              }
            />
          )}
        </Card>
      ) : null}

      <Card title={designation === null ? "Registrar como perro de asistencia" : "Datos"}>
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
          Las 5 categorías ANDIS habilitan el banner público. "Otro" guarda los datos pero no
          muestra banner (Res. ANDIS 2588/2022).
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
        <PrimaryButton
          label={busy ? "Guardando…" : "Guardar datos"}
          disabled={locked}
          onPress={save}
        />
        {actions.canRequestVerification ? (
          <SecondaryButton
            label="Solicitar verificación"
            disabled={busy}
            accessibilityHint="Envía los datos a la autoridad para que valide la credencial."
            onPress={() => void run({ command: "request_service_dog_verification" })}
          />
        ) : null}
      </Card>

      {notice !== null ? (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      ) : null}

      {actions.canRetire ? (
        confirmRetire ? (
          <Callout tone="warn" title="¿Retirar el perro del servicio?">
            <Body>
              Va a perder los derechos de acceso bajo la Ley 26.858 y el banner público deja de
              aparecer.
            </Body>
            <PrimaryButton
              tone="seal"
              label={busy ? "Retirando…" : "Confirmar retiro"}
              disabled={busy}
              onPress={() => void run({ command: "retire_service_dog" })}
            />
            <SecondaryButton
              label="Cancelar"
              disabled={busy}
              onPress={() => setConfirmRetire(false)}
            />
          </Callout>
        ) : (
          <SecondaryButton
            label="Retirar del servicio"
            disabled={busy}
            onPress={() => setConfirmRetire(true)}
          />
        )
      ) : null}
    </Screen>
  );
}
