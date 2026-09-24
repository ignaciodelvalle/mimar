// BUSCAR UN TURNO — the service picker, and one service's results.
//
// ONE SCREEN FOR TWO STATES, which is what the endpoint answers and what the web
// does on one URL. With no service chosen it draws the catalogue; with one, the
// offerings near the person that still have a place. Splitting them into two
// native routes would have added a screen, a back step and a second fetch to
// render a twelve-row constant.
//
// THE CATALOGUE IS THE SERVER'S. Twelve labels hard-coded here would print a
// stale one the day a kind is added, and a raw `snake_case` code is the exact
// defect QA 2026-08-08 (S3-F07) found on the web's version of this page.
//
// WHERE THE SEARCH LOOKS, AND WHO DECIDED THAT
// ---------------------------------------------------------------------------
// The server prefills the search from the person's first registered animal when
// they named no place. The browser draws those values into its own filter form,
// where they read as something the person typed — so somebody whose pet is
// registered in another province concludes their barrio has no campaigns when
// they never chose their barrio. `jurisdictionSource` is on the wire so this
// screen can say which of the two happened, and it still does.
//
// THE LOCALITY IS NOW CHOOSABLE HERE (PO decision, 2026-09-04). Until then this
// screen drew a sentence naming the zone and an empty state that sent people to
// the website to look anywhere else — a phone app telling you to go use a
// browser. Nothing on the wire had to change for it: the request already took
// `province` and `locality` (`app/api/v1/appointments/query.ts`), the route
// already reported `jurisdictionSource: "requested"` when both were supplied
// (`route.ts`), and `fetchAppointmentSearch` already put them on the query
// string. Only this screen never sent them.
//
// THE ROW IS THE DISCLOSURE AND THE CONTROL, ONE THING. The zone is named in
// exactly one place, and that place is the button that changes it — so the label
// and the search it describes cannot drift. The picker behind it is
// `pets/LocalityPicker`, the same typeahead over `ar_localities` the alta and the
// mudanza use; a second locality control in this app would be a second thing to
// keep in step with the catalogue.
//
// THE CHOICE LASTS THE SCREEN SESSION AND IS NOT STORED. Nothing here writes to
// disk: leaving and coming back returns to the pet's own zone, which is the
// default a person did not have to think about. Persisting it would mean a
// stale zone silently outliving the reason it was picked — somebody who looked
// at their mother's barrio once, then wonders for weeks why their own campaigns
// are missing.

import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { AppointmentSearchV1, BookableOfferingV1 } from "@dim/contract/api";

import type { ApiResult } from "../api/client";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, EmptyState, Loading } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, Eyebrow, ListRow, Screen, SecondaryButton, Title } from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";

import { fetchAppointmentSearch } from "../api/endpoints";
import { LocalityPicker } from "../pets/LocalityPicker";
import {
  jurisdictionNoteLabel,
  jurisdictionRowCaption,
  jurisdictionRowLabel,
  noResultsLabel,
  offeringAvailabilityLabel,
  offeringKindLabel,
  offeringMetaLabel,
  offeringTitle,
} from "./buscar-view-model";
import { appointmentProviderLabel } from "./turnos-view-model";

/** One sentence per failure arm. No arm falls through to a generic shrug. */
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
      return "No pudimos buscar turnos.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; view: AppointmentSearchV1 }
  | { phase: "failed"; message: string };

/**
 * A locality this person CHOSE, as the search names it.
 *
 * THE PROVINCE IS THE DISPLAY NAME AND NOT THE ISO CODE. The search matches
 * `service_offerings.jurisdiction_province`, which stores "Buenos Aires" and not
 * "AR-B"; sending the code returns an empty result rather than an error, which is
 * the kind of wrong that reads as "there are no campaigns here".
 */
type ChosenPlace = { provinceName: string; localityName: string };

export function BuscarTurnoScreen({
  onOpenOffering,
}: {
  onOpenOffering: (offeringToken: string) => void;
}) {
  const [serviceKind, setServiceKind] = useState<string | null>(null);
  // `null` MEANS "LET THE SERVER DECIDE", not "no locality". The server's default
  // is the person's first registered animal, and this screen deliberately does
  // NOT re-derive it: that would be a second copy of a rule the wire already
  // answers, and the answer comes back on every response as `appliedLocality`.
  const [chosen, setChosen] = useState<ChosenPlace | null>(null);
  const [picking, setPicking] = useState(false);
  const [state, setState] = useState<ScreenState>({ phase: "loading" });

  const load = useCallback(async (kind: string | null, place: ChosenPlace | null) => {
    setState({ phase: "loading" });
    const result = await fetchAppointmentSearch(sessionPort, {
      serviceKind: kind,
      // OMITTED ENTIRELY WHEN NOTHING WAS CHOSEN, rather than sent as null. The
      // route runs its first-pet prefill only when a half is missing from the
      // query string, so an explicit empty value would be a request to search
      // nowhere in particular and would suppress the default.
      ...(place === null ? {} : { province: place.provinceName, locality: place.localityName }),
    });
    if (result.outcome === "ok") {
      setState({ phase: "ready", view: result.payload });
      return;
    }
    setState({ phase: "failed", message: failureMessage(result) });
  }, []);

  useEffect(() => {
    void load(serviceKind, chosen);
  }, [load, serviceKind, chosen]);

  if (state.phase === "loading") {
    return <Loading label={serviceKind ? "Buscando turnos…" : "Cargando servicios…"} />;
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Buscar turno</Title>
        {/* NOT an empty catalogue. A read that failed and a service with no
            campaigns are different facts, and the first rendered as the second
            sends somebody away from a vaccination drive that is running. */}
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load(serviceKind, chosen)} />
      </Screen>
    );
  }

  const view = state.view;

  // CHOOSING THE ZONE — a full screen, not a sheet or an inline field.
  //
  // The typeahead draws up to eight result rows under an open keyboard, and
  // squeezing that under a list of offerings puts the thing you are reading and
  // the thing you are typing into a fight for the same 200px. Taking the screen is
  // also what makes the back affordance obvious, which matters because this
  // control can be opened by accident from a row the whole width of the display.
  //
  // NO CURRENT VALUE IS PASSED TO THE PICKER (`provinceCode`/`localityName` are
  // empty). Its "selected" chip is for a form field that holds a value; here the
  // current zone is already on the row behind this screen, and pre-filling the
  // chip would draw it twice and invite a tap that clears it to nothing.
  if (picking) {
    return (
      <Screen>
        <Title>Elegir localidad</Title>
        <Body>Buscá la localidad donde querés que miMAR busque turnos.</Body>
        <View style={styles.section}>
          <LocalityPicker
            provinceCode=""
            localityName=""
            // NOT OBLIGATORIA HERE, and the picker defaults to saying it is.
            // The alta and the mudanza refuse to submit without a locality;
            // this one is a zone FILTER over the search, and a person who
            // leaves it alone gets the server's default zone rather than an
            // error. Announcing ", obligatorio" would tell a screen-reader user
            // to fill in a field they may skip.
            required={false}
            onSelect={(selection) => {
              // THE CLEAR ARM IS NOT A CHOICE. `LocalityPicker` emits empty
              // strings when its "Cambiar" chip is tapped to reset, and treating
              // that as a selection would search a place called "" — a national
              // search wearing the label of whatever was last typed.
              //
              // IT CANNOT FIRE FROM HERE TODAY and is kept anyway: the chip is
              // drawn only when the picker is given a non-empty current value,
              // and this call site deliberately passes none (see above). The
              // guard is one line and the coupling it defends against — a future
              // edit passing the chosen zone in, to show the chip — is exactly
              // the change somebody would make without re-reading this handler.
              if (selection.localityName === "" || selection.provinceName === "") return;
              setChosen({
                provinceName: selection.provinceName,
                localityName: selection.localityName,
              });
              setPicking(false);
            }}
          />
        </View>
        <SecondaryButton label="Cancelar" onPress={() => setPicking(false)} />
      </Screen>
    );
  }

  // THE PICKER. `view.serviceKind` is the SERVER's answer and not this screen's
  // `serviceKind` state — an unrecognised code comes back `null`, which is how a
  // stale or hand-made value falls through to the catalogue instead of becoming a
  // heading.
  if (view.serviceKind === null) {
    return (
      <Screen>
        <Title>Buscar turno</Title>
        <Body>Indicá qué servicio buscás.</Body>
        <View style={styles.section}>
          {view.serviceKinds.map((kind) => (
            <Pressable
              key={kind.code}
              accessibilityRole="button"
              accessibilityLabel={kind.label}
              onPress={() => setServiceKind(kind.code)}
              style={styles.row}
            >
              <Text style={styles.rowTitle}>{kind.label}</Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </View>
      </Screen>
    );
  }

  const note = jurisdictionNoteLabel(view);
  const heading =
    view.serviceKinds.find((k) => k.code === view.serviceKind)?.label ?? "Buscar turno";

  return (
    <Screen>
      <Title>{heading}</Title>

      {/* THE ZONE, AND THE WAY TO CHANGE IT — drawn BEFORE the results, because
          it is the question the results answer. A filter under its own output
          reads as a footnote about a search that already happened. */}
      <View style={styles.section}>
        <Eyebrow>Zona</Eyebrow>
        <ListRow
          label={jurisdictionRowLabel(view)}
          caption={jurisdictionRowCaption(view)}
          accessibilityHint="Abre el buscador de localidades"
          onPress={() => setPicking(true)}
        />
        {/* ONLY WHEN THE ZONE WAS GUESSED. See `jurisdictionNoteLabel` — a
            prefilled control still reads as a choice, so the provenance is the
            one thing the row above cannot say about itself. */}
        {note === null ? null : <Body>{note}</Body>}
      </View>

      <View style={styles.section}>
        <Eyebrow>Resultados</Eyebrow>
        {view.results.length === 0 ? (
          <EmptyState
            headline={noResultsLabel(view)}
            // NO LONGER "buscá desde mimar.com.ar". Sending somebody from a phone
            // app to a browser to change a locality was the honest answer only
            // while this screen had no control; it now has one, three rows up,
            // and the empty state points at it — by POSITION and not by quoting
            // the caption, so a reworded control cannot leave this sentence
            // naming a label that is no longer on screen.
            body="Probá con otro servicio, o cambiá la localidad en la fila de arriba."
          />
        ) : (
          view.results.map((offering) => (
            <OfferingRow
              key={offering.offeringToken}
              offering={offering}
              windowDays={view.windowDays}
              onOpen={onOpenOffering}
            />
          ))
        )}
      </View>

      <SecondaryButton label="Elegir otro servicio" onPress={() => setServiceKind(null)} />
    </Screen>
  );
}

/**
 * One offering, as a row.
 *
 * The whole row is the target rather than a "Ver" link at its end, which is the
 * rule `TurnosScreen` already follows: on a phone the touch target should be the
 * thing you are looking at. The accessibility label composes the four facts into
 * one sentence instead of reading four fragments.
 */
function OfferingRow({
  offering,
  windowDays,
  onOpen,
}: {
  offering: BookableOfferingV1;
  windowDays: number;
  onOpen: (offeringToken: string) => void;
}) {
  const title = offeringTitle(offering);
  const provider = appointmentProviderLabel(offering.provider);
  const meta = offeringMetaLabel(offering);
  const availability = offeringAvailabilityLabel(offering, windowDays);
  const kind = offeringKindLabel(offering);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, provider, meta, availability].join(". ")}
      onPress={() => onOpen(offering.offeringToken)}
      style={styles.row}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowMeta}>{provider}</Text>
        <Text style={styles.rowMeta}>{meta}</Text>
        {/* DRAWN ONLY WHEN THE CATALOGUE KNOWS THE CODE. A raw `snake_case` code
            under the provider's own name is the S3-F07 shape one line down. */}
        {kind === null ? null : <Text style={styles.rowMeta}>{kind}</Text>}
        <Text style={styles.rowAvailability}>{availability}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.sm, marginTop: SPACE.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.sm,
    minHeight: TOUCH_TARGET,
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.md,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  rowMain: { flex: 1, gap: SPACE.xs / 2 },
  rowTitle: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.lg,
    lineHeight: TYPE.lg * LEADING.sm,
    color: COLORS.ink,
  },
  rowMeta: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkMuted,
  },
  rowAvailability: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
    color: COLORS.ink,
  },
  chevron: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.lg,
    color: COLORS.inkMuted,
    flexShrink: 0,
  },
});
