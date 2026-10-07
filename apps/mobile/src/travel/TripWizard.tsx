// "NUEVO VIAJE" — the four-step trip wizard (viaje redesign, PO-approved
// 2026-10-07). The rendering half; every rule it follows is in
// `trip-wizard-model.ts`, and the write is the screen's (`TravelScreen`), with
// the same attempt session the old form used.
//
// ALTA'S STEP PATTERN, NOT A NEW ONE: the bar and "Paso N de M", one question
// as the title, the answers under it, "Volver" at the foot. Tapping an answer
// moves on by itself; only the date step has a button ("Crear viaje" — it
// creates something the person controls, design rule 2.3). Never more than six
// options on screen.

import { type Ref, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { PET_TRAVEL_AIRLINE_NOTICE, type PetTravelV1 } from "@dim/contract/api";

import { Body } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  DateField,
  Eyebrow,
  PrimaryButton,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TYPE } from "../ui/theme";

import { dateInputToIso } from "../ui/date-input";
import { GroupLabel, OptionRow, StepBar } from "./travel-ui";
import {
  MODALITY_LABELS,
  MODE_LABELS,
  type TravelMode,
  travelDateBounds,
} from "./travel-view-model";
import {
  CORRIDOR_CODES,
  type WizardState,
  airlineChoices,
  chooseAirline,
  chooseCorridor,
  chooseModality,
  chooseMode,
  clearAirline,
  daysUntil,
  matchCorridors,
  modalitiesFor,
  modalityCaption,
  modesFor,
  searchAirlines,
  skipAirline,
  stepPosition,
  travelDateLine,
} from "./trip-wizard-model";

const ALL_MODES: readonly TravelMode[] = ["air", "land", "sea"];

const MODE_CAPTION: Record<TravelMode, string> = {
  air: "Elegís la aerolínea en el paso siguiente",
  land: "Cruzando por un paso fronterizo",
  sea: "En ferry o en barco",
};

export function TripWizard({
  view,
  state,
  onChange,
  onBack,
  onSubmit,
  now,
  busy,
  error,
  errorAnchor,
}: {
  view: PetTravelV1;
  state: WizardState;
  onChange: (next: WizardState) => void;
  /** One step back, or out of the wizard from its first step. */
  onBack: () => void;
  onSubmit: () => void;
  now: Date;
  busy: boolean;
  /** The date step's refusal — local or the server's — drawn under the field. */
  error: string | null;
  errorAnchor: Ref<View>;
}) {
  const { index, total } = stepPosition(state);
  const corridor = view.options.corridors.find((c) => c.id === state.draft.corridorId);
  const where = corridor === undefined ? "" : ` · ${corridor.label}`;
  const how = state.step === "aerolinea" ? " en avión" : "";
  const eyebrow = `Paso ${index + 1} de ${total}${index === 0 ? "" : where}${how}`;

  return (
    <View style={styles.wizard}>
      <StepBar index={index} total={total} />
      <View style={styles.masthead}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <Title>{stepQuestion(state.step, view.petName)}</Title>
      </View>

      {state.step === "destino" ? (
        <DestinationStep view={view} state={state} onChange={onChange} />
      ) : null}
      {state.step === "modo" ? <ModeStep view={view} state={state} onChange={onChange} /> : null}
      {state.step === "aerolinea" ? (
        <AirlineStep view={view} state={state} onChange={onChange} />
      ) : null}
      {state.step === "fecha" ? (
        <DateStep
          view={view}
          state={state}
          onChange={onChange}
          now={now}
          error={error}
          errorAnchor={errorAnchor}
        />
      ) : null}

      <View style={styles.nav}>
        {state.step === "fecha" ? (
          <PrimaryButton
            label={busy ? "Creando…" : "Crear viaje"}
            disabled={busy}
            onPress={onSubmit}
          />
        ) : null}
        <SecondaryButton label="Volver" disabled={busy} onPress={onBack} />
      </View>
    </View>
  );
}

function stepQuestion(step: WizardState["step"], petName: string): string {
  switch (step) {
    case "destino":
      return `¿A dónde viaja ${petName}?`;
    case "modo":
      return "¿Cómo viajan?";
    case "aerolinea":
      return "¿Con qué aerolínea?";
    case "fecha":
      return "¿Cuándo salen?";
  }
}

type StepProps = {
  view: PetTravelV1;
  state: WizardState;
  onChange: (next: WizardState) => void;
};

/**
 * Paso 1. The five destinations, a search that knows their other names, and
 * an HONEST "Otro país": the contract only takes the five (spec R3.3), so it
 * records nothing and says what miMAR does not do — no invented semáforo.
 */
function DestinationStep({ view, state, onChange }: StepProps) {
  const [query, setQuery] = useState("");
  const [other, setOther] = useState(false);
  const matches = matchCorridors(view.options.corridors, query);
  const typed = query.trim();
  const unknown = other || (typed !== "" && matches.length === 0);
  const reviewed = view.options.corridors.map((c) => c.label).join(", ");

  return (
    <View style={styles.body}>
      <TextField
        label="Destino"
        placeholder="Buscá un país"
        autoCorrect={false}
        value={query}
        onChangeText={(text) => {
          setQuery(text);
          setOther(false);
        }}
      />
      {unknown ? (
        <>
          <Callout
            title={`${typed !== "" && !other ? typed : "Ese país"} no está entre los destinos que miMAR revisa`}
          >
            <Body>
              {`Por ahora miMAR compara la libreta con los requisitos de ${reviewed}. Para otro país, revisá los requisitos del destino en su sitio oficial antes de sacar el pasaje.`}
            </Body>
          </Callout>
          <OptionRow
            label="Volver a los destinos"
            variant="quiet"
            onPress={() => {
              setQuery("");
              setOther(false);
            }}
          />
          <Text style={styles.small}>
            {`Igual podés exportar la libreta de ${view.petName} desde su credencial para llevarla a la consulta.`}
          </Text>
        </>
      ) : (
        <View style={styles.options}>
          {matches.map((c) => (
            <OptionRow
              key={c.id}
              code={(CORRIDOR_CODES as Record<string, string | undefined>)[c.id] ?? null}
              label={c.label}
              selected={c.id === state.draft.corridorId}
              onPress={() => onChange(chooseCorridor(state, c.id))}
            />
          ))}
          <OptionRow code="··" label="Otro país" variant="quiet" onPress={() => setOther(true)} />
        </View>
      )}
    </View>
  );
}

/** Paso 2. Only the ways this destination allows; "Todavía no sé" skips the airline. */
function ModeStep({ view, state, onChange }: StepProps) {
  const listed = modesFor(state.draft.corridorId);
  const modes = listed.length > 0 ? listed : ALL_MODES;
  const corridor = view.options.corridors.find((c) => c.id === state.draft.corridorId);
  const informed = view.options.airlines.some((a) => Array.isArray(a.corridors));
  const answered = state.modeAnswered;
  return (
    <View style={styles.options}>
      {modes.map((mode) => (
        <OptionRow
          key={mode}
          label={MODE_LABELS[mode]}
          caption={
            mode === "air" && informed && corridor !== undefined
              ? `Te mostramos las aerolíneas que vuelan a ${corridor.label}`
              : MODE_CAPTION[mode]
          }
          selected={answered && state.draft.mode === mode}
          onPress={() => onChange(chooseMode(state, mode))}
        />
      ))}
      <OptionRow
        label="Todavía no sé"
        caption="Lo podés completar después"
        variant="quiet"
        selected={answered && state.draft.mode === ""}
        onPress={() => onChange(chooseMode(state, null))}
      />
    </View>
  );
}

/**
 * Paso 3. The destination's airlines first (a SUGGESTED order, never a
 * rule), "Buscar otra aerolínea" over all of them, "Todavía no sé". Once one
 * is picked the list folds into a row and the next question appears: where
 * the animal travels, only among what that airline offers.
 */
function AirlineStep({ view, state, onChange }: StepProps) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const airlines = view.options.airlines;
  const chosen = airlines.find((a) => a.id === state.draft.airlineId);

  if (chosen !== undefined) {
    const modalities = modalitiesFor(chosen);
    return (
      <View style={styles.body}>
        <OptionRow
          label={chosen.name}
          variant="chosen"
          trailing="Cambiar"
          accessibilityHint="Vuelve a la lista de aerolíneas."
          onPress={() => {
            setSearching(false);
            setQuery("");
            onChange(clearAirline(state));
          }}
        />
        <GroupLabel>{`¿Dónde viaja ${view.petName}?`}</GroupLabel>
        <View style={styles.options}>
          {modalities.map((modality) => (
            <OptionRow
              key={modality}
              label={MODALITY_LABELS[modality]}
              caption={modalityCaption(chosen, modality)}
              selected={state.airlineAnswered && state.draft.intendedModality === modality}
              onPress={() => onChange(chooseModality(state, modality))}
            />
          ))}
          <OptionRow
            label="Todavía no sé"
            variant="quiet"
            selected={state.airlineAnswered && state.draft.intendedModality === ""}
            onPress={() => onChange(chooseModality(state, null))}
          />
        </View>
        <Text style={styles.small}>
          {`${PET_TRAVEL_AIRLINE_NOTICE}: estos datos son los que ${chosen.name} publica y pueden cambiar.`}
        </Text>
      </View>
    );
  }

  const choices = airlineChoices(airlines, state.draft.corridorId);

  if (searching) {
    const { results, more } = searchAirlines(airlines, query);
    return (
      <View style={styles.body}>
        <TextField
          label="Aerolínea"
          placeholder="Buscá una aerolínea"
          autoCorrect={false}
          value={query}
          onChangeText={setQuery}
        />
        <View style={styles.options}>
          {results.map((a) => (
            <OptionRow
              key={a.id}
              label={a.name}
              onPress={() => onChange(chooseAirline(state, a.id))}
            />
          ))}
        </View>
        {results.length === 0 ? (
          <Text style={styles.small}>Ninguna aerolínea de la lista se llama así.</Text>
        ) : null}
        {more ? <Text style={styles.small}>Seguí escribiendo para ver las demás.</Text> : null}
        <OptionRow
          label="Volver a las sugeridas"
          variant="quiet"
          onPress={() => {
            setSearching(false);
            setQuery("");
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.options}>
      {choices.airlines.map((a) => (
        <OptionRow key={a.id} label={a.name} onPress={() => onChange(chooseAirline(state, a.id))} />
      ))}
      {choices.kind === "suggested" ? (
        <OptionRow
          label="Buscar otra aerolínea"
          variant="quiet"
          onPress={() => setSearching(true)}
        />
      ) : null}
      <OptionRow
        label="Todavía no sé"
        caption="Lo podés completar después"
        variant="quiet"
        selected={state.airlineAnswered && state.draft.airlineId === ""}
        onPress={() => onChange(skipAirline(state))}
      />
    </View>
  );
}

/**
 * Paso 4. The date last: by now the rules that matter are the chosen
 * destination's, said as deadlines by the SERVER (`leadHints`) — the rules,
 * never a verdict on the animal — and a summary before anything is written.
 */
function DateStep({
  view,
  state,
  onChange,
  now,
  error,
  errorAnchor,
}: StepProps & { now: Date; error: string | null; errorAnchor: Ref<View> }) {
  const corridor = view.options.corridors.find((c) => c.id === state.draft.corridorId);
  const iso = dateInputToIso(state.draft.travelDate);
  const dateLine = travelDateLine(iso, now);
  const days = daysUntil(iso, now);
  const hints = corridor?.leadHints ?? [];
  const leadDays = corridor?.leadDays ?? null;
  const tight = leadDays !== null && days !== null && days >= 0 && days < leadDays;
  const airline = view.options.airlines.find((a) => a.id === state.draft.airlineId);

  return (
    <View style={styles.body}>
      <DateField
        label="Fecha de salida"
        required
        {...travelDateBounds(now)}
        value={state.draft.travelDate}
        onChangeText={(travelDate) => onChange({ ...state, draft: { ...state.draft, travelDate } })}
      />
      {dateLine !== null ? <Text style={styles.small}>{dateLine}</Text> : null}
      {error !== null ? (
        <View ref={errorAnchor}>
          <Callout tone="err">
            <Body>{error}</Body>
          </Callout>
        </View>
      ) : null}

      {hints.length > 0 && corridor !== undefined ? (
        <Callout
          tone={tight ? "warn" : "neutral"}
          title={
            tight
              ? `${tightLead(days ?? 0)}, menos que los ${leadDays} días que pide alguno de estos plazos`
              : `Para ${corridor.label}, con tiempo`
          }
        >
          {hints.map((hint) => (
            <Text key={hint} style={styles.hint}>{`• ${hint}`}</Text>
          ))}
        </Callout>
      ) : null}

      <View style={styles.summary}>
        <Text style={styles.small}>Vas a crear</Text>
        <Text style={styles.summaryTitle}>
          {corridor === undefined
            ? state.draft.travelDate
            : `${corridor.label}${state.draft.travelDate === "" ? "" : ` · ${state.draft.travelDate}`}`}
        </Text>
        <Text style={styles.summaryLine}>{summaryHow(state, airline?.name ?? null)}</Text>
      </View>
    </View>
  );
}

/** "Faltan 12 días", "Falta 1 día", "Sale hoy" — the start of the tight-date title. */
function tightLead(days: number): string {
  if (days === 0) return "Sale hoy";
  if (days === 1) return "Falta 1 día";
  return `Faltan ${days} días`;
}

/** "LATAM, en cabina", "En auto o en micro", or that it is still open. */
function summaryHow(state: WizardState, airlineName: string | null): string {
  const { draft } = state;
  if (airlineName !== null) {
    return draft.intendedModality === ""
      ? airlineName
      : `${airlineName}, ${MODALITY_LABELS[draft.intendedModality].toLowerCase()}`;
  }
  if (draft.mode !== "") return MODE_LABELS[draft.mode];
  return "Cómo viajan: lo completás después";
}

const styles = StyleSheet.create({
  wizard: { gap: SPACE.lg },
  masthead: { gap: SPACE.xs },
  body: { gap: SPACE.md },
  options: { gap: SPACE.sm },
  nav: { gap: SPACE.sm, marginTop: SPACE.sm },
  small: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
  },
  hint: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkSoft,
  },
  summary: {
    gap: 2,
    paddingHorizontal: SPACE.md + 2,
    paddingVertical: SPACE.md,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
  },
  summaryTitle: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.base,
    lineHeight: TYPE.base * LEADING.base,
    color: COLORS.ink,
  },
  summaryLine: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.inkSoft,
  },
});
