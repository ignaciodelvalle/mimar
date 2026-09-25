// The one native map in this app (M17) — MapLibre over OpenStreetMap tiles.
//
// WHY MAPLIBRE. `@maplibre/maplibre-react-native` 11 is built for the new
// architecture this app runs on (RN 0.86, Fabric), needs no API key and no
// billing account, and draws the SAME raster OSM tiles the web's
// `components/LocationPicker.tsx` draws — one source, one attribution, one line
// in /privacidad. It is not in SDK 57's `bundledNativeModules` table, so its
// version is the library's own pin, checked against the SDK in
// `release-config.test.ts`'s rules like every other native module.
// `react-native-maps` was the fallback and was not needed; it would also have
// meant Google's SDK on Android even with OSM tiles on top.
//
// NO DEVICE LOCATION. The library ships a location engine and its manifest asks
// for ACCESS_FINE/COARSE_LOCATION; this app blocks both permissions in
// `app.json` and never mounts `UserLocation` or tracks the user — the PO decided
// on 2026-09-24 that no GPS is read or stored anywhere. A fence in
// `location-picker-fences.test.ts` keeps it that way.
//
// THE PIN IS FIXED AT THE CENTRE AND THE MAP MOVES UNDER IT. That is the
// "draggable pin" on a phone: a pin dragged by a thumb hides the very spot it is
// being dropped on, and on a 5" J7 screen the thumb is most of the target. With
// the pin drawn over the centre, the person drags the MAP, sees the exact point
// under the pin tip, and the point is whatever the camera settles on
// (`onRegionDidChange`). Zoom buttons are 48dp for the same thumb.
//
// OSM TILE POLICY. The tile servers require an identifying User-Agent and
// forbid heavy use; the header is set once here, and the traffic note for
// scaling past the pilot is in the handoff (move to a tile provider).
//
// EVERYTHING ELSE LIVES IN `LocationPicker.tsx`, which imports this file only
// when the map step is opened — the native view is never mounted off screen.

import {
  Camera,
  type CameraRef,
  Map as MapLibreMap,
  TransformRequestManager,
} from "@maplibre/maplibre-react-native";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "./Icon";
import { FONTS } from "./fonts";
import { COLORS, PRESSED_OPACITY, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "./theme";

/** The web's tile source, verbatim. */
const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

/** OSM's usage policy asks every client to identify itself. */
const OSM_USER_AGENT = "miMAR/1.0 (+https://www.mimar.com.ar)";

let userAgentInstalled = false;
function installUserAgentOnce() {
  if (userAgentInstalled) return;
  userAgentInstalled = true;
  try {
    TransformRequestManager.addHeader({
      match: "tile\\.openstreetmap\\.org",
      name: "User-Agent",
      value: OSM_USER_AGENT,
    });
  } catch {
    // A header that cannot be set is not a reason to have no map.
  }
}

export const MAP_MIN_ZOOM = 4;
export const MAP_MAX_ZOOM = 19;

export type MapPoint = { lat: number; lng: number };

export function LocationMap({
  initialCenter,
  initialZoom,
  moveTo,
  onCenterChange,
  onFail,
}: {
  initialCenter: MapPoint;
  initialZoom: number;
  /** A point to move the camera to (a search result), with a fresh key each time. */
  moveTo: { point: MapPoint; zoom: number; key: number } | null;
  /** The point under the pin once the map settles; `byHand` = the person moved it. */
  onCenterChange: (point: MapPoint, byHand: boolean) => void;
  /** The style or tiles could not load — the picker falls back to the list. */
  onFail: () => void;
}) {
  const camera = useRef<CameraRef>(null);
  const zoom = useRef(initialZoom);
  useEffect(installUserAgentOnce, []);

  useEffect(() => {
    if (moveTo === null) return;
    camera.current?.easeTo({
      center: [moveTo.point.lng, moveTo.point.lat],
      zoom: moveTo.zoom,
      duration: 400,
    });
    zoom.current = moveTo.zoom;
  }, [moveTo]);

  const zoomBy = (delta: number) => {
    const next = Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, zoom.current + delta));
    zoom.current = next;
    camera.current?.zoomTo(next, { duration: 200 });
  };

  return (
    <View style={styles.frame}>
      <MapLibreMap
        style={styles.map}
        mapStyle={OSM_STYLE}
        // J7 (Exynos 7580, Android 8): the texture view composites with the
        // pin overlay without the surface-view z-order fights older GPUs show.
        androidView="texture"
        touchRotate={false}
        touchPitch={false}
        logo={false}
        compass={false}
        attribution
        onRegionDidChange={(event) => {
          const { center, zoom: z, userInteraction } = event.nativeEvent;
          zoom.current = z;
          onCenterChange({ lng: center[0], lat: center[1] }, userInteraction);
        }}
        onDidFailLoadingMap={onFail}
      >
        <Camera
          ref={camera}
          minZoom={MAP_MIN_ZOOM}
          maxZoom={MAP_MAX_ZOOM}
          initialViewState={{
            center: [initialCenter.lng, initialCenter.lat],
            zoom: initialZoom,
          }}
        />
      </MapLibreMap>

      {/* The pin, drawn over the centre; its TIP is the point. Not touchable:
          the gesture belongs to the map underneath. */}
      <View style={styles.pinLayer} pointerEvents="none">
        <View style={styles.pinLift}>
          <Icon name="map-pin" size={44} color={COLORS.seal} />
        </View>
      </View>

      <View style={styles.zoom}>
        <ZoomButton label="+" hint="Acercar el mapa" onPress={() => zoomBy(1)} />
        <ZoomButton label="−" hint="Alejar el mapa" onPress={() => zoomBy(-1)} />
      </View>
    </View>
  );
}

function ZoomButton({
  label,
  hint,
  onPress,
}: {
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint}
      onPress={onPress}
      style={({ pressed }) => [styles.zoomButton, pressed ? styles.zoomPressed : null]}
    >
      <Text style={styles.zoomLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Large on purpose: the map is the control. ~60% of a J7's usable height.
  frame: {
    height: 360,
    borderRadius: RADIUS.control,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  map: { flex: 1 },
  pinLayer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  // The icon's tip sits at its bottom edge; lift it so the TIP is on centre.
  pinLift: { marginBottom: 44 },
  zoom: { position: "absolute", right: SPACE.sm, top: SPACE.sm, gap: SPACE.xs },
  zoomButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomPressed: { opacity: PRESSED_OPACITY },
  zoomLabel: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.xl, color: COLORS.ink },
});
