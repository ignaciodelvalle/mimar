"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

// Panorama hardening (task #39) — an error boundary around the map ISLAND.
//
// The SituationalMap is a large imperative MapLibre client component. A render
// throw inside it (a malformed layer expression, a null-deref in a sync pass, a
// GL init failure) would otherwise bubble to the route-level boundary and take
// down the WHOLE panorama route ("Application error"). This boundary contains
// the blast radius to the map card: everything else on the console (KPI cluster,
// rail, scope pill) keeps working, and the map degrades to an honest es-AR
// "Recargar el panorama" card with a retry that remounts a fresh map — never a
// dead route, never a silent blank canvas.

type Props = {
  children: ReactNode;
  /**
   * Bumped on retry so the boundary's `key`-less children fully remount. The
   * parent owns a remount counter; the boundary calls this AND resets its own
   * error state so a transient throw recovers on the next paint.
   */
  onReset?: () => void;
};

type State = { error: Error | null };

export class MapErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the failure to the console/telemetry without crashing the route.
    console.error("[panorama] map island crashed:", error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div
          role="alert"
          className="flex h-full min-h-[440px] w-full flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card p-6 text-center"
        >
          <p className="text-md font-semibold text-ln-op-ink">No pudimos mostrar el mapa</p>
          <p className="max-w-sm text-sm text-ln-op-mute">
            Ocurrió un problema al dibujar el panorama. El resto del tablero sigue disponible.
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-[var(--radius-md)] border border-ln-op-azul bg-ln-op-azul/5 px-3.5 py-1.5 text-sm font-semibold text-ln-op-azul hover:bg-ln-op-azul/10"
          >
            Recargar el panorama
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
