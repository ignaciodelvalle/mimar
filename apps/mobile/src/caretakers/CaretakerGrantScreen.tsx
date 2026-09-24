// One caretaker invitation, and the answer to it — the INVITEE'S side.
//
// THE DEEP-LINK DESTINATION. `mimar://cuidado/{CG-…}` lands here, and so does the
// notification the designation queued (`ctaUrl: /cuidado/{token}`). It is
// therefore a screen a person can reach without having navigated to it, which
// changes two things:
//
//   · IT READS THE HUB, not a per-token endpoint. The union of the two lists
//     `/me/caretaker-grants` returns is exactly the set this caller is authorized
//     to see — the server built them with the same id-or-e-mail rule the accept
//     writer runs — so a token that is not in it is one this person may not read.
//     That is a fact the screen can state without a second round trip, and
//     without the server having to answer a question that would tell a stranger
//     whether a token is real.
//   · IT CANNOT ASSUME A PET. The person answering holds NO ownership row on the
//     animal — that is what an invitation is, and it may be the first animal they
//     have ever been responsible for. Nothing here reads a pet token from
//     anywhere but the invitation itself.
//
// THE SCOPE IS RENDERED BESIDE THE BUTTON THAT AGREES TO IT, never on a screen
// before it, and BOTH HALVES ALWAYS. It comes from the server (`scopeSentence`),
// because it is a promise about what the titular-only deny-list actually
// enforces: a copy on a phone would go on promising the old scope the day a row
// is added to `lib/domain/titular-only.ts`. A version that listed only the
// permissions would be recruiting caretakers on a half-truth.
//
// KEY 2 OF THE TWO-KEY PUBLIC-CONTACT MODEL LIVES ON THIS SCREEN AND NOWHERE
// ELSE. It is the only moment the caretaker is asked, and the repository writes it
// in the same UPDATE as the status flip — a CHECK constraint forbids a consent
// timestamp on a `pending` row — so there is no later screen that could collect
// it. It starts OFF: what it publishes is this person's name and phone on an
// unauthenticated credential page, and a pre-ticked box is a default nobody chose
// (PO decision 2, 2026-08-19). It is also only HALF the gate — the titular's own
// `discloseCaretakerContactWhenLost` is key 1 — and the copy says so, because
// consenting must not read as "my number will be published".
//
// ACCEPTING TAKES TWO TAPS. It opens an `ownerships` row and appends
// `caretaker_designated` to an append-only spine, and it makes this person
// responsible for an animal. The web asks twice for the same reason.

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import type { CaretakerCommandAckV1, MyCaretakerGrantV1 } from "@dim/contract/api";
import type { CaretakerCommandInput } from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { fetchMyCaretakerGrants, sendCaretakerCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { KEEP_DESTINATION_ON_SIGN_OUT } from "../auth/return-to";
import { sessionPort, signOut } from "../auth/session-store";
import { Body, Card, Loading, Row } from "../ui/components";
import { Callout, Choice, PrimaryButton, Screen, SecondaryButton, Title } from "../ui/kit";
import { SPACE } from "../ui/theme";

import {
  buildAcceptCaretakerGrant,
  buildRejectCaretakerGrant,
  caretakerCounterpartyLabel,
  caretakerHeadline,
  caretakerPeriodLabel,
  caretakerStatusLabel,
  findCaretakerGrant,
} from "./caretakers-view-model";

function failureMessage(result: ApiResult<unknown>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede leer esta pantalla. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos leer esta invitación.";
  }
}

/** Exhaustive over the contract's union, including the three this screen never sends. */
function ackLabel(ack: CaretakerCommandAckV1): string {
  switch (ack.command) {
    case "accept":
      return "Listo. Ya podés cargar eventos de esta mascota.";
    case "reject":
      return "Rechazaste la invitación. Le avisamos al titular.";
    case "designate":
      return "Invitación creada.";
    case "cancel":
      return "Retiraste la invitación.";
    case "revoke":
      return "Finalizaste el cuidado.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; grant: MyCaretakerGrantV1 }
  /** The command LANDED and this invitation is over. See `run` (A4-custodia-02). */
  | { phase: "done"; message: string }
  | { phase: "missing" }
  | { phase: "failed"; message: string };

type Notice = { tone: "ok" | "err"; message: string } | null;

/** The consent question, as a two-chip radio. Starts on "No". */
const CONSENT_OPTIONS = ["no", "si"] as const;
type Consent = (typeof CONSENT_OPTIONS)[number];

export function CaretakerGrantScreen({
  grantToken,
  onAccepted,
}: {
  grantToken: string;
  /** Where to go once this person is the caretaker. Given the pet's token. */
  onAccepted: (petPublicToken: string | null) => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingAccept, setConfirmingAccept] = useState(false);
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [consent, setConsent] = useState<Consent>("no");

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await fetchMyCaretakerGrants(sessionPort);
    if (result.outcome !== "ok") {
      setState({ phase: "failed", message: failureMessage(result) });
      return;
    }
    const found = findCaretakerGrant(result.payload, grantToken);
    setState(found === null ? { phase: "missing" } : { phase: "ready", grant: found });
  }, [grantToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (input: CaretakerCommandInput) => {
      setBusy(true);
      setNotice(null);
      const result = await sendCaretakerCommand(sessionPort, input);
      setBusy(false);
      setConfirmingAccept(false);
      setConfirmingReject(false);
      if (result.outcome !== "ok") {
        setNotice({ tone: "err", message: failureMessage(result) });
        // RE-READ ON FAILURE, ALWAYS. Without an idempotency key, a refusal after
        // a timeout may mean the first attempt landed.
        await load();
        return;
      }
      setNotice({ tone: "ok", message: ackLabel(result.payload) });
      if (result.payload.command === "accept") {
        onAccepted(result.payload.petPublicToken);
        return;
      }
      // A SUCCESSFUL REJECT IS NOT A RE-READ (A4-custodia-02). The hub carries
      // OPEN grants only, so the invitation this person just answered is gone
      // from it by construction — and re-loading turned their success into the
      // `missing` arm: "No encontramos esta invitación en tu cuenta. Puede que
      // ya no esté disponible o que no sea para vos", with a "Reintentar" that
      // can only ever produce the same screen. The server's own ack is the
      // truth here and it already says what happened.
      setState({ phase: "done", message: ackLabel(result.payload) });
    },
    [load, onAccepted],
  );

  if (state.phase === "loading") return <Loading label="Cargando la invitación…" />;

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Cuidado temporal</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  if (state.phase === "done") {
    return (
      <Screen>
        <Title>Cuidado temporal</Title>
        <Callout tone="ok">
          <Body>{state.message}</Body>
        </Callout>
      </Screen>
    );
  }

  if (state.phase === "missing") {
    // NOT "no existe", and not only for the usual reason. Two different things
    // put a caller here and the screen can distinguish neither: the invitation may
    // not be theirs, OR it may be a real one of theirs that was already answered,
    // withdrawn or swept — the hub carries OPEN grants only. Saying "no existe"
    // would be a lie in the second case and an oracle in the first.
    return (
      <Screen>
        <Title>Cuidado temporal</Title>
        <Card>
          <Body>
            No encontramos esta invitación en tu cuenta. Puede que ya no esté disponible o que no
            sea para vos.
          </Body>
          {/* THE REMEDY THE WEB GIVES AND THIS SCREEN DID NOT (A4-custodia-11),
              from `/cuidado/[grantToken]/page.tsx:86-89` — "Cerrá sesión y volvé
              a entrar con la cuenta que recibió la invitación". Without it the
              only control here is a "Reintentar" that produces the same screen.

              ONE SENTENCE PER CAUSE, AND THE REMEDY BELONGS TO ONE OF THEM
              (finding F9, review 2026-09-07). The comment above already names
              two causes and the copy then prescribed the account switch for
              both — including the one the hub makes commonest, a real invitation
              of theirs that was answered, withdrawn or swept. Telling that
              person to sign out is a remedy for nothing, and it costs them their
              session to go looking for something no account can show. The WEB
              may say it flatly because `relation === "outsider"` is a fact its
              reader resolved; this screen never learned who the addressee is. */}
          <Body>
            Si ya la aceptaste, la rechazaste o la dieron de baja, no vas a poder verla acá y no hay
            nada que hacer.
          </Body>
          <Body>
            Si en cambio tenés otra cuenta, puede que se la hayan enviado a ese correo: entrá con
            esa cuenta, o pedile a quien te invitó que la reenvíe a este correo.
          </Body>
        </Card>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
        {/* THE LABEL NAMES THE CASE IT BELONGS TO (finding F9): "Cerrar sesión"
            next to "puede que no sea para vos" reads as an instruction to
            whoever is looking at it, and this arm cannot tell who that is.
            "Entrar con otra cuenta" is a door for the reader who knows they have
            a second address and says nothing to the one whose invitation is
            simply closed.

            NOT `signOut(pathname)`: the gate suppresses `next` for the screen a
            person deliberately closed, and this sign-out exists to come back
            here. See `KEEP_DESTINATION_ON_SIGN_OUT`. */}
        <SecondaryButton
          label="Entrar con otra cuenta"
          onPress={() => void signOut(KEEP_DESTINATION_ON_SIGN_OUT)}
        />
      </Screen>
    );
  }

  const grant = state.grant;
  const counterparty = caretakerCounterpartyLabel(grant);
  const titular = grant.counterpartyName ?? "El titular";
  const { canAccept, canReject } = grant.capabilities;

  const accepted = buildAcceptCaretakerGrant(grant.grantToken, consent === "si");
  const rejected = buildRejectCaretakerGrant(grant.grantToken);

  return (
    <Screen>
      <Title>{caretakerHeadline(grant)}</Title>
      <Body>{caretakerStatusLabel(grant.status)}</Body>

      {notice !== null && (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      <Card title="Qué te están pidiendo">
        {counterparty !== null && <Body>{counterparty}</Body>}
        <Row label="Período" value={caretakerPeriodLabel(grant)} />
        {grant.note !== null && <Row label="Nota del titular" value={grant.note} />}
        {/* BOTH HALVES, ALWAYS, and from the server. See the header. */}
        <Row label="Qué podés hacer" value={grant.scopeSentence} />
      </Card>

      {/* EVERY CONTROL IS GATED ON A SERVER FLAG, never on `status`. The two are
          independent: an invitation whose period already lapsed can still be
          REJECTED and no longer accepted, which is the writers' own asymmetry. */}
      {canAccept && (
        <View style={styles.actions}>
          {confirmingAccept ? (
            <Callout tone="ok">
              <Body>
                Vas a quedar como cuidador/a temporal de {grant.pet.name}. {titular} puede finalizar
                el cuidado en cualquier momento.
              </Body>
              {/* KEY 2. Starts on "No" — silence is never consent — and the copy
                  says the other key is the titular's, so answering "Sí" is not the
                  same as "mi teléfono se publica". */}
              <Choice
                label={`Si ${grant.pet.name} se pierde, ¿permitís que ${titular} muestre tu contacto en la credencial pública?`}
                options={CONSENT_OPTIONS}
                selected={consent}
                optionLabel={(value) => (value === "si" ? "Sí" : "No")}
                onSelect={setConsent}
                disabled={busy}
              />
              <Body>Podés cuidarla igual sin aceptar esto.</Body>
              <PrimaryButton
                label={busy ? "Confirmando…" : "Confirmar el cuidado"}
                disabled={busy || !accepted.ok}
                onPress={() => accepted.ok && void run(accepted.input)}
              />
              <SecondaryButton
                label="No, volver"
                disabled={busy}
                onPress={() => setConfirmingAccept(false)}
              />
            </Callout>
          ) : (
            <PrimaryButton
              label="Aceptar el cuidado"
              disabled={busy}
              onPress={() => setConfirmingAccept(true)}
            />
          )}
        </View>
      )}

      {canReject && (
        <View style={styles.actions}>
          {confirmingReject ? (
            <Callout tone="warn">
              <Body>
                {titular} va a recibir el aviso de que no podés cuidar a {grant.pet.name}. Si
                cambiás de idea después, te tiene que invitar de nuevo.
              </Body>
              <PrimaryButton
                tone="seal"
                label={busy ? "Enviando…" : "Confirmar el rechazo"}
                disabled={busy || !rejected.ok}
                onPress={() => rejected.ok && void run(rejected.input)}
              />
              <SecondaryButton
                label="Volver"
                disabled={busy}
                onPress={() => setConfirmingReject(false)}
              />
            </Callout>
          ) : (
            <SecondaryButton
              label="Rechazar la invitación"
              disabled={busy}
              onPress={() => setConfirmingReject(true)}
            />
          )}
        </View>
      )}

      {/* NO CONTROL AT ALL for an arrangement this person already accepted, and
          that is the WEB'S state rather than an omission: a caretaker cannot step
          down from a browser either — `withdrawCaretakerGrantAction` exists and
          nothing calls it. Offering it here would be a native-only power. The
          sentence says who CAN end it, so nobody is left pressing at a screen. */}
      {!canAccept && !canReject && grant.status === "accepted" && (
        <Card>
          <Body>
            Este cuidado está activo hasta la fecha de arriba. Si necesitás terminarlo antes,
            coordinalo con {titular}: la finalización la hace el titular.
          </Body>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: SPACE.sm, marginTop: SPACE.md },
});
