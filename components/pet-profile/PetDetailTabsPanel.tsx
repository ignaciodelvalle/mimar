"use client";

// PetDetailTabsPanel — client component driving the two-face flip system
// (two-face redesign, 2026-07-01, design ADR-1/ADR-6).
//
// SINGLE FLIP CONTROL (tarjeta-todo, PO 2026-07-19 — re-affirming PO decision
// #645): the band "Dar vuelta / Ver credencial" button that DocumentChrome
// renders on both faces is the ONLY face switcher. The segmented
// Credencial|Libreta tablist the July redesign restored above the card was
// removed again — this time WITH the a11y contract the band button now fully
// owns: descriptive accessible name ("Girar a Libreta/Credencial"),
// aria-pressed toggle state, keyboard reachability (it is a real button), and
// focus moved onto the newly-shown face after a flip (see focusShownFace below,
// wired to FlipCard.onFaceShown — it has to wait for the face to be painted).
//
// - Reads the active face from ?tab= (default: credencial).
// - Syncs hash fragments: legacy anchors (#libreta, #vacunas, #historial,
//   #resumen) still activate the right face on mount.
// - FlipCard (ADR-11) mounts BOTH faces always, so the back face needs real
//   content (or a loading skeleton) from the very first render.
// - Credencial content is pre-rendered server-side and passed as a node
//   (eager, zero client cost) — Face 1 stays the only SSR-eager content.
// - Libreta content (perf audit 2026-07-19, PF3): ALSO rendered server-side
//   now, inside its own <Suspense> the page wraps around it, and passed down
//   as `libretaContent` — same "pre-rendered node" shape as `credencialContent`.
//   This replaced a client mount-effect that called `getLibretaFaceData` (a
//   server action) on EVERY profile load: that action re-ran requirePetAccess's
//   FULL auth + pet-access chain (a second getUser() + ownership query) even
//   though the credential card had already resolved access server-side in the
//   SAME request. The page now calls the tab-data use-case directly with the
//   already-resolved access — no client-trusted token, no redundant re-auth —
//   and streams it in via Suspense so Face 1's SSR paint is still unblocked.
// - Print: libreta-print.css is imported here so it's only applied when this
//   component (and thus the Libreta face) is rendered.

import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import "@/app/(app)/mis-mascotas/[publicToken]/libreta/libreta-print.css";
import type { ChromeSituation } from "@/components/pet-profile/DocumentChrome";
import { FlipCard, type FlipCardFace, PET_FACE_PANEL_ID } from "@/components/pet-profile/FlipCard";
import { type PetFace, resolvePetFace } from "@/lib/domain/pet-face-nav";
import { scrollIntoViewRespectingMotion } from "@/lib/ui/reduced-motion-scroll";
import { pushTabUrl, replaceTabUrl } from "@/lib/ui/sheet-nav";

/** Which face is active. Same shape as `PetFace` — kept as a local alias so
 * every prior call site (props, HASH_TO_TAB, state) can keep the name it
 * already used before the tab bar (PetDetailTabs.tsx) was removed. */
export type TabKey = PetFace;

// ---------------------------------------------------------------------------
// Loading skeleton / error state
// ---------------------------------------------------------------------------

// Exported (PF3): the page's server-side Suspense wrapper around the Libreta
// fetch reuses these same skeleton/error presentational nodes so the two
// render paths (Suspense fallback vs. resolved error) stay visually identical
// to what this component always rendered.
export function TabLoadingSkeleton() {
  return (
    <div
      className="op-fade-in space-y-[14px] py-6 animate-pulse"
      aria-busy="true"
      aria-label="Cargando..."
    >
      <div className="h-[18px] w-1/3 rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)]" />
      <div className="h-[14px] w-full rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)]" />
      <div className="h-[14px] w-5/6 rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)]" />
      <div className="h-[14px] w-4/5 rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)]" />
    </div>
  );
}

export function TabErrorState({ message }: { message: string }) {
  return (
    <div
      className="py-8 text-center font-ln-mono text-sm uppercase tracking-[.06em]"
      style={{ color: "var(--color-ln-err)" }}
      role="alert"
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hash → face mapping (legacy anchor deep-links)
// ---------------------------------------------------------------------------

const HASH_TO_TAB: Record<string, TabKey> = {
  libreta: "libreta",
  vacunas: "libreta",
  historial: "libreta",
  resumen: "credencial",
  credencial: "credencial",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  /** Which pet this panel belongs to — not used for fetching anymore (PF3:
   * both faces arrive pre-rendered from the server), kept as a stable
   * data-attribute hook for e2e/debugging. */
  petPublicToken: string;
  /** Face 1 content — rendered server-side and passed as a node. */
  credencialContent: ReactNode;
  /**
   * Face 2 content — ALSO rendered server-side (PF3 perf fix), wrapped by the
   * page in its own <Suspense> so it streams independently of Face 1. Replaces
   * the old client mount-effect fetch (getLibretaFaceData) that re-ran the
   * full auth + pet-access chain on every profile load.
   */
  libretaContent: ReactNode;
  /** Active face resolved from searchParams on the server (resolvePetFace). */
  initialFace: TabKey;
  /**
   * Whether the current viewer is the pet owner. Org-path viewers still see
   * the Libreta face — ADR-10 collapsed it to ONE consolidated timeline
   * (owner sees everything, org sees the oficial-only subset), no lens
   * toggle and no face hidden anymore.
   */
  isOwner: boolean;
  /**
   * Pet situation for the document chrome band (pet-state-header) — server-
   * derived, pre-gendered label. Threaded to FlipCard so BOTH faces carry the
   * band tint + state chip. Null = default blue band.
   */
  situation?: ChromeSituation | null;
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PetDetailTabsPanel({
  petPublicToken,
  credencialContent,
  libretaContent,
  initialFace,
  isOwner,
  situation,
}: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [activeFace, setActiveFace] = useState<TabKey>(initialFace);

  // Sync face from searchParam changes (back/forward nav). Must reuse the
  // SAME legacy-mapping table the server used to resolve `initialFace`
  // (resolvePetFace) — a naive `tab === "libreta"` check here would silently
  // override the correctly SSR-resolved face for every OTHER legacy value
  // (`?tab=vacunas`, `?tab=historial`, the `/historial`+`/vacunas` redirect
  // stubs) back to "credencial" on mount, since this effect always runs once
  // after the initial render (bug found in batch-2 e2e verification).
  useEffect(() => {
    const tabParam = searchParams.get("tab") ?? undefined;
    const lenteParam = searchParams.get("lente") ?? undefined;
    const { face } = resolvePetFace({ tab: tabParam, lente: lenteParam, isOwner });
    setActiveFace(face);
  }, [searchParams, isOwner]);

  // On mount: check for a legacy hash fragment and activate that face.
  //
  // Router-hot-path fix: this is a SILENT one-time normalization (the user
  // didn't take a new action — we're just migrating a stale/legacy URL on
  // load), so it uses replaceTabUrl (native History API replaceState), not
  // router.replace and not pushTabUrl. router.replace reproduced the same
  // silent-drop symptom as every other router.push/replace call this module
  // exists to route around (see lib/ui/sheet-nav.ts); pushTabUrl would be
  // wrong here too even if it worked, since it pushes a history entry — the
  // back button shouldn't have to skip through a migration the user never
  // asked for.
  const hashHandledRef = useRef(false);
  useEffect(() => {
    if (hashHandledRef.current) return;
    hashHandledRef.current = true;
    const hash = window.location.hash.slice(1);
    const faceFromHash = HASH_TO_TAB[hash];
    if (faceFromHash && faceFromHash !== initialFace) {
      const params = new URLSearchParams(searchParams.toString());
      // `?lente=` is a dead param (ADR-10 removed the lens system;
      // resolvePetFace ignores it) — stop writing it. Any legacy `?lente=`
      // already in the URL is preserved untouched (harmless, still resolves).
      if (faceFromHash === "libreta") {
        params.set("tab", "libreta");
      } else {
        params.delete("tab");
        params.delete("lente");
      }
      replaceTabUrl(`?${params.toString()}`);
      requestAnimationFrame(() => {
        scrollIntoViewRespectingMotion(document.querySelector("[data-section='flip-card']"), {
          block: "start",
        });
      });
    }
  }, [searchParams, initialFace]);

  // Face navigation (ADR-11) — writes the active face into ?tab=.
  //
  // Router-hot-path fix: writes the URL via pushTabUrl (native History API)
  // instead of router.replace — reproduced 3/3 in production with the same
  // silent-drop symptom as the sheets (see lib/ui/sheet-nav.ts). pushState
  // (not replaceState) is required here so the browser back button can undo
  // a flip and restore the previous face via popstate → useSearchParams()
  // reactivity above. `?lente=` is no longer written (dead param, ADR-10).
  //
  // `focusPanelAfterFlipRef` records that focus should land on the newly-shown
  // face once the flip lands (the active-face effect below performs the move
  // once `activeFace` catches up), so a keyboard/screen-reader user who
  // activates the band turn button is taken to the content that appeared. The
  // move only happens for user-initiated flips — never on mount / deep-link /
  // browser-back (which leave the flag unset).
  const focusPanelAfterFlipRef = useRef(false);

  function goToFace(target: TabKey) {
    if (target === activeFace) return;
    focusPanelAfterFlipRef.current = true;
    const params = new URLSearchParams(searchParams.toString());
    if (target === "credencial") {
      params.delete("tab");
      params.delete("lente");
    } else {
      params.set("tab", "libreta");
    }
    const qs = params.toString();
    pushTabUrl(qs ? `${pathname}?${qs}` : pathname);
  }

  // Move focus onto the shown face after a user-initiated flip settles.
  //
  // Driven by FlipCard's onFaceShown, NOT by an `activeFace` effect. activeFace
  // changes the instant the button is pressed; the face it names is still
  // `display:none` for the ~205ms until the turn reaches edge-on and swaps, and
  // .focus() on a display:none element is a silent no-op in a real browser.
  // Focus therefore went nowhere and stayed on <body> — measured in Chromium:
  // the card flipped correctly and document.activeElement was BODY 4s later,
  // i.e. a keyboard user flipped the credential and lost their place.
  //
  // The jsdom interaction test did not catch it because jsdom lets focus() land
  // on a display:none element. It passed while the browser did the opposite —
  // and e2e/a11y-regression.spec.ts, once CI finally ran it, said so.
  const focusShownFace = useCallback((face: FlipCardFace) => {
    if (!focusPanelAfterFlipRef.current) return;
    focusPanelAfterFlipRef.current = false;
    document.getElementById(PET_FACE_PANEL_ID[face])?.focus();
  }, []);

  // THE flip trigger (single control): the band turn button DocumentChrome
  // renders inside each face (FlipCard.onFlip → switchFace). It writes ?tab=
  // through goToFace like every previous trigger did.
  function switchFace() {
    goToFace(activeFace === "credencial" ? "libreta" : "credencial");
  }

  return (
    <div id="tab-panel" className="ln-doc-root" data-pet-token={petPublicToken}>
      <FlipCard
        front={credencialContent}
        back={libretaContent}
        activeFace={activeFace}
        onFlip={switchFace}
        onFaceShown={focusShownFace}
        situation={situation}
      />
    </div>
  );
}
