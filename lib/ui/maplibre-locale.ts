// Shared es-AR locale map for MapLibre GL maps.
//
// MapLibre stamps English strings from its built-in `defaultLocale` onto every
// control it renders — the canvas aria-label ("Map"), the marker title
// ("Map marker"), the attribution toggle ("Toggle attribution"), the zoom/
// fullscreen tooltips, the popup close button, and the cooperative-gestures
// overlay. In a Spanish (es-AR) product a screen-reader user would otherwise
// hear a mix of Spanish page copy and English map controls (recorrido QA:
// "Map marker" / "Toggle attribution" on the lost-credential map and Panorama).
//
// This constant is the SINGLE source of the map vocabulary so the government
// Panorama console and the public lost-credential mini-map speak ONE language
// instead of drifting into two copies. Keys are taken verbatim from
// maplibre-gl's `defaultLocale` export (v5.24) — do NOT invent keys; an unknown
// key is silently ignored by MapLibre and would give a false sense of coverage.
//
// `Map.Title` here is a neutral default ("Mapa"); a consumer with a more
// specific canvas name (e.g. the Panorama "Mapa de situación") spreads this
// constant and overrides that one key.
export const MAPLIBRE_LOCALE_ES: Record<string, string> = {
  // Canvas aria-label (neutral default — override per map when a better name exists).
  "Map.Title": "Mapa",
  // Marker aria-label / title.
  "Marker.Title": "Marcador del mapa",
  // NavigationControl (zoom + compass buttons).
  "NavigationControl.ZoomIn": "Acercar",
  "NavigationControl.ZoomOut": "Alejar",
  "NavigationControl.ResetBearing": "Restablecer orientación",
  // FullscreenControl.
  "FullscreenControl.Enter": "Pantalla completa",
  "FullscreenControl.Exit": "Salir de pantalla completa",
  // Popup close button.
  "Popup.Close": "Cerrar",
  // AttributionControl (the compact "ⓘ" toggle + feedback link).
  "AttributionControl.ToggleAttribution": "Mostrar atribución",
  "AttributionControl.MapFeedback": "Comentarios del mapa",
  // GeolocateControl.
  "GeolocateControl.FindMyLocation": "Encontrar mi ubicación",
  "GeolocateControl.LocationNotAvailable": "Ubicación no disponible",
  // CooperativeGesturesHandler overlay (shown when scrolling over the canvas
  // without the modifier key).
  "CooperativeGesturesHandler.WindowsHelpText": "Usá Ctrl + rueda para hacer zoom",
  "CooperativeGesturesHandler.MacHelpText": "Usá ⌘ + rueda para hacer zoom",
  "CooperativeGesturesHandler.MobileHelpText": "Usá dos dedos para mover el mapa",
};
