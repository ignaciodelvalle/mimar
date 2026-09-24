// TRÁNSITO — a volunteer's own inbox: proposals awaiting an answer, the
// foster they are looking after today, and the ones that already ended.
//
// THE CITIZEN'S SLICE OF A FOURTEEN-USE-CASE MODULE. `src/modules/foster` is
// mostly the ORG'S (proponer, asignar, buscar el pool) and has no bearer door
// here — see `@dim/contract/input`'s `foster.ts`. This screen offers exactly
// the two things a volunteer can do about a proposal addressed to them
// (aceptar, rechazar) and reads what came of one.
//
// NO CONTROL GATES ON `capabilities`, unlike `CaretakerGrantScreen`, because
// there is none to gate on: `proposals` carries only `status: "pending"`
// rows, so every one on screen is, by construction, one this caller may
// answer — see `foster-view-model.ts`'s header.
//
// KEEPS WHAT IS ON SCREEN THROUGH AN OUTAGE (S-2 / `reload-state.ts`). A
// pending proposal is an animal waiting for a home; a failed pull-to-refresh
// must not make it disappear.

import { useCallback, useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";

import type { MyFosterOwnershipV1, MyFosterProposalV1, MyFosterV1 } from "@dim/contract/api";
import type { FosterCommandInput } from "@dim/contract/input";

import { apiFailureMessage } from "../api/client";
import { fetchMyFoster, sendFosterCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, EmptyState, Row, StaleNotice } from "../ui/components";
import {
  Callout,
  Choice,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, SPACE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import {
  FOSTER_REJECTION_REASONS,
  FOSTER_REJECTION_REASON_LABELS,
  type FosterRejectionReason,
  buildAcceptFosterProposal,
  buildRejectFosterProposal,
  fosterOwnershipHeadline,
  fosterOwnershipMetaLabel,
  fosterProposalHeadline,
  fosterProposalMetaLabel,
} from "./foster-view-model";

type ScreenState =
  | { phase: "loading" }
  | ReadyState<MyFosterV1>
  | { phase: "failed"; message: string };

type Notice = { tone: "ok" | "err"; message: string } | null;

/** Which proposal's answer panel is open, and which answer it is drafting. */
type Panel = { proposalToken: string; mode: "accept" | "reject" } | null;

function ackLabel(input: FosterCommandInput): string {
  return input.command === "accept"
    ? "Listo. Ya podés ver el tránsito en tu lista."
    : "Rechazaste la propuesta. Le avisamos al refugio.";
}

export function FosterScreen({ onOpenPet }: { onOpenPet: (petPublicToken: string) => void }) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [allowCoFoster, setAllowCoFoster] = useState(false);
  const [reason, setReason] = useState<FosterRejectionReason | null>(null);
  const [notes, setNotes] = useState("");

  const load = useCallback(async (mode: "initial" | "refresh" = "initial") => {
    if (mode === "refresh") setRefreshing(true);
    else setState({ phase: "loading" });
    const result = await fetchMyFoster(sessionPort);
    if (mode === "refresh") setRefreshing(false);
    if (result.outcome === "ok") {
      setState(loaded(result.payload));
      return;
    }
    // KEEPING WHAT IS ON SCREEN (S-2): a pending proposal and an active
    // foster are both live facts a failed refresh must not delete.
    setState((current) =>
      reloadFailed(current, result, apiFailureMessage(result) ?? "No pudimos leer tu tránsito."),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useReconnect(() => void load("refresh"));

  const closePanel = useCallback(() => {
    setPanel(null);
    setAllowCoFoster(false);
    setReason(null);
    setNotes("");
  }, []);

  const run = useCallback(
    async (input: FosterCommandInput) => {
      setBusy(true);
      setNotice(null);
      const result = await sendFosterCommand(sessionPort, input);
      setBusy(false);
      if (result.outcome !== "ok") {
        setNotice({
          tone: "err",
          message: apiFailureMessage(result) ?? "No pudimos completar la acción.",
        });
        // RE-READ ON FAILURE, ALWAYS. Neither command carries an idempotency
        // key, so a refusal after a timeout may mean the first attempt
        // landed — see `foster.ts`'s header.
        await load("refresh");
        return;
      }
      setNotice({ tone: "ok", message: ackLabel(input) });
      closePanel();
      await load("refresh");
    },
    [load, closePanel],
  );

  if (state.phase === "loading") {
    return (
      <Screen>
        <ListSkeleton rows={3} label="Cargando tu tránsito…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Tránsito</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const { proposals, fosters } = state.view;
  const active = fosters.filter((f) => f.active);
  const ended = fosters.filter((f) => !f.active);
  const nothingToShow = proposals.length === 0 && fosters.length === 0;

  return (
    <Screen
      refreshControl={
        <RefreshControl
          colors={[COLORS.accent]}
          onRefresh={() => void load("refresh")}
          refreshing={refreshing}
          tintColor={COLORS.accent}
        />
      }
    >
      <Title>Tránsito</Title>
      <Body>Cuidás mascotas de un refugio por un tiempo, mientras encuentran un hogar.</Body>

      {state.staleFailure === null ? null : (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      )}

      {notice !== null && (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      {nothingToShow && (
        <EmptyState
          headline="Todavía no tenés tránsitos"
          body="Cuando un refugio te proponga cuidar una mascota, la vas a ver acá."
        />
      )}

      {proposals.length > 0 && (
        <Card title="Propuestas">
          {proposals.map((proposal) => (
            <ProposalRow
              key={proposal.proposalToken}
              proposal={proposal}
              open={panel !== null && panel.proposalToken === proposal.proposalToken}
              mode={
                panel !== null && panel.proposalToken === proposal.proposalToken ? panel.mode : null
              }
              busy={busy}
              allowCoFoster={allowCoFoster}
              reason={reason}
              notes={notes}
              onOpen={(mode) => {
                closePanel();
                setPanel({ proposalToken: proposal.proposalToken, mode });
              }}
              onCancel={closePanel}
              onAllowCoFosterChange={setAllowCoFoster}
              onReasonChange={setReason}
              onNotesChange={setNotes}
              onConfirmAccept={() => {
                const built = buildAcceptFosterProposal(
                  proposal.proposalToken,
                  allowCoFoster,
                  notes,
                );
                if (!built.ok) {
                  setNotice({ tone: "err", message: built.message });
                  return;
                }
                void run(built.input);
              }}
              onConfirmReject={() => {
                if (reason === null) {
                  setNotice({ tone: "err", message: "Elegí un motivo de la lista." });
                  return;
                }
                const built = buildRejectFosterProposal(proposal.proposalToken, reason, notes);
                if (!built.ok) {
                  setNotice({ tone: "err", message: built.message });
                  return;
                }
                void run(built.input);
              }}
            />
          ))}
        </Card>
      )}

      {active.length > 0 && (
        <Card title="Tránsito activo">
          {active.map((foster) => (
            <FosterRow key={foster.fosterOwnershipId} foster={foster} onOpenPet={onOpenPet} />
          ))}
        </Card>
      )}

      {ended.length > 0 && (
        <Card title="Historial">
          {ended.map((foster) => (
            <FosterRow key={foster.fosterOwnershipId} foster={foster} onOpenPet={onOpenPet} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

function ProposalRow({
  proposal,
  open,
  mode,
  busy,
  allowCoFoster,
  reason,
  notes,
  onOpen,
  onCancel,
  onAllowCoFosterChange,
  onReasonChange,
  onNotesChange,
  onConfirmAccept,
  onConfirmReject,
}: {
  proposal: MyFosterProposalV1;
  open: boolean;
  mode: "accept" | "reject" | null;
  busy: boolean;
  allowCoFoster: boolean;
  reason: FosterRejectionReason | null;
  notes: string;
  onOpen: (mode: "accept" | "reject") => void;
  onCancel: () => void;
  onAllowCoFosterChange: (value: boolean) => void;
  onReasonChange: (value: FosterRejectionReason) => void;
  onNotesChange: (value: string) => void;
  onConfirmAccept: () => void;
  onConfirmReject: () => void;
}) {
  return (
    <View style={styles.row}>
      <Body>{fosterProposalHeadline(proposal)}</Body>
      <Row label="Detalle" value={fosterProposalMetaLabel(proposal)} />
      {proposal.proposedNotes !== null && (
        <Row label="Notas del refugio" value={proposal.proposedNotes} />
      )}

      {open && mode === "accept" && (
        <Callout tone="ok">
          <Body>Vas a quedar como tránsito de {proposal.pet.name}.</Body>
          <Choice
            label="¿Permitís que el refugio asigne otro co-foster mientras lo cuidás?"
            options={["no", "si"] as const}
            selected={allowCoFoster ? "si" : "no"}
            optionLabel={(value) => (value === "si" ? "Sí" : "No")}
            onSelect={(value) => onAllowCoFosterChange(value === "si")}
            disabled={busy}
          />
          <TextField
            label="Notas para el refugio (opcional)"
            value={notes}
            onChangeText={onNotesChange}
            multiline
          />
          <PrimaryButton
            label={busy ? "Confirmando…" : "Confirmar aceptación"}
            disabled={busy}
            onPress={onConfirmAccept}
          />
          <SecondaryButton label="Volver" disabled={busy} onPress={onCancel} />
        </Callout>
      )}

      {open && mode === "reject" && (
        <Callout tone="warn">
          <Choice
            label="Motivo"
            options={FOSTER_REJECTION_REASONS}
            selected={reason}
            optionLabel={(value) => FOSTER_REJECTION_REASON_LABELS[value]}
            onSelect={onReasonChange}
            disabled={busy}
          />
          <TextField
            label="Notas (opcional)"
            value={notes}
            onChangeText={onNotesChange}
            multiline
          />
          <PrimaryButton
            tone="seal"
            label={busy ? "Enviando…" : "Confirmar rechazo"}
            disabled={busy}
            onPress={onConfirmReject}
          />
          <SecondaryButton label="Volver" disabled={busy} onPress={onCancel} />
        </Callout>
      )}

      {!open && (
        <View style={styles.actions}>
          <PrimaryButton
            label="Aceptar propuesta"
            disabled={busy}
            onPress={() => onOpen("accept")}
          />
          <SecondaryButton label="Rechazar" disabled={busy} onPress={() => onOpen("reject")} />
        </View>
      )}
    </View>
  );
}

function FosterRow({
  foster,
  onOpenPet,
}: {
  foster: MyFosterOwnershipV1;
  onOpenPet: (petPublicToken: string) => void;
}) {
  return (
    <View style={styles.row}>
      <Body>{fosterOwnershipHeadline(foster)}</Body>
      <Row label="Detalle" value={fosterOwnershipMetaLabel(foster)} />
      <SecondaryButton label="Ver la ficha" onPress={() => onOpenPet(foster.pet.publicToken)} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: SPACE.xs, marginBottom: SPACE.md },
  actions: { flexDirection: "row", gap: SPACE.sm, marginTop: SPACE.xs },
});
