// The CHIP SCANNER SEAM — the camera, behind the same wall as the picker.
//
// Reading a chip's barcode off a vet's sticker needs `expo-camera`: a native
// module, therefore a changed fingerprint, therefore an EAS build and a store
// release (see `image-picker-port.ts` — same wall, same argument, same
// `lib/observability/sink.ts` shape). The adapter's source, the install
// command and the build order live in `docs/mobile/camera-modules-handback.md`.
//
// WHY THIS PORT CARRIES A COMPONENT AND NOT A FUNCTION
// ---------------------------------------------------------------------------
// The picker's port is `pickImage(): Promise<...>` because picking IS a call:
// the OS draws its own UI and returns. A camera scan is not — `expo-camera`'s
// `CameraView` is a React component the SCREEN must render, with a preview the
// person aims. A `scan(): Promise<string>` here would force every adapter to
// secretly mount UI from inside a promise, which is how a seam stops matching
// the thing behind it. So the port hands the screen a component (or `null`,
// which is the honest default), and the screen decides where it draws.
//
// WHAT AN ADAPTER'S `ScanView` MUST PROMISE
//   · It calls `onCode(raw)` with the barcode's RAW string, unparsed. What a
//     scanned string means — and whether it is a 15-digit chip at all — is the
//     claim view-model's decision (`chipCodeFromScan`), so the keyboard and the
//     camera feed one validation path instead of two.
//   · It calls `onCancel()` when the person backs out, and stops the camera in
//     both exits. It never navigates.
//   · It asks for the camera PERMISSION itself and renders its own denial state
//     — permissions are a property of the native module, which is exactly what
//     lives behind this seam.
//
// `ScanView: null` — not a stub component that renders an apology — is the
// module-missing signal, so a screen cannot mount a scanner that is not there:
// the honest state is unrepresentable as a working control.

import type { ComponentType } from "react";

/** The props an adapter's scan view receives. See the contract above. */
export type ChipScanViewProps = {
  onCode: (raw: string) => void;
  onCancel: () => void;
};

export type ChipScannerPort = {
  /** Stable identifier, e.g. "module-missing" or "expo-camera". */
  readonly name: string;
  /**
   * The camera view, or `null` when the native module is not in this build.
   * A screen offers a scan control ONLY when this is non-null.
   */
  readonly ScanView: ComponentType<ChipScanViewProps> | null;
};

/** The default: this build has no camera to offer, and says so with `null`. */
export const moduleMissingChipScanner: ChipScannerPort = {
  name: "module-missing",
  ScanView: null,
};

let activePort: ChipScannerPort = moduleMissingChipScanner;

/**
 * Installs the process-wide port — one call at app start, per the handback
 * doc. Returns the port it replaced so a test can restore it.
 */
export function setChipScannerPort(port: ChipScannerPort): ChipScannerPort {
  const previous = activePort;
  activePort = port;
  return previous;
}

/** The currently installed port. */
export function getChipScannerPort(): ChipScannerPort {
  return activePort;
}

/** Restores the honest default. Primarily for tests. */
export function resetChipScannerPort(): void {
  activePort = moduleMissingChipScanner;
}
