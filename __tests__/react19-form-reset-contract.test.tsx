// @vitest-environment jsdom
//
// WHAT REACT 19 KEEPS, AND WHAT IT THROWS AWAY, WHEN A FORM ACTION ANSWERS.
//
// React 19 resets a `<form action={…}>` once its action settles — INCLUDING when
// it settles with a validation error. What survives that reset is not obvious,
// is not documented in a way anybody found, and decides how ~45 forms in this
// repo have to be written. This file measures it instead of assuming it.
//
// WHY IT EXISTS AS A FENCE AND NOT AS A NOTE. Three things converge:
//
//   1. It was rediscovered FIVE SEPARATE TIMES. `LoginForm`, `SignupForm`,
//      `ResetRequestForm`, `WelfareReportForm` and `MinimalNewPetForm` each
//      carry a comment naming this reset, each written by somebody who had just
//      been bitten by it, each fixing one form. Nobody counted the sixth, and
//      an enumeration on 2026-09-16 found roughly a hundred and twenty forms in
//      the class. A lesson this repo paid for five times belongs in a test.
//
//   2. THE INTUITIVE MODEL IS WRONG in two places, and both were believed here.
//      "Controlled survives, uncontrolled is wiped" holds for text inputs and
//      textareas and fails for `<select>` and for checkbox/radio. React keeps a
//      DOM element's *default* in sync only for the former; `updateOptions`
//      never touches `option.defaultSelected`, and `updateInput` skips
//      `defaultChecked` whenever `checked` is non-null. So a controlled select
//      falls back to its FIRST OPTION (usually the placeholder) and a controlled
//      tick falls back to its MOUNT value. Both were derived from react-dom's
//      source and then measured here, because a fix sized on the wrong model is
//      the difference between eighteen forms and forty-five.
//
//   3. It is a FRAMEWORK behaviour, so it can change under us on an upgrade.
//      A React bump that started preserving selects would make a pile of
//      defensive code pointless; one that stopped preserving controlled inputs
//      would be a silent, repo-wide data-loss regression. Either way we want to
//      hear it from a test rather than from a person losing a form.
//
// THE REMEDY THIS IMPLIES, recorded so the next reader does not re-derive it:
// a field is safe when its value is bound to React state AND is a text-ish
// input or textarea. Everything else needs the value echoed back by the action
// and re-seeded (the `defaultValue={state.x}` pattern), or the generic
// `submittedRef` + `kept(name)` capture that `WelfareReportForm` already uses.
// A `<input type="file">` cannot be saved at all and has to be re-attached from
// React state, as `MinimalNewPetForm` does.
//
// THE SECOND HALF OF THIS FILE MEASURES THE REMEDY, not just the defect, and
// that is not decoration. `lib/ui/use-kept-fields.ts` only works if React writes
// the `defaultValue` / `defaultChecked` computed from the captured `FormData`
// into the DOM BEFORE it resets the form. That ordering is React's, not ours —
// exactly the kind of thing the first half of this file exists to stop us from
// assuming. Forty-odd forms now depend on it.
//
// NOT COVERED HERE, deliberately: the OTHER failure path, where a REJECTED
// action is re-thrown during render and unmounts the whole form into an error
// boundary. That one is about error handling, not about the reset, and it has
// its own remedy (`lib/ui/use-retryable-action.ts`).

import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CorrectSpeciesForm } from "@/app/(app)/mis-mascotas/[publicToken]/corregir-especie/CorrectSpeciesForm";
import { useActionState, useState } from "react";
import { describe, expect, it, vi } from "vitest";

type State = { settled: boolean };

/**
 * One form carrying one of each control, submitted once, with an action that
 * answers with an error the way a validation failure does.
 */
function FormUnderTest() {
  // MOUNTS UNTICKED and gets flipped before the submit, so its current value
  // and its mount value differ. Without that difference the checkbox assertion
  // below cannot fail, and a test that cannot fail measures nothing.
  const [ticked, setTicked] = useState(false);
  const [state, formAction] = useActionState(async (): Promise<State> => ({ settled: true }), {
    settled: false,
  });

  return (
    <form action={formAction}>
      <input aria-label="uncontrolled-text" name="a" defaultValue="" />
      <input aria-label="controlled-text" name="b" value="typed" onChange={() => {}} />
      <textarea aria-label="controlled-textarea" name="c" value="written" onChange={() => {}} />
      <select aria-label="controlled-select" name="d" value="two" onChange={() => {}}>
        <option value="">Elegí</option>
        <option value="one">Uno</option>
        <option value="two">Dos</option>
      </select>
      <input
        aria-label="controlled-checkbox"
        name="e"
        type="checkbox"
        checked={ticked}
        onChange={(event) => setTicked(event.target.checked)}
      />
      <input aria-label="uncontrolled-radio" name="f" type="radio" value="x" />
      <button type="submit">Enviar</button>
      <output>{state.settled ? "settled" : "pending"}</output>
    </form>
  );
}

describe("React 19 resets a form action's form, and this is what that costs", () => {
  it("keeps controlled text and textareas, and discards everything else", async () => {
    const { container } = render(<FormUnderTest />);

    const uncontrolledText = screen.getByLabelText("uncontrolled-text") as HTMLInputElement;
    const uncontrolledRadio = screen.getByLabelText("uncontrolled-radio") as HTMLInputElement;
    uncontrolledText.value = "lo que la persona tipeó";
    uncontrolledRadio.checked = true;
    fireEvent.click(screen.getByLabelText("controlled-checkbox"));

    // Everything is where the person left it, before the submit.
    expect((screen.getByLabelText("controlled-checkbox") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("controlled-select") as HTMLSelectElement).value).toBe("two");

    (container.querySelector("form") as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(screen.getByText("settled")).toBeTruthy());

    // SURVIVES: React re-applies the DOM default for these on every update, so
    // `form.reset()` restores them to the value they already had.
    expect((screen.getByLabelText("controlled-text") as HTMLInputElement).value).toBe("typed");
    expect((screen.getByLabelText("controlled-textarea") as HTMLTextAreaElement).value).toBe(
      "written",
    );

    // LOST: nothing to restore from.
    expect(uncontrolledText.value).toBe("");
    expect(uncontrolledRadio.checked).toBe(false);

    // LOST, AND THIS IS THE COUNTER-INTUITIVE PAIR. Both of these are bound to
    // React state and both are thrown away regardless: the select falls back to
    // its first option, and the tick falls back to the value it had at mount.
    expect((screen.getByLabelText("controlled-select") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("controlled-checkbox") as HTMLInputElement).checked).toBe(false);
  });
});

/**
 * The same form, written the way `useKeptFields` asks for it: every control
 * DOM-owned, every default read back from the `FormData` the form itself sent.
 *
 * TWO OF THESE ARE NOT THE OBVIOUS SPELLING, and both were measured after the
 * obvious spelling failed here.
 *
 * THE SELECT CARRIES A `key`. `defaultValue` alone does NOT survive: a reset
 * restores a select from each option's `defaultSelected` — the `selected`
 * ATTRIBUTE — and react-dom writes that only on MOUNT (`postMountWrapper` asks
 * `updateOptions` to set it; `updateSelect` never does). A `defaultValue` that
 * changes on an UPDATE therefore moves nothing at all. Keying the select on the
 * kept value remounts it during the settle render, which puts the write back on
 * the mount path. Setting `selected` on the option instead was measured too: it
 * also fails, and React warns about it.
 *
 * THE SPECIES PAIR SHARES ONE `name`, which makes `FormData` a multi-map, and
 * the hook's first version collapsed it into one entry per name — so with both
 * boxes ticked it reported only the LAST as ticked and the re-seed silently
 * unticked the other. A wrong answer looks like an answer; an empty one at
 * least looks empty. Both boxes stay ticked below for that reason: it is the
 * assertion the old shape failed.
 */
function KeptFormUnderTest() {
  const { boundAction, kept, keptChecked } = useKeptFields(
    async (): Promise<State> => ({ settled: true }),
  );
  const [state, formAction] = useActionState(boundAction, { settled: false });

  return (
    <form action={formAction}>
      {/* `kept("a", "valor por defecto")` — the fallback argument, same
          contract as keptChecked's: it answers ONLY "nothing submitted yet",
          never "submitted, and this field was blank". A settle-render that
          re-seeds a genuinely cleared field from the fallback is the bug this
          argument exists to rule out (fresh-context review, T4-F1 batches
          3-4) — see the "keeps a deliberately cleared field cleared" test
          below. */}
      <input aria-label="kept-text" name="a" defaultValue={kept("a", "valor por defecto")} />
      <textarea aria-label="kept-textarea" name="b" defaultValue={kept("b")} />
      <select key={`c-${kept("c")}`} aria-label="kept-select" name="c" defaultValue={kept("c")}>
        <option value="">Elegí</option>
        <option value="one">Uno</option>
        <option value="two">Dos</option>
      </select>
      <input
        aria-label="kept-checkbox"
        name="d"
        type="checkbox"
        defaultChecked={keptChecked("d", false)}
      />
      <input
        aria-label="kept-radio-x"
        name="e"
        type="radio"
        value="x"
        defaultChecked={keptChecked("e", false, "x")}
      />
      <input
        aria-label="kept-radio-y"
        name="e"
        type="radio"
        value="y"
        defaultChecked={keptChecked("e", false, "y")}
      />
      <input
        aria-label="kept-group-dog"
        name="f"
        type="checkbox"
        value="dog"
        defaultChecked={keptChecked("f", true, "dog")}
      />
      <input
        aria-label="kept-group-cat"
        name="f"
        type="checkbox"
        value="cat"
        defaultChecked={keptChecked("f", true, "cat")}
      />
      <button type="submit">Enviar</button>
      <output>{state.settled ? "settled" : "pending"}</output>
    </form>
  );
}

describe("useKeptFields survives the same reset", () => {
  it("puts every control back where the person left it", async () => {
    const { container } = render(<KeptFormUnderTest />);

    const text = screen.getByLabelText("kept-text") as HTMLInputElement;
    const textarea = screen.getByLabelText("kept-textarea") as HTMLTextAreaElement;
    const select = screen.getByLabelText("kept-select") as HTMLSelectElement;
    const tick = screen.getByLabelText("kept-checkbox") as HTMLInputElement;
    const radioY = screen.getByLabelText("kept-radio-y") as HTMLInputElement;
    const dog = screen.getByLabelText("kept-group-dog") as HTMLInputElement;
    const cat = screen.getByLabelText("kept-group-cat") as HTMLInputElement;

    fireEvent.change(text, { target: { value: "lo que la persona tipeó" } });
    fireEvent.change(textarea, { target: { value: "y lo que escribió" } });
    fireEvent.change(select, { target: { value: "two" } });
    fireEvent.click(tick);
    fireEvent.click(radioY);
    // The species pair ships ticked and stays ticked — see the note above.
    expect(dog.checked).toBe(true);
    expect(cat.checked).toBe(true);

    (container.querySelector("form") as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(screen.getByText("settled")).toBeTruthy());

    expect(text.value).toBe("lo que la persona tipeó");
    expect(textarea.value).toBe("y lo que escribió");
    // Re-queried on purpose: the `key` change REMOUNTS the select, so the node
    // captured before the submit is a detached one. That remount is the fix.
    expect((screen.getByLabelText("kept-select") as HTMLSelectElement).value).toBe("two");
    expect(tick.checked).toBe(true);
    expect(radioY.checked).toBe(true);
    expect((screen.getByLabelText("kept-radio-x") as HTMLInputElement).checked).toBe(false);
    expect(dog.checked).toBe(true);
    expect(cat.checked).toBe(true);
  });

  it("answers the pre-submit question with the caller's fallback, not with false or blank", () => {
    render(<KeptFormUnderTest />);

    // Nothing has been submitted, so `FormData` has said nothing about these.
    // An unticked box and a box that was never offered are indistinguishable
    // there, which is why the fallback is the caller's to declare: the species
    // pair ships ticked, the lone checkbox ships unticked, and neither may be
    // guessed from an empty record. Same contract for `kept`'s text fallback.
    expect((screen.getByLabelText("kept-group-dog") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("kept-checkbox") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("kept-text") as HTMLInputElement).value).toBe(
      "valor por defecto",
    );
  });

  it("keeps a deliberately cleared field cleared, instead of resurrecting the fallback — the bug `kept(name) || fallback` had at every call site", async () => {
    const { container } = render(<KeptFormUnderTest />);

    const text = screen.getByLabelText("kept-text") as HTMLInputElement;
    // Ships with the fallback showing (nothing submitted yet) — clear it, the
    // way a person deleting what they'd typed would, then submit. The action
    // "rejects" (settled: true here just means the round trip completed; the
    // point under test is what `defaultValue` reads on the settle re-render,
    // which is the same mechanism a validation error re-render uses).
    fireEvent.change(text, { target: { value: "" } });
    expect(text.value).toBe("");

    (container.querySelector("form") as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(screen.getByText("settled")).toBeTruthy());

    // MUST stay blank. `kept("a", "valor por defecto")` returning the
    // fallback here — because a naive implementation cannot tell "never
    // submitted" from "submitted, and this field was blank" — would silently
    // put back a value the person deliberately deleted, which then gets
    // SAVED on their next, successful submit.
    expect((screen.getByLabelText("kept-text") as HTMLInputElement).value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The contract, enforced on the real form it damages most
// ---------------------------------------------------------------------------

describe("the reset landing on a WRONG value, not a blank", () => {
  // THE CATEGORY THIS BLOCK EXISTS FOR, and it is the one the 2026-09-17 sweep
  // of 74 forms put at the top: "loses what you typed" is the mild version.
  // The severe version is a `defaultValue` that is a DIFFERENT, PLAUSIBLE
  // ANSWER — because an empty field announces itself and a wrong one does not.
  //
  // `CorrectSpeciesForm` is the clearest instance in the repo: its whole
  // purpose is fixing a species entered wrong, and its select defaulted to
  // `currentSpecies` — the very value being corrected. A rejected submit put
  // the mistake back. The species feeds the PPP / dangerous-breed rules.
  it("CorrectSpeciesForm keeps the corrected species instead of restoring the wrong one", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo corregir la especie." }));
    const { container } = render(
      <CorrectSpeciesForm action={action} currentSpecies="dog" petName="Pampa" />,
    );

    const form = container.querySelector("form") as HTMLFormElement;
    const species = form.querySelector('select[name="species"]') as HTMLSelectElement;
    expect(species.value).toBe("dog");

    fireEvent.change(species, { target: { value: "cat" } });
    expect(species.value).toBe("cat");

    // A real submit: React 19's form-action path does not run on a dispatched
    // event, and without it the reset under test never happens.
    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText(/No se pudo corregir la especie/i);

    // Re-queried, because the `key` change REMOUNTS the select — the node above
    // is detached, and that remount is what puts the write back on react-dom's
    // mount path, which is the only path that sets `defaultSelected`.
    const after = (form.querySelector('select[name="species"]') as HTMLSelectElement).value;
    expect(after, "the reset must not restore the species the person is correcting").toBe("cat");
  });
});
