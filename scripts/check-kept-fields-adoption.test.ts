// Unit test for the useKeptFields adoption ratchet's checker.
//
// Each "broken" fixture below is the ACTUAL shape a form in this repo carried
// before its fix (see the git history of PregnancyEndedForm, WelfareReportForm,
// CrearConsultorioForm, LegalMetadataFieldset) — this is the mutation proof:
// the checker must flag the broken shape and clear the fixed one.

import { describe, expect, it } from "vitest";

import { ALLOWLISTED_BASELINE, findKeptFieldsViolations } from "./check-kept-fields-adoption";

// The ratchet LOGIC (count files matching ALLOWLIST_MARKER, compare to this
// ceiling, fail on growth) lives in `runScan()`, which walks the real
// filesystem and is exercised by `pnpm lint:kept-fields` itself — same
// scope as the BASELINE ratchet above it, which also has no direct unit
// test for its own counting loop. What IS worth pinning here is the
// constant's shape, so a stray edit (a negative number, a non-integer) fails
// loudly instead of quietly changing what "deliberate bump" means.
describe("ALLOWLISTED_BASELINE", () => {
  it("is a non-negative integer — the ratchet ceiling for how many files may carry a kept-fields-allowlist marker", () => {
    expect(Number.isInteger(ALLOWLISTED_BASELINE)).toBe(true);
    expect(ALLOWLISTED_BASELINE).toBeGreaterThanOrEqual(0);
  });
});

describe("findKeptFieldsViolations", () => {
  it("ignores files with no useActionState at all", () => {
    expect(findKeptFieldsViolations('<input name="x" />')).toEqual([]);
  });

  it("clears a file that already uses useKeptFields", () => {
    const src = `
      const { boundAction, kept } = useKeptFields(action);
      const [state, formAction] = useActionState(boundAction, initial);
      return <form action={formAction}><input name="x" defaultValue={kept("x")} /></form>;
    `;
    expect(findKeptFieldsViolations(src)).toEqual([]);
  });

  it("clears a file marked with the allowlist comment", () => {
    const src = `
      // kept-fields-allowlist: single confirm button, no typed fields to lose
      const [state, formAction] = useActionState(action, initial);
      return <form action={formAction}><input name="x" /></form>;
    `;
    expect(findKeptFieldsViolations(src)).toEqual([]);
  });

  it("clears a form whose only text field is genuinely controlled", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <input name="x" value={x} onChange={(e) => setX(e.target.value)} />
          <textarea name="y" value={y} onChange={(e) => setY(e.target.value)} />
        </form>
      );
    `;
    expect(findKeptFieldsViolations(src)).toEqual([]);
  });

  it("ignores hidden, file, and submit inputs — not data fields at risk", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <input type="hidden" name="token" value={token} />
          <input type="file" name="photo" />
          <input type="submit" name="go" />
        </form>
      );
    `;
    expect(findKeptFieldsViolations(src)).toEqual([]);
  });

  it("flags a bare uncontrolled field — PregnancyEndedForm's original vetConsulted", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <input id={id} name="vetConsulted" type="text" placeholder="Dr. Garcia" />
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/uncontrolled field/);
  });

  it("flags a <select> even when it carries a static defaultValue — WelfareReportForm's original kind select", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <select name="kind" defaultValue={kept("kind")}>
            <option value="a">A</option>
          </select>
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/<select>/);
  });

  it("clears a select fixed with defaultValue+key from plain React state, not kept() — LegalMetadataFieldset's requirement-tier select and NoteForm's category select do not round-trip through an action, so kept() is not available to them", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <LnSelect key={\`category-\${category}\`} name="category" defaultValue={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="a">A</option>
          </LnSelect>
        </form>
      );
    `;
    expect(findKeptFieldsViolations(src)).toEqual([]);
  });

  it("still flags a select with a STATIC (non-template-literal) key — the fence's ONLY signal for 'this key changes' is the template-literal spelling every hand-verified fix in this repo already uses (`` key={`x-${value}`} ``); a bare `key={value}` bypasses that syntactic check even where it happens to be a changing reference, same as `tagHasAttr(tag, \"key\")` alone (the original check) is satisfied by ANY key, including a per-item list key like AgendaRuleForm.tsx's original `key={d.value}` that never changes for a GIVEN item", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <LnSelect key={category} name="category" defaultValue={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="a">A</option>
          </LnSelect>
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/<select>/);
  });

  it("still flags a select using value= (genuinely controlled) even with a key present — measured to fall back to its first option regardless", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <LnSelect key={\`category-\${category}\`} name="category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="a">A</option>
          </LnSelect>
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/<select>/);
  });

  it("flags a controlled checkbox/radio (checked=) — the counter-intuitive pair", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <input type="radio" name="outcome" value="a" checked={outcome === "a"} onChange={onChange} />
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/controlled checkbox\/radio/);
  });

  it("does not flag an uncontrolled radio using defaultChecked (the fixed shape)", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <input type="radio" name="outcome" value="a" defaultChecked={keptChecked("outcome", true, "a")} onChange={onChange} />
        </form>
      );
    `;
    expect(findKeptFieldsViolations(src)).toEqual([]);
  });

  it('flags an uncontrolled radio with a STATIC defaultChecked — ShareLibretaSheet\'s original defaultChecked={opt.value === "7"}', () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <input type="radio" name="duration" value="7" defaultChecked={opt.value === "7"} />
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/uncontrolled checkbox\/radio/);
  });

  it("flags an uncontrolled checkbox with the bare JSX boolean defaultChecked shorthand — ExportFormClient's original csv radio", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <input type="radio" name="format" value="csv" defaultChecked />
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/uncontrolled checkbox\/radio/);
  });

  it("flags an uncontrolled checkbox with no defaultChecked at all — ExportFormClient's original json/slice inputs", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <input type="checkbox" name="slice" value="events" />
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/uncontrolled checkbox\/radio/);
  });

  it("still flags a keyed checkbox with a STATIC defaultChecked and no onChange — AgendaRuleForm's original defaultChecked={defaultDays?.includes(d.value) ?? d.value <= 5}, keyed only for React's list-key requirement, not live state", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          {WEEKDAYS.map((d) => (
            <LnCheckbox key={d.value} name="daysOfWeek" value={d.value} defaultChecked={defaultDays?.includes(d.value) ?? d.value <= 5}>
              {d.label}
            </LnCheckbox>
          ))}
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/uncontrolled checkbox\/radio/);
  });

  it("clears a checkbox/radio with defaultChecked+key+onChange from plain React state, not keptChecked() — FinalizeAdoptionForm's __appChoice radio and useFosterShortcut checkbox are parent-owned state that never round-trips through an action, mirroring the <select> defaultValue+key exception; unlike <select>, react-dom DOES rewrite an uncontrolled checkbox/radio's defaultChecked on every update, so onChange (proof the expression tracks a real click) plus key together signal deliberate live-state wiring rather than being load-bearing for the resync itself", () => {
    const src = `
      const [selectedAppId, setSelectedAppId] = useState("a");
      const [state, formAction] = useActionState(action, initial);
      return (
        <form action={formAction}>
          <input
            key={\`app-choice-\${app.id}-\${selectedAppId}\`}
            type="radio"
            name="__appChoice"
            defaultChecked={selectedAppId === app.id}
            onChange={() => setSelectedAppId(app.id)}
          />
        </form>
      );
    `;
    expect(findKeptFieldsViolations(src)).toEqual([]);
  });

  it("sees a file using useActionState<StateType, PayloadType>(...) with explicit generic type arguments — ShareLibretaSheet's original spelling, previously invisible to the file-level gate", () => {
    const src = `
      const [state, formAction] = useActionState<FormState, FormData>(boundSubmit, initial);
      return (
        <form action={formAction}>
          <input type="text" name="label" />
        </form>
      );
    `;
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/uncontrolled field/);
  });

  it("does not end the tag on a > inside an expression attribute", () => {
    const src = [
      "const [state, formAction] = useActionState(action, initial);",
      "return (",
      "  <form action={formAction}>",
      "    <input",
      '      name="x"',
      '      onChange={(e) => setValue(e.target.value > 0 ? e.target.value : "")}',
      "    />",
      "  </form>",
      ");",
    ].join("\n");
    // Multi-line tag with a `>` inside the expression, and no `value=` — still
    // correctly read as ONE tag and flagged as uncontrolled (onChange alone).
    const violations = findKeptFieldsViolations(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/uncontrolled field/);
  });

  it("ignores fields with no name attribute — nothing is submitted", () => {
    const src = `
      const [state, formAction] = useActionState(action, initial);
      return <form action={formAction}><input placeholder="search" /></form>;
    `;
    expect(findKeptFieldsViolations(src)).toEqual([]);
  });

  // T4-F1 batch 3: CrearConsultorioForm.tsx's local `Field` wrapper — the
  // fence used to see only Field's OWN internal <LnInput>, not any of its
  // call sites, so a bare `<Field name="x" />` (uncontrolled) went unseen.
  describe("local single-level text-field wrapper components", () => {
    it("flags an uncontrolled call site of a local wrapper — the mutant this fixture is built from", () => {
      const src = `
        function Field({ id, name, type, defaultValue }) {
          return <LnInput id={id} name={name} type={type} defaultValue={defaultValue} />;
        }
        const [state, formAction] = useActionState(action, initial);
        return (
          <form action={formAction}>
            <Field id="name" name="name" type="text" />
          </form>
        );
      `;
      const violations = findKeptFieldsViolations(src);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/uncontrolled field/);
    });

    it("clears a call site whose defaultValue is kept()-seeded through the wrapper — CrearConsultorioForm's real fixed shape", () => {
      const src = `
        function Field({ id, name, type, defaultValue }) {
          return <LnInput id={id} name={name} type={type} defaultValue={defaultValue} />;
        }
        const { boundAction, kept } = useKeptFields(action);
        const [state, formAction] = useActionState(boundAction, initial);
        return (
          <form action={formAction}>
            <Field id="name" name="name" type="text" defaultValue={kept("name") || defaultName} />
          </form>
        );
      `;
      expect(findKeptFieldsViolations(src)).toEqual([]);
    });

    it("does not mistake the wrapper's OWN internal tag for an unsafe call site", () => {
      // `<LnInput name={name} defaultValue={defaultValue} />` inside Field's
      // body forwards variables, not literal unsafe values — evaluating it
      // as if `name`/`defaultValue` were the actual submitted field would be
      // a false positive on every safe call site.
      const src = `
        function Field({ id, name, type, defaultValue }) {
          return <LnInput id={id} name={name} type={type} defaultValue={defaultValue} />;
        }
        const { boundAction, kept } = useKeptFields(action);
        const [state, formAction] = useActionState(boundAction, initial);
        return (
          <form action={formAction}>
            <Field id="name" name="name" type="text" defaultValue={kept("name")} />
          </form>
        );
      `;
      expect(findKeptFieldsViolations(src)).toEqual([]);
    });

    it("does not recognize a wrapper whose passthrough is transformed, not a bare identifier", () => {
      // `name={fieldName}` (not `name={name}`) means the bare-passthrough
      // check fails on purpose — the fence cannot confirm a renamed or
      // transformed prop still carries the call site's value unchanged, so
      // it must not silently trust it. Field's CALL SITE is therefore never
      // scanned (Field is not a recognized tag name), but the fence's
      // EXISTING, unchanged behavior for any other unrecognized-as-wrapper
      // component still applies: Field's own internal <LnInput> was already
      // a directly-scanned primitive before this feature existed, and stays
      // one — its own uncontrolled `defaultValue={value ?? ""}` is flagged,
      // exactly as if Field did not exist as an abstraction at all.
      const src = `
        function Field({ id, fieldName, type, value }) {
          return <LnInput id={id} name={fieldName} type={type} defaultValue={value ?? ""} />;
        }
        const [state, formAction] = useActionState(action, initial);
        return (
          <form action={formAction}>
            <Field id="name" fieldName="name" type="text" value="x" />
          </form>
        );
      `;
      const violations = findKeptFieldsViolations(src);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/uncontrolled field/);
    });

    // Fresh-context review, T4-F1 batches 3-4: `detectLocalTextWrappers` only
    // ever looks for a TEXT-ish inner tag (see its own docblock — it
    // deliberately does not detect select/checkbox/radio wrappers), so a
    // wrapper detected THAT way still routes its CALL SITES through the
    // generic "is this tagName in localTextWrappers" fallthrough regardless
    // of what attributes a particular call site actually carries. A call
    // site with `checked=` used to fall through to the TEXT rule below,
    // whose `controlled` check (`value=` + `onChange=`) a checkbox's OWN
    // submitted `value=` satisfies just as well as a text field's current
    // value does — clearing a genuinely-unsafe CONTROLLED checkbox as if it
    // were a safe text field. Latent today (no wrapper in this repo has this
    // shape), closed before one does.
    it("does not let a checkbox-shaped call site of a text wrapper fall through to the text rule — a controlled checkbox stays flagged regardless of tagName", () => {
      const src = `
        function Field({ id, name, defaultValue }) {
          return <LnInput id={id} name={name} defaultValue={defaultValue} />;
        }
        const [state, formAction] = useActionState(action, initial);
        return (
          <form action={formAction}>
            <Field id="ticked" name="ticked" value="yes" checked={isTicked} onChange={onChange} />
          </form>
        );
      `;
      const violations = findKeptFieldsViolations(src);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/controlled checkbox\/radio/);
    });
  });

  describe("attrExpr brace-balancing", () => {
    it("finds kept() past a nested object literal's own closing brace in a defaultValue expression — the naive [^}]* regex this replaced truncated BEFORE ever reaching kept(), a false negative that would have flagged a genuinely safe field", () => {
      const src = `
        const { boundAction, kept } = useKeptFields(action);
        const [state, formAction] = useActionState(boundAction, initial);
        return (
          <form action={formAction}>
            <input name="x" defaultValue={{ a: 1 }.a ? kept("x") : ""} />
          </form>
        );
      `;
      expect(findKeptFieldsViolations(src)).toEqual([]);
    });

    it("finds keptChecked() past a nested object literal's own closing brace in a defaultChecked expression", () => {
      const src = `
        const { boundAction, keptChecked } = useKeptFields(action);
        const [state, formAction] = useActionState(boundAction, initial);
        return (
          <form action={formAction}>
            <input type="checkbox" name="x" defaultChecked={{ a: 1 }.a ? keptChecked("x", false) : false} />
          </form>
        );
      `;
      expect(findKeptFieldsViolations(src)).toEqual([]);
    });
  });
});
