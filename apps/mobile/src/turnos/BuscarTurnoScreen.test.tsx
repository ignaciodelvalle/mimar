// `BuscarTurnoScreen` — the picker and the results.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. THE PICKER IS THE SERVER'S ANSWER, not this screen's state. An
//      unrecognised `service_kind` comes back `serviceKind: null`, and the screen
//      must fall through to the catalogue — never print the raw code as a
//      heading, which is the defect QA 2026-08-08 (S3-F07) found on the web.
//   2. A FAILED READ IS NOT AN EMPTY CATALOGUE. "No hay turnos" over an outage
//      sends somebody away from a vaccination drive that is running.
//   3. AN EMPTY RESULT NAMES THE PLACE IT LOOKED IN. Otherwise it reads as "this
//      service does not exist anywhere".
//   4. A GUESSED JURISDICTION SAYS SO. The web draws the prefill into its filter
//      form where it reads as something the person chose.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockSearch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockLocalities = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

// BOTH endpoints, because the zone control mounts `pets/LocalityPicker` and that
// component calls `searchLocalities`. A factory that named only the appointment
// read would hand the picker `undefined` and fail as a TypeError inside a
// debounce — a crash three layers from the missing line.
jest.mock("../api/endpoints", () => ({
  fetchAppointmentSearch: (...args: unknown[]) => mockSearch(...args),
  searchLocalities: (...args: unknown[]) => mockLocalities(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { AppointmentSearchV1, BookableOfferingV1 } from "@dim/contract/api";

import { BuscarTurnoScreen } from "./BuscarTurnoScreen";

function anOffering(over: Partial<BookableOfferingV1> = {}): BookableOfferingV1 {
  return {
    offeringToken: "SVO-7K2M-9QX4",
    displayName: "Campaña antirrábica — Plaza San Martín",
    description: null,
    serviceKind: "vaccination_rabies",
    serviceKindLabel: "Vacunación antirrábica",
    provider: {
      kind: "organization",
      displayName: "Zoonosis Bariloche",
      phone: null,
      locality: null,
    },
    durationMinutes: 15,
    priceArs: null,
    coverageLabel: "San Carlos de Bariloche",
    slotsInWindow: 3,
    nextSlotAt: "2026-09-03T13:30:00.000Z",
    ...over,
  };
}

function payload(over: Partial<AppointmentSearchV1> = {}): AppointmentSearchV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-30T12:00:00.000Z",
    staleAfter: "2026-08-30T12:00:30.000Z",
    serviceKinds: [
      { code: "vaccination_rabies", label: "Vacunación antirrábica" },
      { code: "sterilization_dog_male", label: "Castración perro macho" },
    ],
    serviceKind: null,
    appliedProvince: null,
    appliedLocality: null,
    jurisdictionSource: "none",
    results: [],
    windowDays: 7,
    ...over,
  };
}

beforeEach(() => {
  mockSearch.mockReset();
  mockLocalities.mockReset();
  mockLocalities.mockResolvedValue({
    outcome: "ok",
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-08-30T12:00:00.000Z",
      staleAfter: "2026-08-30T12:05:00.000Z",
      results: [
        {
          localityName: "El Bolsón",
          localitySlug: "el-bolson",
          provinceCode: "AR-R",
          provinceName: "Río Negro",
          departmentName: "Bariloche",
        },
      ],
    },
  });
});

describe("the service picker", () => {
  it("draws the catalogue the SERVER sent, not twelve labels of its own", () => {
    // A client that hard-coded the catalogue would print a stale label the day a
    // kind is added, and `service_kinds.ts` lives inside the Next app where a
    // phone cannot reach it.
    mockSearch.mockResolvedValue({ outcome: "ok", payload: payload() });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    return waitFor(() => {
      expect(screen.getByText("Vacunación antirrábica")).toBeTruthy();
      expect(screen.getByText("Castración perro macho")).toBeTruthy();
      expect(screen.getByText("Indicá qué servicio buscás.")).toBeTruthy();
    });
  });

  it("asks again with the chosen service when a row is tapped", async () => {
    mockSearch.mockResolvedValue({ outcome: "ok", payload: payload() });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Vacunación antirrábica")).toBeTruthy());
    fireEvent.press(screen.getByText("Vacunación antirrábica"));

    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(2));
    expect(mockSearch.mock.calls[1]?.[1]).toEqual({ serviceKind: "vaccination_rabies" });
  });

  it("falls back to the picker when the server does not recognise the service", async () => {
    // THE S3-F07 CASE. The screen's own state says a kind was chosen; the payload
    // says `serviceKind: null`, because the server refuses to echo a code the
    // catalogue does not have. The SERVER's answer is what decides what is drawn.
    mockSearch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ serviceKind: null, results: [] }),
    });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Indicá qué servicio buscás.")).toBeTruthy());
    expect(screen.queryByText("Resultados")).toBeNull();
  });
});

describe("a failed read", () => {
  it("shows the failure and a retry, never an empty catalogue", async () => {
    mockSearch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    expect(screen.getByText(/Revisá tu conexión/i)).toBeTruthy();
    // THE SENTENCE THAT MUST NOT APPEAR. "No hay turnos" over an outage sends
    // somebody away from a campaign that is running.
    expect(screen.queryByText(/No hay turnos disponibles/i)).toBeNull();
  });

  it("reads again when the retry is pressed", async () => {
    mockSearch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    fireEvent.press(screen.getByText("Reintentar"));
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(2));
  });

  it("tells an out-of-date build to update instead of blaming the network", async () => {
    mockSearch.mockResolvedValue({ outcome: "unsupported-version", received: 2 });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(/Actualizá la app/i)).toBeTruthy());
  });
});

describe("the results", () => {
  it("draws each offering with its provider, its meta and how much is left", async () => {
    mockSearch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceKind: "vaccination_rabies",
        appliedProvince: "Río Negro",
        appliedLocality: "San Carlos de Bariloche",
        jurisdictionSource: "requested",
        results: [anOffering()],
      }),
    });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByText("Campaña antirrábica — Plaza San Martín")).toBeTruthy(),
    );
    expect(screen.getByText("Zoonosis Bariloche")).toBeTruthy();
    expect(screen.getByText("Gratuito · 15 min · San Carlos de Bariloche")).toBeTruthy();
    // THE WINDOW COMES FROM THE PAYLOAD, so this sentence cannot claim a figure
    // the read did not use.
    expect(screen.getByText("3 turnos disponibles en 7 días")).toBeTruthy();
    // THE ZONE IS A CONTROL, not a sentence. It used to read "Buscando en San
    // Carlos de Bariloche."; it is now the label of the row that changes it.
    expect(screen.getByText("Buscar cerca de: San Carlos de Bariloche, Río Negro")).toBeTruthy();
  });

  it("says a GUESSED jurisdiction was guessed", async () => {
    mockSearch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceKind: "vaccination_rabies",
        appliedProvince: "Río Negro",
        appliedLocality: "San Carlos de Bariloche",
        jurisdictionSource: "defaulted-from-pet",
        results: [anOffering()],
      }),
    });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(/la zona donde registraste tu primera mascota/i)).toBeTruthy(),
    );
  });

  it("names the place in an empty result rather than saying nothing exists", async () => {
    mockSearch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceKind: "vaccination_rabies",
        appliedProvince: "Río Negro",
        appliedLocality: "El Bolsón",
        jurisdictionSource: "requested",
        results: [],
      }),
    });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    // THE EXACT SENTENCE, not a substring: "en El Bolsón" also appears in the
    // jurisdiction note one line up, and a regex that matched both would pass
    // over an empty state that said nothing at all.
    await waitFor(() =>
      expect(
        screen.getByText(
          "No hay turnos disponibles en El Bolsón para este servicio. Probá otra localidad.",
        ),
      ).toBeTruthy(),
    );
  });

  it("opens the offering that was tapped, by its own token", async () => {
    const onOpenOffering = jest.fn();
    mockSearch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceKind: "vaccination_rabies",
        results: [anOffering({ offeringToken: "SVO-AAAA-BBBB" })],
      }),
    });
    render(<BuscarTurnoScreen onOpenOffering={onOpenOffering} />);

    await waitFor(() =>
      expect(screen.getByText("Campaña antirrábica — Plaza San Martín")).toBeTruthy(),
    );
    fireEvent.press(screen.getByText("Campaña antirrábica — Plaza San Martín"));
    expect(onOpenOffering).toHaveBeenCalledWith("SVO-AAAA-BBBB");
  });

  it("does NOT print a raw snake_case code when the catalogue does not know it", async () => {
    // The catalogue is open (`service_kind` is `text` with no CHECK), so a code
    // seeded outside it is a real possibility. The heading is the offering's own
    // name and the kind line is simply absent.
    mockSearch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceKind: "vaccination_rabies",
        results: [anOffering({ serviceKind: "spay_female_dog", serviceKindLabel: null })],
      }),
    });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByText("Campaña antirrábica — Plaza San Martín")).toBeTruthy(),
    );
    expect(screen.queryByText("spay_female_dog")).toBeNull();
  });

  it("goes back to the picker without a navigation, since the picker is this screen", async () => {
    // WALKED, not staged. The first read is the picker, the tap chooses a
    // service, and only then is there something to go back FROM — staging a
    // results payload on the first read would put the screen in a state it cannot
    // reach, and the assertion would be about that state rather than about the
    // control.
    mockSearch.mockResolvedValueOnce({ outcome: "ok", payload: payload() });
    mockSearch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ serviceKind: "vaccination_rabies", results: [anOffering()] }),
    });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Vacunación antirrábica")).toBeTruthy());
    fireEvent.press(screen.getByText("Vacunación antirrábica"));

    await waitFor(() => expect(screen.getByText("Elegir otro servicio")).toBeTruthy());
    fireEvent.press(screen.getByText("Elegir otro servicio"));

    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(3));
    expect(mockSearch.mock.calls[2]?.[1]).toEqual({ serviceKind: null });
  });
});

describe("choosing the zone", () => {
  /** Walk the screen to the results state, which is where the zone row lives. */
  async function reachResults(over: Partial<AppointmentSearchV1> = {}) {
    mockSearch.mockResolvedValueOnce({ outcome: "ok", payload: payload() });
    mockSearch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceKind: "vaccination_rabies",
        appliedProvince: "Buenos Aires",
        appliedLocality: "San Justo",
        jurisdictionSource: "defaulted-from-pet",
        results: [anOffering()],
        ...over,
      }),
    });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("Vacunación antirrábica")).toBeTruthy());
    fireEvent.press(screen.getByText("Vacunación antirrábica"));
    await waitFor(() =>
      expect(screen.getByText("Buscar cerca de: San Justo, Buenos Aires")).toBeTruthy(),
    );
  }

  it("asks the SERVER for the default and sends no jurisdiction of its own", async () => {
    // THE DEFAULT IS NOT THIS SCREEN'S TO COMPUTE. The route's first-pet prefill
    // runs only when a half is MISSING from the query string, so sending an empty
    // province would suppress the very default this screen relies on.
    await reachResults();
    expect(mockSearch.mock.calls[1]?.[1]).toEqual({ serviceKind: "vaccination_rabies" });
  });

  it("draws the zone the server actually used, and says it was a guess", async () => {
    await reachResults();
    expect(screen.getByText("Cambiar la localidad.")).toBeTruthy();
    expect(screen.getByText(/la zona donde registraste tu primera mascota/i)).toBeTruthy();
  });

  it("opens the locality picker when the zone row is tapped", async () => {
    await reachResults();
    fireEvent.press(screen.getByText("Buscar cerca de: San Justo, Buenos Aires"));
    await waitFor(() => expect(screen.getByText("Elegir localidad")).toBeTruthy());
    // Province first (L3·0, PO decision 2026-09-08): the locality field only
    // exists inside a province.
    expect(screen.queryByLabelText("Ciudad, pueblo o barrio")).toBeNull();
    fireEvent.press(screen.getByRole("radio", { name: "Río Negro" }));
    // THE FIELD IS NOT ANNOUNCED AS OBLIGATORIA, and that is the assertion.
    // `LocalityPicker` is shared with the alta and the mudanza, where the
    // locality IS required, and it announced ", obligatorio" on every consumer
    // — including this one, where the zone is a filter a person may skip and
    // the server picks a default when they do. A screen reader reading
    // "obligatorio" here is the app telling somebody to fill in a field they
    // are free to leave alone.
    expect(screen.getByLabelText("Ciudad, pueblo o barrio")).toBeTruthy();
    expect(screen.queryByLabelText("Ciudad, pueblo o barrio, obligatorio")).toBeNull();
  });

  it("searches again with the CHOSEN locality, and sends the province NAME", async () => {
    // THE NAME AND NOT THE ISO CODE. The search matches
    // `service_offerings.jurisdiction_province`, which stores "Río Negro" and not
    // "AR-R" — sending the code returns an empty result rather than an error,
    // which reads to a citizen as "there are no campaigns here".
    await reachResults();
    fireEvent.press(screen.getByText("Buscar cerca de: San Justo, Buenos Aires"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Río Negro" })).toBeTruthy());
    fireEvent.press(screen.getByRole("radio", { name: "Río Negro" }));

    fireEvent.changeText(screen.getByLabelText("Ciudad, pueblo o barrio"), "Bolsón");
    await waitFor(() => expect(screen.getByText("El Bolsón")).toBeTruthy());
    fireEvent.press(screen.getByText("El Bolsón"));

    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(3));
    expect(mockSearch.mock.calls[2]?.[1]).toEqual({
      serviceKind: "vaccination_rabies",
      province: "Río Negro",
      locality: "El Bolsón",
    });
    // The typeahead itself was scoped to the province the person chose.
    expect(mockLocalities).toHaveBeenCalledWith({ q: "Bolsón", province: "AR-R" });
  });

  it("keeps the chosen zone when the service changes", async () => {
    // The zone is where this person is, not a property of the service they picked.
    // Resetting it on every service change would make the control feel broken.
    await reachResults();
    fireEvent.press(screen.getByText("Buscar cerca de: San Justo, Buenos Aires"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Río Negro" })).toBeTruthy());
    fireEvent.press(screen.getByRole("radio", { name: "Río Negro" }));
    fireEvent.changeText(screen.getByLabelText("Ciudad, pueblo o barrio"), "Bolsón");
    await waitFor(() => expect(screen.getByText("El Bolsón")).toBeTruthy());
    fireEvent.press(screen.getByText("El Bolsón"));

    // WAITS FOR THE SCREEN, NOT FOR THE MOCK, and the difference is what made
    // this test flaky. It used to `waitFor(mockSearch).toHaveBeenCalledTimes(3)`
    // and then reach for the button on the very next line — but the CALL and
    // the RENDER are two events with a state update between them. The search
    // having been requested does not mean its results are on screen; in
    // between, the screen draws "Buscando turnos…" and this control does not
    // exist yet.
    //
    // MEASURED 2026-09-08: 20/20 in isolation, red inside the full 101-suite
    // jest run, where the extra load widens exactly that gap. The old line was
    // synchronising on a proxy for the thing it needed. `findByText` waits for
    // the thing itself.
    await screen.findByText("Elegir otro servicio");
    expect(mockSearch).toHaveBeenCalledTimes(3);

    fireEvent.press(screen.getByText("Elegir otro servicio"));
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(4));
    expect(mockSearch.mock.calls[3]?.[1]).toEqual({
      serviceKind: null,
      province: "Río Negro",
      locality: "El Bolsón",
    });
  });

  it("closes the picker without changing anything when it is cancelled", async () => {
    await reachResults();
    fireEvent.press(screen.getByText("Buscar cerca de: San Justo, Buenos Aires"));
    await waitFor(() => expect(screen.getByText("Cancelar")).toBeTruthy());
    fireEvent.press(screen.getByText("Cancelar"));

    await waitFor(() =>
      expect(screen.getByText("Buscar cerca de: San Justo, Buenos Aires")).toBeTruthy(),
    );
    // Two reads: the catalogue and the results. Cancelling is not a search.
    expect(mockSearch).toHaveBeenCalledTimes(2);
  });

  it("points an empty result at the control, not at the website", async () => {
    // THE SENTENCE THAT MUST NOT COME BACK. While this screen had no locality
    // control, the honest empty state sent people to mimar.com.ar to look
    // somewhere else — a phone app telling you to open a browser.
    await reachResults({ results: [] });
    expect(
      screen.getByText("Probá con otro servicio, o cambiá la localidad en la fila de arriba."),
    ).toBeTruthy();
    expect(screen.queryByText(/mimar\.com\.ar/i)).toBeNull();
  });

  it("offers to CHOOSE a locality when the server applied none at all", async () => {
    // A person with no animal registered gets an unfiltered national search. The
    // row is the only way they can narrow it, so it must still be drawn.
    mockSearch.mockResolvedValueOnce({ outcome: "ok", payload: payload() });
    mockSearch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        serviceKind: "vaccination_rabies",
        appliedProvince: null,
        appliedLocality: null,
        jurisdictionSource: "none",
        results: [anOffering()],
      }),
    });
    render(<BuscarTurnoScreen onOpenOffering={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("Vacunación antirrábica")).toBeTruthy());
    fireEvent.press(screen.getByText("Vacunación antirrábica"));

    await waitFor(() => expect(screen.getByText("Buscando en todo el país")).toBeTruthy());
    expect(screen.getByText("Elegir una localidad.")).toBeTruthy();
  });
});
