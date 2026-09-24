// Icon component backed by lucide-react-native — the web's `components/Icon.tsx`
// contract, drawn by the sibling package.
//
// THE NAME COLUMN IS SHARED, THE GLYPHS ARE NOT. `@dim/contract/icons` carries
// the name → lucide-export-name table (framework-free strings), and each side
// resolves the export against its OWN lucide package: the web against
// `lucide-react`, this file against `lucide-react-native`. `lucide-react-native`
// is JS-only — no entry in `expo/bundledNativeModules.json`, no config plugin,
// no android/ios tree, zero runtime dependencies — and renders through the
// already-pinned `react-native-svg`, so adding it does not move the native
// fingerprint (release-config.test.ts would object if it did).
//
// Public API mirrors the web's:
//   <Icon name="girar" size="sm" color="#fff" />
//
// Size tokens: "sm" → 16 px, "md" → 20 px (default), "lg" → 24 px — the web's
// values. `strokeWidth` 1.75, the web's value. ONE deviation, because a phone
// is not a browser: SVG on React Native does not inherit `currentColor`, so
// `color` is an explicit prop (default: reading ink) instead of inheritance.
//
// Unknown names render the HelpCircle fallback + console.warn in development —
// the web's exact degradation. Kept as a free string (not a union) for the
// same reason the web keeps one: `situation.icon` arrives from the server, and
// a payload from a newer server must degrade gracefully, not fail to compile.

import { PET_PROFILE_ICONS } from "@dim/contract/icons";
import {
  AlertTriangle,
  BookOpen,
  CalendarHeart,
  Check,
  CheckCircle,
  Eye,
  EyeOff,
  Flower2,
  Heart,
  HelpCircle,
  Home,
  type LucideIcon,
  MapPin,
  MoreHorizontal,
  PawPrint,
  Pencil,
  Pill,
  RefreshCw,
  Share2,
  Shield,
  Siren,
} from "lucide-react-native";

import { COLORS } from "./theme";

/**
 * Lucide export name → component, for every glyph the shared table names.
 *
 * EXPLICIT IMPORTS, NOT `import * as`: Metro does not tree-shake a CJS
 * namespace import, and the full lucide set is ~1500 components. The coherence
 * between this object and the contract table is fenced by Icon.test.tsx —
 * every table value must be a key here, and every key must be the real
 * lucide-react-native export of that name.
 */
const LUCIDE_GLYPHS: Record<string, LucideIcon> = {
  AlertTriangle,
  BookOpen,
  CalendarHeart,
  Check,
  CheckCircle,
  Eye,
  EyeOff,
  Flower2,
  Heart,
  Home,
  MapPin,
  MoreHorizontal,
  PawPrint,
  Pencil,
  Pill,
  RefreshCw,
  Share2,
  Shield,
  Siren,
};

export type IconName = string;

type SizeProp = "sm" | "md" | "lg" | number;

function resolveSize(size?: SizeProp): number {
  if (size === undefined || size === "md") return 20;
  if (size === "sm") return 16;
  if (size === "lg") return 24;
  return size;
}

type IconProps = {
  name: IconName;
  /** "sm" (16 px) | "md" (20 px, default) | "lg" (24 px) | number (px). */
  size?: SizeProp;
  /** Explicit — RN SVG has no currentColor inheritance. Defaults to reading ink. */
  color?: string;
};

export function Icon({ name, size, color = COLORS.ink }: IconProps) {
  const exportName = (PET_PROFILE_ICONS as Record<string, string>)[name];
  const Glyph = exportName === undefined ? undefined : LUCIDE_GLYPHS[exportName];

  if (Glyph === undefined) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[Icon] Unknown icon name: "${name}". Rendering fallback.`);
    }
    return <HelpCircle size={resolveSize(size)} color={color} strokeWidth={1.75} />;
  }

  return <Glyph size={resolveSize(size)} color={color} strokeWidth={1.75} />;
}
