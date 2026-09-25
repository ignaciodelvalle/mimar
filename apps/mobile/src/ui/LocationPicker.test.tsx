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

describe("no device location, anywhere in the app", () => {
  it("imports no location module and mounts no user-location layer", () => {
    const files = [
      ...sourceFiles(path.join(MOBILE_ROOT, "src")),
      ...sourceFiles(path.join(MOBILE_ROOT, "app")),
    ];
    // Non-vacuity: the walk found the tree, including the map itself.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("location-map.tsx"))).toBe(true);

    const banned = [
      /from\s+["']expo-location["']/,
      /require\(\s*["']expo-location["']\s*\)/,
      /\bUserLocation\b/,
      /\bNativeUserLocation\b/,
      /\buseCurrentPosition\b/,
      /\bLocationManager\b/,
      /\btrackUserLocation\b/,
      /navigator\.geolocation/,
    ];
    const offenders = files.flatMap((file) => {
      // Comments may NAME what is banned (this fence's own docblocks do);
      // only code is judged.
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      return banned.filter((re) => re.test(code)).map((re) => `${path.basename(file)}: ${re}`);
    });
    expect(offenders).toEqual([]);

    const pkg = JSON.parse(readFileSync(path.join(MOBILE_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["expo-location"]).toBeUndefined();
  });
});
