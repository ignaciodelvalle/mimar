// `LocationPicker` — the map every "¿dónde fue?" uses (M17).
//
// What is pinned, and why each:
//   · SEARCH → PICK → CONFIRM produces the point, the address and the server's
//     jurisdiction, and NOTHING reaches the form before "Sí, es acá".
//   · DRAGGING THE MAP moves the point: the settled centre is re-read into an
//     address, and the source becomes `pin_manual`. A camera move the APP made
//     (flying to a result) is not a drag.
//   · A slow reverse answer for a point already dragged past never wins.
//   · THE FALLBACK: tiles that fail leave the list, and a list pick still
//     confirms a point.
//   · THE MAP IS LAZY: nothing native renders until the step is opened.
//   · NO DEVICE LOCATION, as a fence over the source tree.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockGeocode = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  sendGeocodingCommand: (...args: unknown[]) => mockGeocode(...args),
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { LOCATION_PICKER_COPY, LocationPicker, type PickedLocation } from "./LocationPicker";

const JURISDICTION = {
  provinceCode: "AR-L",
  provinceName: "La Pampa",
  localityName: "Santa Rosa",
  localityIndecId: "42021010",
};

function searchAck(labels: string[]) {
  return {
    outcome: "ok",
    payload: {
      command: "search",
      version: 1,
      matches: labels.map((label, i) => ({
        label,
        lat: -36.62 - i,
        lng: -64.29 - i,
        jurisdiction: JURISDICTION,
      })),
    },
  };
}

function reverseAck(label: string | null) {
  return {
    outcome: "ok",
    payload: {
      command: "reverse",
      version: 1,
      label,
      jurisdiction: label === null ? null : JURISDICTION,
    },
  };
}

function renderPicker(startQuery: string | null = null) {
  const onChange = jest.fn<(value: PickedLocation | null) => void>();
  render(
    <LocationPicker label="¿Dónde fue?" value={null} onChange={onChange} startQuery={startQuery} />,
  );
  return onChange;
}

async function openAndSearch(labels = ["Av. San Martín 100, Santa Rosa"]) {
  fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.open));
  mockGeocode.mockResolvedValueOnce(searchAck(labels));
  fireEvent.changeText(screen.getByLabelText(LOCATION_PICKER_COPY.searchLabel), "San Martín 100");
  fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.searchButton));
  await waitFor(() => expect(screen.getByText(labels[0] ?? "")).toBeTruthy());
}

function cameraCalls(): Array<Record<string, unknown>> {
  return (require("@maplibre/maplibre-react-native") as { __cameraCalls: never[] }).__cameraCalls;
}

beforeEach(() => {
  mockGeocode.mockReset();
  cameraCalls().length = 0;
});

describe("search → pick → confirm", () => {
  it("hands the form the point, the address and the jurisdiction — only on 'Sí, es acá'", async () => {
    const onChange = renderPicker();
    await openAndSearch();
    fireEvent.press(screen.getByText("Av. San Martín 100, Santa Rosa"));

    // The map flew to the result…
    await waitFor(() => expect(cameraCalls().some((c) => c.method === "easeTo")).toBe(true));
    // …and nothing reached the form yet.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(LOCATION_PICKER_COPY.confirmQuestion)).toBeTruthy();

    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.confirm));
    expect(onChange).toHaveBeenCalledWith({
      lat: -36.62,
      lng: -64.29,
      address: "Av. San Martín 100, Santa Rosa",
      source: "geocodificada",
      jurisdiction: JURISDICTION,
    });
    expect(mockGeocode.mock.calls[0]?.[1]).toEqual({ command: "search", query: "San Martín 100" });
  });

  it("says so when the search finds nothing, instead of an empty list", async () => {
    renderPicker();
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.open));
    mockGeocode.mockResolvedValueOnce(searchAck([]));
    fireEvent.changeText(screen.getByLabelText(LOCATION_PICKER_COPY.searchLabel), "Calle nada");
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.searchButton));
    await waitFor(() => expect(screen.getByText(LOCATION_PICKER_COPY.noMatches)).toBeTruthy());
  });
});

describe("dragging the map under the pin", () => {
  it("re-reads the address of the settled point and marks it pin_manual", async () => {
    const onChange = renderPicker();
    await openAndSearch();
    fireEvent.press(screen.getByText("Av. San Martín 100, Santa Rosa"));
    const map = await screen.findByTestId("maplibre-map");

    mockGeocode.mockResolvedValueOnce(reverseAck("Av. San Martín 180, Santa Rosa"));
    await act(async () => {
      fireEvent(map, "regionDidChange", {
        nativeEvent: { center: [-64.3, -36.63], zoom: 17, userInteraction: true },
      });
    });
    await waitFor(() => expect(screen.getByText("Av. San Martín 180, Santa Rosa")).toBeTruthy());
    expect(mockGeocode.mock.calls.at(-1)?.[1]).toEqual({
      command: "reverse",
      lat: -36.63,
      lng: -64.3,
    });

    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.confirm));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ lat: -36.63, lng: -64.3, source: "pin_manual" }),
    );
  });

  it("ignores a camera move the app made — flying to a result is not a drag", async () => {
    renderPicker();
    await openAndSearch();
    fireEvent.press(screen.getByText("Av. San Martín 100, Santa Rosa"));
    const map = await screen.findByTestId("maplibre-map");
    const before = mockGeocode.mock.calls.length;
    fireEvent(map, "regionDidChange", {
      nativeEvent: { center: [-64.29, -36.62], zoom: 17, userInteraction: false },
    });
    expect(mockGeocode.mock.calls.length).toBe(before);
  });

  it("never lets a slow answer for an older point overwrite the newer one", async () => {
    renderPicker();
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.open));
    const map = await screen.findByTestId("maplibre-map");

    let releaseFirst: (value: unknown) => void = () => {};
    mockGeocode.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    );
    mockGeocode.mockResolvedValueOnce(reverseAck("El punto nuevo"));
    await act(async () => {
      fireEvent(map, "regionDidChange", {
        nativeEvent: { center: [-64.1, -36.1], zoom: 15, userInteraction: true },
      });
      fireEvent(map, "regionDidChange", {
        nativeEvent: { center: [-64.2, -36.2], zoom: 15, userInteraction: true },
      });
    });
    await waitFor(() => expect(screen.getByText("El punto nuevo")).toBeTruthy());
    await act(async () => {
      releaseFirst(reverseAck("El punto viejo"));
    });
    expect(screen.queryByText("El punto viejo")).toBeNull();
  });

  it("says the server is busy, not 'no address here', when the reverse lookup is rate-limited", async () => {
    renderPicker();
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.open));
    const map = await screen.findByTestId("maplibre-map");
    mockGeocode.mockResolvedValueOnce({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: null,
      correlationId: null,
    });
    await act(async () => {
      fireEvent(map, "regionDidChange", {
        nativeEvent: { center: [-64.3, -36.63], zoom: 17, userInteraction: true },
      });
    });
    await waitFor(() => expect(screen.getByText(/Demasiadas/)).toBeTruthy());
    expect(screen.queryByText(LOCATION_PICKER_COPY.noAddress)).toBeNull();
  });

  it("zooms from the 48dp buttons", async () => {
    renderPicker();
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.open));
    fireEvent.press(await screen.findByLabelText("Acercar el mapa"));
    expect(cameraCalls().at(-1)).toMatchObject({ method: "zoomTo", zoom: 5 });
  });
});

describe("where the map opens, and what it never asks for", () => {
  it("opens on the screen's locality by a quiet search — never on the device", async () => {
    renderPicker("Santa Rosa, La Pampa");
    mockGeocode.mockResolvedValueOnce(searchAck(["Santa Rosa, La Pampa"]));
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.open));
    await waitFor(() =>
      expect(mockGeocode.mock.calls[0]?.[1]).toEqual({
        command: "search",
        query: "Santa Rosa, La Pampa",
      }),
    );
    await waitFor(() =>
      expect(cameraCalls().at(-1)).toMatchObject({ method: "easeTo", options: { zoom: 13 } }),
    );
  });

  it("does not mount the native map until the step is opened", () => {
    renderPicker();
    expect(screen.queryByTestId("maplibre-map")).toBeNull();
  });
});

describe("the fallback when the map cannot load", () => {
  it("keeps the list, and a list pick still confirms a point", async () => {
    const onChange = renderPicker();
    await openAndSearch();
    const map = await screen.findByTestId("maplibre-map");
    fireEvent(map, "didFailLoadingMap", { nativeEvent: null });

    expect(screen.getByText(LOCATION_PICKER_COPY.mapFailed)).toBeTruthy();
    expect(screen.queryByTestId("maplibre-map")).toBeNull();
    fireEvent.press(screen.getByText("Av. San Martín 100, Santa Rosa"));
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.confirm));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ lat: -36.62, lng: -64.29 }));
  });

  it("says why when the geocoder is unreachable, rather than 'no such street'", async () => {
    renderPicker();
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.open));
    mockGeocode.mockResolvedValueOnce({ outcome: "unreachable", detail: "offline" });
    fireEvent.changeText(screen.getByLabelText(LOCATION_PICKER_COPY.searchLabel), "San Martín 100");
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.searchButton));
    await waitFor(() => expect(screen.getByText(/Revisá tu conexión/)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// The fence: no device location in this app (PO, 2026-09-24)
// ---------------------------------------------------------------------------

const MOBILE_ROOT = path.resolve(__dirname, "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|js)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * The SUBJECT that is banned — reading the device's position — as patterns
 * over code with comments stripped. Each entry names a way in, not one
 * spelling: the package in ANY import form (static, `require`, dynamic
 * `import()`, re-export), every user-location API the map library or React
 * Native exposes, and a runtime permission request for any LOCATION
 * permission.
 */
const DEVICE_LOCATION_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["expo-location, in any import form", /["'`]expo-location(?:\/[^"'`]*)?["'`]/],
  [
    "a geolocation package",
    /["'`](?:@react-native-community\/geolocation|react-native-geolocation-service|react-native-location)["'`]/,
  ],
  ["a user-location layer", /\b(?:Native)?UserLocation\b/],
  ["follow/show user location", /\b(?:follow|show|track)UserLocation\b/i],
  ["the map's location manager", /\blocationManager\b/i],
  [
    "a current-position hook or call",
    /\b(?:useCurrentPosition|getCurrentPosition|watchPosition|getLastKnownPosition)\b/,
  ],
  ["the browser geolocation API", /\bgeolocation\b/i],
  ["a LOCATION permission request", /PermissionsAndroid[\s\S]{0,300}?LOCATION/],
  ["a LOCATION permission name", /ACCESS_(?:FINE|COARSE|BACKGROUND)_LOCATION/],
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function offendersIn(code: string): string[] {
  return DEVICE_LOCATION_PATTERNS.filter(([, re]) => re.test(code)).map(([name]) => name);
}

describe("no device location, anywhere in the app", () => {
  it("has teeth: every banned form is caught on a planted sample", () => {
    // Non-vacuity for the PATTERNS, not only the walk: a pattern that could
    // not match its own subject would pass over any tree.
    // Each sample names the pattern it must trip, and THAT pattern is tested —
    // not "any pattern". Several samples trip more than one rule
    // ("@react-native-community/geolocation" also contains the bare word
    // `geolocation`), so an any-match check would let a broken rule hide
    // behind a neighbour.
    const planted: ReadonlyArray<[string, string]> = [
      ["expo-location, in any import form", 'import * as Location from "expo-location";'],
      ["expo-location, in any import form", 'const L = require("expo-location");'],
      ["expo-location, in any import form", 'const L = await import("expo-location");'],
      [
        "expo-location, in any import form",
        'export { getForegroundPermissionsAsync } from "expo-location";',
      ],
      ["a geolocation package", 'import Geolocation from "@react-native-community/geolocation";'],
      ["a geolocation package", 'require("react-native-location");'],
      ["a user-location layer", "<UserLocation visible />"],
      ["follow/show user location", "<Camera followUserLocation />"],
      ["follow/show user location", "<Map showUserLocation />"],
      ["the map's location manager", "LocationManager.start();"],
      ["a current-position hook or call", "const p = useCurrentPosition();"],
      ["the browser geolocation API", "const g = navigator.geolocation;"],
      [
        "a LOCATION permission request",
        "PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);",
      ],
      ["a LOCATION permission name", '"android.permission.ACCESS_COARSE_LOCATION"'],
    ];
    for (const [name, sample] of planted) {
      const rule = DEVICE_LOCATION_PATTERNS.find(([n]) => n === name);
      expect([name, rule !== undefined]).toEqual([name, true]);
      expect([sample, rule?.[1].test(stripComments(sample))]).toEqual([sample, true]);
    }
    // Every rule has at least one sample of its own.
    const covered = new Set(planted.map(([name]) => name));
    expect(DEVICE_LOCATION_PATTERNS.map(([name]) => name).filter((n) => !covered.has(n))).toEqual(
      [],
    );
    // And a comment that NAMES the subject is not code.
    expect(offendersIn(stripComments("// never import expo-location here"))).toEqual([]);
  });

  it("finds none of them in the app's source, and no such dependency", () => {
    const files = [
      ...sourceFiles(path.join(MOBILE_ROOT, "src")),
      ...sourceFiles(path.join(MOBILE_ROOT, "app")),
    ];
    // Non-vacuity for the WALK: it found the tree, including the map itself.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("location-map.tsx"))).toBe(true);

    const offenders = files.flatMap((file) =>
      offendersIn(stripComments(readFileSync(file, "utf8"))).map(
        (name) => `${path.relative(MOBILE_ROOT, file)}: ${name}`,
      ),
    );
    expect(offenders).toEqual([]);

    const pkg = JSON.parse(readFileSync(path.join(MOBILE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((name) => /location|geolocation/i.test(name))).toEqual([]);
  });
});

// localidades-por-id B6 (design addendum #1): a pin whose name two rows of the
// province share (Mechita: partido Alberti and partido Bragado) — or that the
// geocoder could not name — comes back with NO jurisdiction and the candidate
// rows. The person picks one; nothing is chosen for them.
describe("¿Es acá? — the candidate localities", () => {
  const ALBERTI = {
    provinceCode: "AR-B",
    provinceName: "Buenos Aires",
    localityName: "Mechita",
    localityIndecId: "06021030",
    departmentName: "Alberti",
  };
  const BRAGADO = { ...ALBERTI, localityIndecId: "06112080", departmentName: "Bragado" };

  async function dragOntoMechita() {
    const onChange = renderPicker();
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.open));
    const map = await screen.findByTestId("maplibre-map");
    mockGeocode.mockResolvedValueOnce({
      outcome: "ok",
      payload: {
        command: "reverse",
        version: 1,
        label: "Mechita, Buenos Aires",
        jurisdiction: null,
        place: { status: "ambiguous", candidates: [ALBERTI, BRAGADO] },
      },
    });
    await act(async () => {
      fireEvent(map, "regionDidChange", {
        nativeEvent: { center: [-60.4, -35.07], zoom: 15, userInteraction: true },
      });
    });
    await waitFor(() => expect(screen.getByText("Mechita (Bragado), Buenos Aires")).toBeTruthy());
    return onChange;
  }

  it("lists both rows by department and picks neither", async () => {
    await dragOntoMechita();
    expect(screen.getByText(LOCATION_PICKER_COPY.whichLocality)).toBeTruthy();
    expect(screen.getByText("Mechita (Alberti), Buenos Aires")).toBeTruthy();
    expect(
      screen.getByLabelText("Mechita (Bragado), Buenos Aires").props.accessibilityState,
    ).toMatchObject({ checked: false });
  });

  it("the row the person picks is what the form gets, by id, marked as picked", async () => {
    const onChange = await dragOntoMechita();
    fireEvent.press(screen.getByText("Mechita (Bragado), Buenos Aires"));
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.confirm));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        jurisdiction: {
          provinceCode: "AR-B",
          provinceName: "Buenos Aires",
          localityName: "Mechita",
          localityIndecId: "06112080",
        },
        localityPicked: true,
      }),
    );
  });

  it("declining keeps the point with no locality", async () => {
    const onChange = await dragOntoMechita();
    fireEvent.press(screen.getByText("Mechita (Bragado), Buenos Aires"));
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.noneOfThese));
    fireEvent.press(screen.getByText(LOCATION_PICKER_COPY.confirm));
    const picked = onChange.mock.calls.at(-1)?.[0];
    expect(picked?.jurisdiction).toBeNull();
    expect(picked?.localityPicked).toBeUndefined();
  });
});
