// Icon component backed by lucide-react.
//
// Previously a stub for the icono-arg webfont (never committed). Replaced
// with a curated ICON_MAP covering every name actually used in the app.
//
// Public API is unchanged:
//   <Icon name="vacuna" size="md" decorative />
//
// Size tokens: "sm" → 16 px, "md" → 20 px, "lg" → 24 px.
// Numbers are treated as pixels; arbitrary CSS strings (e.g. "1.1em") are
// passed via width/height attributes on the SVG.
// Icons inherit currentColor — the parent element controls the color.
//
// Unknown names: render <HelpCircle> fallback + console.warn in development.
// Kept as a free string (not a union) so callers with dynamic names compile
// without casting and unknown names degrade gracefully.

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bell,
  BookOpen,
  BriefcaseMedical,
  Building2,
  CalendarDays,
  CalendarHeart,
  Camera,
  Cat,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleDot,
  Clock,
  CloudRain,
  Dog,
  DoorOpen,
  Download,
  Droplets,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Flag,
  Flower2,
  Gift,
  Handshake,
  Heart,
  HelpCircle,
  Home,
  IdCard,
  ImageDown,
  Info,
  Laptop,
  Layers,
  LayoutDashboard,
  LineChart,
  Link2,
  Lock,
  LogOut,
  Mail,
  MapPin,
  Megaphone,
  Menu,
  MessageSquare,
  Mic,
  Microscope,
  Milk,
  MoreHorizontal,
  Nfc,
  Package,
  Paperclip,
  PauseCircle,
  PawPrint,
  Pencil,
  Phone,
  Pill,
  Play,
  Printer,
  QrCode,
  RefreshCw,
  Scale,
  Scissors,
  Search,
  Settings,
  Share2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Smartphone,
  Star,
  Stethoscope,
  Swords,
  Syringe,
  Tag,
  Unlock,
  Users,
  Warehouse,
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type React from "react";
import type { HTMLAttributes } from "react";

/**
 * Name of an icon in the ICON_MAP registry.
 * Kept as a plain string (not a union) so dynamic callers compile without
 * casting and unknown names fall back gracefully.
 */
export type IconName = string;

/**
 * App icon name → Lucide component. THE AUTHORITY for what a name draws.
 *
 * Spanish semantic names match what callers pass (vacuna, corazon, …).
 * English/UI names cover Alert / EmptyState / Badge slots (info, close, …).
 *
 * EXPORTED since 2026-09-03, for one consumer: `components/Icon.test.tsx`,
 * which compares this map against `@dim/contract/icons`' shared table by
 * component REFERENCE. That table's header says "change a glyph THERE first —
 * this table follows", and until the export existed that sentence was a
 * comment with nothing behind it: a web-only glyph edit left the phone on the
 * old picture with every gate green. Nothing else should import this — the
 * `<Icon>` component below is the API.
 */
export const ICON_MAP: Record<string, LucideIcon> = {
  // ── Event form icons ─────────────────────────────────────────────────────
  vacuna: Syringe,
  microchip: Nfc,
  "microchip-reemplazo": RefreshCw,
  transferencia: RefreshCw,
  peso: Scale,
  medicacion: Pill,
  esterilizacion: Scissors,
  tatuaje: Pencil,
  embarazo: CalendarHeart,
  lactancia: Milk,
  checkin: MapPin,
  nota: FileText,
  sintoma: Stethoscope,
  clinico: BriefcaseMedical,
  mordedura: PawPrint,
  fallecimiento: Flower2,
  vet: Stethoscope,
  "medicacion-fin": XCircle,

  "marca-regla": Flag,

  // ── Core semantic icons ──────────────────────────────────────────────────
  credenciales: IdCard,
  credential: IdCard,
  libreta: BookOpen,
  booklet: BookOpen,
  denuncia: Megaphone,
  lupa: Search,
  search: Search,
  qr: QrCode,
  corazon: Heart,
  heart: Heart,
  telefono: Phone,
  phone: Phone,
  mail: Mail,
  email: Mail,
  mensaje: MessageSquare,
  chat: MessageSquare,
  mic: Mic,
  microfono: Mic,
  enlace: Link2,
  ubicacion: MapPin,
  "map-pin": MapPin,
  ojo: Eye,
  ver: Eye,
  anonimo: EyeOff,
  // "blind, not calm" — the no-signal epistemic empty-state icon (C4,
  // 2026-07-22): a surveillance surface with nothing reported IN, as
  // distinct from shield-check's "verified safe" meaning.
  "eye-off": EyeOff,
  // The reveal toggle's hidden state, named the way `ver` above is named. It
  // came from the phone (PasswordField, QOL 2026-09-01), which is backwards —
  // this map is the authority and the shared table follows it — and the key
  // lived only in `@dim/contract/icons` until 2026-09-03, when
  // components/Icon.test.tsx made that asymmetry fail instead of pass. Added
  // here rather than renaming the phone's key to `eye-off`: `ver`/`ocultar` is
  // one Spanish pair for one toggle, and `eye-off` is the English slot above
  // with a different meaning of its own.
  ocultar: EyeOff,
  casa: Home,
  home: Home,
  camara: Camera,
  celular: Smartphone,
  adjuntar: Paperclip,
  alerta: AlertTriangle,
  alert: AlertTriangle,
  "alert-triangle": AlertTriangle,
  "alert-circle": AlertTriangle,
  candado: Lock,
  lock: Lock,
  reloj: Clock,
  clock: Clock,
  editar: Pencil,
  edit: Pencil,
  perdida: Siren,
  lost: Siren,
  sirena: Siren,
  huella: PawPrint,
  paw: PawPrint,
  usuarios: Users,
  users: Users,
  edificio: Building2,
  building: Building2,

  // ── Case kind icons ───────────────────────────────────────────────────────
  solicitud: FileText,
  propuesta: MessageSquare,
  trato: Handshake,
  reparacion: Wrench,
  brote: AlertTriangle,
  custodia: FileText,
  disputa: Scale,

  // ── Welfare report kind icons (denuncias cruelty picker) ─────────────────
  "door-open": DoorOpen,
  droplets: Droplets,
  "shield-alert": ShieldAlert,
  espadas: Swords,
  swords: Swords,
  cadena: Link2,
  "cloud-rain": CloudRain,
  warehouse: Warehouse,
  package: Package,

  // ── UI semantic icons ────────────────────────────────────────────────────
  close: X,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
  "help-circle": HelpCircle,
  impresora: Printer,
  printer: Printer,
  regalo: Gift,
  gift: Gift,
  unlock: Unlock,
  "candado-abierto": Unlock,
  "check-circle": CheckCircle,
  "shield-check": ShieldCheck,
  shield: Shield,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  "chevron-down": ChevronDown,
  // Direction, NOT disclosure. A chevron is the universal "expand me"
  // affordance; using one for a trend delta made operators try to click it
  // (PO, live 2026-07-25: "hay una flecha de minimizar que no funciona").
  // OpKpi already renders real arrows for the same concept.
  "arrow-up": ArrowUp,
  "arrow-down": ArrowDown,
  "chart-line": LineChart,
  "heart-filled": Heart,
  menu: Menu,
  settings: Settings,
  bell: Bell,
  logout: LogOut,
  dashboard: LayoutDashboard,
  laptop: Laptop,
  zap: Zap,
  share: Share2,
  check: Check,
  ellipsis: MoreHorizontal,
  tag: Tag,
  girar: RefreshCw,

  // ── Panorama v3 rail icons ───────────────────────────────────────────────
  // vista (preset/view picker) and capas (layer on/off) used to share the
  // same Layers glyph, making the top two rail buttons look identical
  // (panorama QA root-cause #1). LayoutDashboard reads as "which view/
  // preset", distinct from Layers' "stack of layers" reading — already
  // imported above, so no new dependency.
  vista: LayoutDashboard,
  capas: Layers,
  filtro: Filter,
  filter: Filter,
  periodo: CalendarDays,
  calendario: CalendarDays,
  "linea-tiempo": LineChart,
  timeline: LineChart,
  exportar: Download,
  descargar: Download,
  actualizar: RefreshCw,
  acerca: Info,

  // ── UI professionalism pass — status glyphs, species, media actions ──────
  // Operator state badges (OpStateBadge / OpKpi): filled-dot / empty-ring /
  // pause / star map to the closest sober lucide equivalents of the retired
  // unicode status glyphs.
  "circle-dot": CircleDot,
  "circle-filled": CircleDot,
  circulo: Circle,
  circle: Circle,
  pausa: PauseCircle,
  "pause-circle": PauseCircle,
  estrella: Star,
  star: Star,
  // Investigation / lab (vigilancia)
  microscopio: Microscope,
  microscope: Microscope,
  // Media + navigation affordances (panorama exports, external links, play)
  reproducir: Play,
  play: Play,
  externo: ExternalLink,
  "external-link": ExternalLink,
  "exportar-imagen": ImageDown,
  "image-down": ImageDown,
  // Clinical: scheduled hospital/vet visit (reuse BriefcaseMedical — no
  // dedicated building glyph needed; matches the clinico family).
  hospital: BriefcaseMedical,
  // Species options (owner new-pet form)
  perro: Dog,
  dog: Dog,
  gato: Cat,
  cat: Cat,
};

/** All registered icon names — consumed by the IconSearch browser in /design. */
export const iconNames: ReadonlyArray<IconName> = Object.keys(ICON_MAP);

// ── Size resolution ──────────────────────────────────────────────────────────

type SizeProp = "sm" | "md" | "lg" | number | string;

function resolveSize(size?: SizeProp): { px?: number; css?: string } {
  if (size === undefined) return { px: 20 }; // default md
  if (size === "sm") return { px: 16 };
  if (size === "md") return { px: 20 };
  if (size === "lg") return { px: 24 };
  if (typeof size === "number") return { px: size };
  return { css: size }; // arbitrary CSS string e.g. "1.1em"
}

// ── Component ────────────────────────────────────────────────────────────────

type IconProps = {
  name: IconName;
  /**
   * "sm" (16 px) | "md" (20 px, default) | "lg" (24 px) | number (px) | CSS string.
   */
  size?: SizeProp;
  /** When true, aria-hidden is set — use for decorative icons paired with visible text. */
  decorative?: boolean;
} & Omit<HTMLAttributes<SVGElement>, "aria-hidden">;

export function Icon({ name, size, decorative, className, style, ...rest }: IconProps) {
  const LucideComponent = ICON_MAP[name];

  if (!LucideComponent) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[Icon] Unknown icon name: "${name}". Rendering fallback.`);
    }
    return (
      <FallbackIcon
        name={name}
        size={size}
        decorative={decorative}
        className={className}
        style={style}
        {...(rest as React.SVGProps<SVGSVGElement>)}
      />
    );
  }

  const { px, css } = resolveSize(size);
  const sizeProps = px !== undefined ? { width: px, height: px } : { width: css, height: css };

  return (
    <LucideComponent
      data-icon-name={name}
      aria-hidden={decorative ? true : undefined}
      className={className}
      style={style}
      strokeWidth={1.75}
      {...sizeProps}
      {...(rest as React.SVGProps<SVGSVGElement>)}
    />
  );
}

function FallbackIcon({ name, size, decorative, className, style, ...rest }: IconProps) {
  const { px, css } = resolveSize(size);
  const sizeProps = px !== undefined ? { width: px, height: px } : { width: css, height: css };

  return (
    <HelpCircle
      data-icon-name={name}
      aria-hidden={decorative ? true : undefined}
      className={className}
      style={style}
      strokeWidth={1.75}
      {...sizeProps}
      {...(rest as React.SVGProps<SVGSVGElement>)}
    />
  );
}
