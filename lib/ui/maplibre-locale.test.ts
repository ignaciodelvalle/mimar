// Guards the shared es-AR MapLibre locale (Cursor/Cowork staging QA, BAJO a11y:
// "Map marker" / "Toggle attribution" reached screen readers on the maps).
// The constant must (1) cover the keys users actually hit, and (2) never let an
// English defaultLocale string leak back through.

import { describe, expect, it } from "vitest";

import { MAPLIBRE_LOCALE_ES } from "@/lib/ui/maplibre-locale";

// maplibre-gl v5.24 defaultLocale values for the keys we localize — the strings
// that reached the screen reader before this fix. No value in our map may equal
// its English default.
const ENGLISH_DEFAULTS: Record<string, string> = {
  "Map.Title": "Map",
  "Marker.Title": "Map marker",
  "NavigationControl.ZoomIn": "Zoom in",
  "NavigationControl.ZoomOut": "Zoom out",
  "NavigationControl.ResetBearing": "Drag to rotate map, click to reset north",
  "FullscreenControl.Enter": "Enter fullscreen",
  "FullscreenControl.Exit": "Exit fullscreen",
  "Popup.Close": "Close popup",
  "AttributionControl.ToggleAttribution": "Toggle attribution",
  "AttributionControl.MapFeedback": "Map feedback",
  "GeolocateControl.FindMyLocation": "Find my location",
  "GeolocateControl.LocationNotAvailable": "Location not available",
  "CooperativeGesturesHandler.WindowsHelpText": "Use Ctrl + scroll to zoom the map",
  "CooperativeGesturesHandler.MacHelpText": "Use ⌘ + scroll to zoom the map",
  "CooperativeGesturesHandler.MobileHelpText": "Use two fingers to move the map",
};

describe("MAPLIBRE_LOCALE_ES", () => {
  it("localizes the two keys QA caught in English", () => {
    expect(MAPLIBRE_LOCALE_ES["Marker.Title"]).toBe("Marcador del mapa");
    expect(MAPLIBRE_LOCALE_ES["AttributionControl.ToggleAttribution"]).toBe("Mostrar atribución");
  });

  it("never leaves a value equal to its English defaultLocale string", () => {
    for (const [key, value] of Object.entries(MAPLIBRE_LOCALE_ES)) {
      const english = ENGLISH_DEFAULTS[key];
      // Every localized key must be a real defaultLocale key (guards typos that
      // MapLibre would silently ignore).
      expect(english, `unknown maplibre locale key: ${key}`).toBeDefined();
      expect(value).not.toBe(english);
    }
  });
});
