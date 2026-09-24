"use client";

import { useCallback, useRef } from "react";

/**
 * Keeps what somebody typed when React 19 throws their form away.
 *
 * THE PROBLEM, measured in `__tests__/react19-form-reset-contract.test.tsx`:
 * React resets a `<form action={…}>` as soon as its action settles, including
 * when it settles with a validation error. Controlled text inputs and textareas
 * survive because React keeps their DOM default in sync. NOTHING ELSE DOES —
 * not an uncontrolled field, not a controlled `<select>` (it falls back to its
 * first option), not a controlled checkbox or radio (it falls back to the value
 * it had at mount). A person who missed one required field can lose every other
 * answer on the page.
 *
 * WHY A SHARED HOOK AND NOT ANOTHER LOCAL FIX. This defect has been
 * rediscovered and re-fixed FIVE separate times in this repo, once per form, by
 * five people who each thought they had found a one-off: `LoginForm`,
 * `SignupForm`, `ResetRequestForm`, `WelfareReportForm`, `MinimalNewPetForm`.
 * An enumeration on 2026-09-16 found roughly a hundred and twenty forms in the
 * class and around forty-five that lose something real. A sixth local fix would
 * have been the sixth. The generic shape here is `WelfareReportForm`'s, lifted
 * out of it rather than invented.
 *
 * HOW IT WORKS. The form's own `FormData` is the record of what was sent, so
 * this captures it at submit time — before the action resolves and therefore
 * before the reset — and hands it back for `defaultValue` / `defaultChecked`.
 * No field list to maintain: a field added to the form is covered the moment
 * it is given a `name`.
 *
 * A REF, NOT STATE, and deliberately: `defaultValue` is only consulted when
 * React restores the field, which happens after this has already been written.
 * State would buy a render pass and change nothing.
 *
 * ONE ENTRY PER NAME IS NOT ENOUGH, and the first version of this got it wrong.
 * `FormData` is a MULTI-map: a checkbox GROUP — several boxes sharing one
 * `name`, each with its own `value` — sends one entry per ticked box. Collapsing
 * those into `Record<string, string>` keeps only the last, so a group with
 * "perros" and "gatos" both ticked came back reporting that only "gatos" had
 * been — the re-seed would have silently UNTICKED a box the person chose, which
 * is worse than losing the lot, because a wrong answer looks like an answer.
 * `ServiceOfferingForm`'s `eligibilitySpecies` is exactly that shape.
 *
 * A `<select>` NEEDS A CHANGING `key` AS WELL, and this is not a style choice.
 * The obvious spelling — `defaultValue={kept(name)}` and nothing else — was
 * what this hook's own instructions used to say, and it was measured in the
 * second half of the contract test to do NOTHING AT ALL, which is how it was
 * caught before a form shipped carrying it. `form.reset()` restores a select
 * from each option's `defaultSelected`, i.e. the `selected` ATTRIBUTE, and only
 * react-dom's MOUNT path writes it (`postMountWrapper` passes
 * `setDefaultSelected`; `updateSelect` does not). A `defaultValue` that changes
 * on an UPDATE therefore moves nothing, and the reset lands on the first
 * option. Giving the select a `key` derived from the kept value makes the
 * settle-render REMOUNT it, which puts the write back on the mount path:
 *
 *     <select name="x" key={`x-${kept("x")}`} defaultValue={kept("x")}>
 *
 * Putting `selected` on the option instead does not work either (measured), and
 * React warns about it.
 *
 * WHAT IT CANNOT DO. A `<input type="file">` is not in reach of any of this: the
 * browser refuses to let a page set one, and the `File` is gone after the reset.
 * A form with a file input has to hold the `File` in React state and re-attach
 * it to the `FormData` itself, the way `MinimalNewPetForm` does.
 */
export function useKeptFields<S>(action: (prev: S, formData: FormData) => S | Promise<S>): {
  /** Pass this to `useActionState` instead of the action itself. */
  boundAction: (prev: S, formData: FormData) => S | Promise<S>;
  /**
   * What this text field was submitted with.
   *
   * `fallback` (default `""`) is what to answer BEFORE the first submit —
   * same contract as `keptChecked`'s `fallback`, and for the same reason:
   * "never submitted" and "submitted empty" are NOT the same thing, and
   * conflating them was a real bug (fresh-context review, T4-F1 batches
   * 3-4). `kept(name)` alone used to return `""` in BOTH cases, so every
   * caller wrote `kept(name) || someDefault` to cover the pre-submit case —
   * which ALSO fires the moment a person deliberately CLEARS the field and
   * the action rejects for an unrelated reason, silently resurrecting
   * `someDefault` (e.g. a jurisdiction rule's old `notes`) over the blank
   * they just typed, and it would then get SAVED on their next, successful
   * submit. `kept(name, fallback)` returns `fallback` only when nothing has
   * been submitted yet; once a submit has happened, it returns exactly what
   * was sent for `name` — `""` included — never the fallback. Migrating a
   * `kept(name) || x` call site is a straight rewrite to `kept(name, x)`;
   * do NOT keep the `||` (it reintroduces the exact bug this fixes) and
   * build `x` itself with `??`, not `||`, when it chains more than one
   * source (a falsy-but-valid default, e.g. `0`, must survive).
   */
  kept: (name: string, fallback?: string) => string;
  /**
   * Whether this checkbox or radio was submitted ticked.
   *
   * `fallback` is what to answer BEFORE the first submit, which is the caller's
   * business and cannot be guessed: an unticked box and a box that was never
   * offered look identical in `FormData`, because the browser omits both.
   * Pass a radio's own `value` to ask "was this the option chosen".
   */
  keptChecked: (name: string, fallback: boolean, value?: string) => boolean;
} {
  const submittedRef = useRef<Record<string, string[]> | null>(null);
  const actionRef = useRef(action);
  actionRef.current = action;

  const boundAction = useCallback((prev: S, formData: FormData): S | Promise<S> => {
    const captured: Record<string, string[]> = {};
    for (const [key, value] of formData.entries()) {
      // Files are skipped rather than stringified: a `File` coerced to text is
      // "[object File]", which would seed a field with nonsense that looks like
      // a kept value.
      if (typeof value !== "string") continue;
      const bucket = captured[key];
      if (bucket === undefined) captured[key] = [value];
      else bucket.push(value);
    }
    submittedRef.current = captured;
    return actionRef.current(prev, formData);
  }, []);

  // The LAST entry, not the first, so a single-valued field behaves exactly as
  // it did before this became a multi-map. A text field only ever has one.
  //
  // MIRRORS `keptChecked`'s two-question structure on purpose: "has anything
  // been submitted at all" is answered FIRST and separately from "what did
  // THIS field carry in that submission" — collapsing them into one `?? ""`
  // chain is exactly what made `kept(name) || fallback` necessary (and buggy)
  // at every call site before this.
  const kept = useCallback((name: string, fallback = ""): string => {
    const submitted = submittedRef.current;
    if (submitted === null) return fallback;
    const sent = submitted[name];
    if (sent === undefined) return "";
    return sent[sent.length - 1] ?? "";
  }, []);

  const keptChecked = useCallback((name: string, fallback: boolean, value?: string): boolean => {
    const submitted = submittedRef.current;
    if (submitted === null) return fallback;
    const sent = submitted[name];
    if (sent === undefined) return false;
    return value === undefined ? true : sent.includes(value);
  }, []);

  return { boundAction, kept, keptChecked };
}
