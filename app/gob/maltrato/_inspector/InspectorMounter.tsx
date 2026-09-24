"use client";

// InspectorMounter — reactive host for the master-detail inspector (task #12).
//
// Twin of the pet-profile SheetMounter pattern (4 exist as templates): always
// mounted by the page, it simply REACTS to useSearchParams() — `?caso=<id>`
// selects a denuncia, `&mascota=<token>` drills into its subject pet. Selection
// is written by the row (and the drill button) through the native-History
// helpers in inspector-nav.ts, so the queue Server Component never re-runs and
// the list's tab/cursor/scroll are physically preserved.
//
// Fetch = components/panorama/use-keyed-abort.ts (last-click-wins): browsing
// quickly through cases aborts the superseded request instead of racing it into
// a stale render. An AbortError is a SUPERSEDED request, never a failure — the
// catch blocks early-return on it (the design-mandated rule).
//
// Layout: on lg+ the panel fills the page's right column; below lg it flips to a
// fixed overlay drawer — SAME component, container classes only (spec).

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useKeyedAbort } from "@/components/panorama/use-keyed-abort";
import type { GobPetSubView } from "@/lib/infra/gob-pet-subview";
import type { WelfareInspectorDetail } from "@/lib/infra/welfare-inspector-detail";

import { InspectorPanel } from "./InspectorPanel";
import { PetSubView } from "./PetSubView";
import { WelfareInspectorContent } from "./WelfareInspectorContent";
import { closeInspector, openMascota, popMascota, syncDepthAfterPop } from "./inspector-nav";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

type Fetch<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "notfound" }
  | { status: "error" };

export function InspectorMounter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const caso = searchParams.get("caso");
  const mascota = searchParams.get("mascota");
  // C6c workqueue grammar: ActuarButton selects a case with `&panel=acciones`
  // so the inspector opens straight on the Acciones tab (see
  // WelfareInspectorContent's initialTab prop).
  const panel = searchParams.get("panel");

  const { signalFor } = useKeyedAbort();
  const [detail, setDetail] = useState<Fetch<WelfareInspectorDetail>>({ status: "idle" });
  const [pet, setPet] = useState<Fetch<GobPetSubView>>({ status: "idle" });

  // Keep the depth counter honest across browser-driven Back/Forward.
  useEffect(() => {
    function onPop() {
      syncDepthAfterPop(new URLSearchParams(window.location.search).has("caso"));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Fetch the case detail whenever `?caso=` changes.
  useEffect(() => {
    if (!caso) {
      setDetail({ status: "idle" });
      return;
    }
    let cancelled = false;
    setDetail({ status: "loading" });
    fetch(`/api/gob/maltrato/${encodeURIComponent(caso)}`, {
      headers: { accept: "application/json" },
      signal: signalFor("caso"),
    })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setDetail({ status: "notfound" });
          return;
        }
        if (!r.ok) {
          setDetail({ status: "error" });
          return;
        }
        const data = (await r.json()) as WelfareInspectorDetail;
        if (!cancelled) setDetail({ status: "ready", data });
      })
      .catch((err) => {
        if (isAbortError(err) || cancelled) return;
        setDetail({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [caso, signalFor]);

  // Fetch the pet sub-view whenever `&mascota=` changes.
  useEffect(() => {
    if (!mascota) {
      setPet({ status: "idle" });
      return;
    }
    let cancelled = false;
    setPet({ status: "loading" });
    fetch(`/api/gob/mascotas/${encodeURIComponent(mascota)}`, {
      headers: { accept: "application/json" },
      signal: signalFor("mascota"),
    })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setPet({ status: "notfound" });
          return;
        }
        if (!r.ok) {
          setPet({ status: "error" });
          return;
        }
        const data = (await r.json()) as GobPetSubView;
        if (!cancelled) setPet({ status: "ready", data });
      })
      .catch((err) => {
        if (isAbortError(err) || cancelled) return;
        setPet({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [mascota, signalFor]);

  // URL with caso + mascota + panel stripped — the state a full close returns to.
  const cleanListUrl = useCallback((): string => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("caso");
    params.delete("mascota");
    params.delete("panel");
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }, [pathname, searchParams]);

  const restoreRowFocus = useCallback((rowId: string | null) => {
    if (!rowId) return;
    // The list node was never unmounted (shallow routing) — the row anchor is
    // still in the DOM. Restore focus after the close settles.
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-caso-row="${rowId}"]`);
      el?.focus();
    }, 0);
  }, []);

  const handleClose = useCallback(() => {
    const rowId = caso;
    closeInspector(cleanListUrl());
    restoreRowFocus(rowId);
  }, [caso, cleanListUrl, restoreRowFocus]);

  const handleOpenMascota = useCallback(
    (token: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("mascota", token);
      openMascota(`${pathname}?${params.toString()}`);
    },
    [pathname, searchParams],
  );

  // Empty state — desktop right column only (mobile shows nothing until a row
  // is tapped).
  if (!caso) {
    return (
      <div className="hidden h-full min-h-0 items-center justify-center p-6 text-center text-sm text-ln-op-mute lg:flex">
        Elegí una denuncia para ver su detalle y acciones.
      </div>
    );
  }

  const showingPet = Boolean(mascota);

  let body: React.ReactNode;
  let title: React.ReactNode = "Denuncia";
  if (showingPet) {
    title = pet.status === "ready" ? pet.data.name || "Mascota" : "Mascota";
    body = <PetBody state={pet} />;
  } else {
    title =
      detail.status === "ready"
        ? `Denuncia ${detail.data.referenceCode}`
        : detail.status === "notfound"
          ? "No encontrada"
          : "Denuncia";
    body = (
      <CaseBody
        state={detail}
        onOpenMascota={handleOpenMascota}
        initialTab={panel === "acciones" ? "acciones" : undefined}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex bg-black/30 lg:static lg:inset-auto lg:z-auto lg:block lg:h-full lg:bg-transparent">
      {/* Mobile dim area (non-interactive) — the ✕ button and Esc close the
          overlay; on lg there is no dim and the list stays live. */}
      <div aria-hidden="true" className="flex-1 lg:hidden" />
      <div className="ml-auto flex h-full w-full max-w-md flex-col lg:ml-0 lg:max-w-none">
        <InspectorPanel
          title={title}
          fullPageHref={showingPet ? undefined : `/gob/maltrato/${caso}`}
          onClose={handleClose}
          onBack={showingPet ? () => popMascota() : undefined}
        >
          {body}
        </InspectorPanel>
      </div>
    </div>
  );
}

function CaseBody({
  state,
  onOpenMascota,
  initialTab,
}: {
  state: Fetch<WelfareInspectorDetail>;
  onOpenMascota: (token: string) => void;
  /** C6c workqueue grammar — forces the inspector open on "Acciones" when the
   * selection came from ActuarButton. `key={state.data.id}` below remounts
   * WelfareInspectorContent per case so this always re-seeds instead of
   * inheriting whatever tab a PREVIOUS case selection landed on. */
  initialTab?: "resumen" | "timeline" | "acciones" | "export";
}) {
  if (state.status === "loading" || state.status === "idle") return <Loading />;
  if (state.status === "notfound") {
    return <Notice text="No encontramos esta denuncia, o está fuera de tu jurisdicción." />;
  }
  if (state.status === "error") {
    return <Notice text="No pudimos cargar la denuncia. Reintentá en unos segundos." />;
  }
  return (
    <WelfareInspectorContent
      key={state.data.id}
      detail={state.data}
      onOpenMascota={onOpenMascota}
      initialTab={initialTab}
    />
  );
}

function PetBody({ state }: { state: Fetch<GobPetSubView> }) {
  if (state.status === "loading" || state.status === "idle") return <Loading />;
  if (state.status === "notfound") {
    return (
      <Notice text="No encontramos esta mascota, o no está vinculada a un caso en tu jurisdicción." />
    );
  }
  if (state.status === "error") {
    return <Notice text="No pudimos cargar la mascota. Reintentá en unos segundos." />;
  }
  return <PetSubView pet={state.data} />;
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="h-6 w-1/2 animate-pulse rounded bg-ln-op-stripe" />
      <div className="h-24 w-full animate-pulse rounded bg-ln-op-stripe" />
      <div className="h-24 w-full animate-pulse rounded bg-ln-op-stripe" />
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-ln-op-mute">{text}</p>;
}
