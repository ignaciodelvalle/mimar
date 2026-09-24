// @vitest-environment jsdom
// The timeline is two steps: configure, then play.
//
// PO ask 2026-08-01. Every other dock pane is read INSTEAD of the map — you
// look down at a table, a ranking, a legend. The timeline is the only one you
// drive WHILE watching the map: you press play to see the country change. The
// dock gave it the same 42% as the rest, so it covered the very thing it exists
// to animate, and the taller the viewport the more it hid.
//
// Step one is configuration — which dates exist, which loop window, which
// temporal basis. Step two is playback, and there the only questions are how
// far along it is and how much is happening. So the config controls fold away
// on play and the dock shrinks to the moving line.
//
// WHAT THESE TESTS GUARD is the fold, not the pixel height. A height assertion
// would pin a number that design will move; these pin the RELATIONSHIP — the
// controls that are configuration disappear exactly when playback starts, and
// the progress readout never does.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TimeScrubber } from "@/components/panorama/TimeScrubber";

function renderScrubber(extra?: { onPlayingChange?: (p: boolean) => void }) {
  return render(
    <TimeScrubber
      since={new Date("2026-05-01T00:00:00Z")}
      until={new Date("2026-08-01T00:00:00Z")}
      onChange={() => {}}
      basis="valid"
      onBasisChange={() => {}}
      scrubDetail={true}
      {...extra}
    />,
  );
}

function playButton() {
  return screen.getByRole("button", { name: /reproduc/i });
}

describe("TimeScrubber — configure, then play", () => {
  it("offers the temporal-basis choice while paused", () => {
    renderScrubber();
    // The basis selector is the clearest configuration-only control: choosing
    // between "cuándo pasó" and "cuándo lo supo el Estado" is a decision you
    // make before the thumb moves, not while watching it.
    expect(screen.queryByText(/base temporal/i)).not.toBeNull();
  });

  it("folds the configuration away once playback starts", () => {
    renderScrubber();
    expect(screen.queryByText(/base temporal/i)).not.toBeNull();
    fireEvent.click(playButton());
    expect(screen.queryByText(/base temporal/i)).toBeNull();
  });

  it("keeps the loop chips through the fold", () => {
    // Found the hard way: the first cut folded these away as configuration, and
    // the existing loop tests caught it. Clicking a chip STARTS playback, so
    // while the loop runs they are the only thing saying which window is
    // cycling and the only way to switch it. Folding them removes the control
    // at the moment it is in use.
    renderScrubber();
    fireEvent.click(playButton());
    expect(screen.queryByText(/ventana de reproducción/i)).not.toBeNull();
  });

  it("keeps the track itself through the fold", () => {
    // The point of shrinking is to show MORE map, not less line. If playback
    // ever hid the slider, the pane would collapse into a control with nothing
    // to control.
    renderScrubber();
    fireEvent.click(playButton());
    expect(screen.queryByRole("slider")).not.toBeNull();
  });

  it("reports the mode up so the dock can resize", () => {
    // The dock cannot read the scrubber's internal state, and lifting `playing`
    // out would scatter the play loop's invariants across two files for one
    // layout decision. The callback is the whole contract between them — if it
    // stops firing, the fold still happens and the dock silently keeps the
    // taller height, which looks like the fix half-working.
    const onPlayingChange = vi.fn();
    renderScrubber({ onPlayingChange });
    onPlayingChange.mockClear();
    fireEvent.click(playButton());
    expect(onPlayingChange).toHaveBeenCalledWith(true);
  });
});
