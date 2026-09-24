// `useReturnKeyChain` — what each position in the chain promises.
//
// Middle fields advance focus WITHOUT closing the keyboard; the last field
// says "done", blurs, and fires `onDone` only when the screen opted in.
// The refs must be stable across renders — a chain that re-created them
// would detach every TextInput mid-typing.

import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { Keyboard, type TextInput } from "react-native";

import { useReturnKeyChain } from "./use-return-key-chain";

type Chain = ReturnType<typeof useReturnKeyChain>;

let chain: Chain;

function Harness({ count, onDone }: { count: number; onDone?: () => void }) {
  chain = useReturnKeyChain(count, onDone);
  return null;
}

describe("the three props per position", () => {
  it("every field keeps submitBehavior `submit`; only the RETURN KEY distinguishes the last", () => {
    render(<Harness count={3} />);
    expect(chain(0).returnKeyType).toBe("next");
    expect(chain(1).returnKeyType).toBe("next");
    expect(chain(2).returnKeyType).toBe("done");
    for (const i of [0, 1, 2]) expect(chain(i).submitBehavior).toBe("submit");
  });

  it("NO field asks for `blurAndSubmit` — it is the value that crashes Android 9 and older", () => {
    // The assertion that would have caught this before a person did. The last
    // field used to ask for "blurAndSubmit" so the keyboard would close, and
    // that is the ONE value routing React Native into
    // `clearFocusAndMaybeRefocus`, whose `rootView as ViewGroup` cast throws
    // below API 29. Measured over adb from an Android 8.1 device on
    // 2026-09-11: the app died on the last field of every form.
    render(<Harness count={4} />);
    for (const i of [0, 1, 2, 3]) {
      expect(chain(i).submitBehavior).not.toBe("blurAndSubmit");
    }
  });

  it("the last field still closes the keyboard — we do it ourselves", () => {
    // The half of "blurAndSubmit" that was actually wanted, kept. If this ever
    // goes green by removing the dismiss rather than by keeping it, the person
    // is left staring at a keyboard over a form they already finished.
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
    render(<Harness count={2} />);
    chain(1).onSubmitEditing();
    expect(dismiss).toHaveBeenCalledTimes(1);
    dismiss.mockRestore();
  });

  it("a MIDDLE field does not close the keyboard", () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
    render(<Harness count={2} />);
    chain(1).inputRef.current = { focus: jest.fn() } as unknown as TextInput;
    chain(0).onSubmitEditing();
    expect(dismiss).not.toHaveBeenCalled();
    dismiss.mockRestore();
  });

  it("submit on a middle field focuses the NEXT field through its ref", () => {
    render(<Harness count={2} />);
    const focus = jest.fn();
    chain(1).inputRef.current = { focus } as unknown as TextInput;
    chain(0).onSubmitEditing();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("submit on the last field fires onDone when the screen opted in, and only then", () => {
    const onDone = jest.fn();
    render(<Harness count={2} onDone={onDone} />);
    chain(0).onSubmitEditing();
    expect(onDone).not.toHaveBeenCalled();
    chain(1).onSubmitEditing();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("without onDone, the last field's submit is a quiet blur — no crash", () => {
    render(<Harness count={1} />);
    expect(() => chain(0).onSubmitEditing()).not.toThrow();
  });
});

describe("ref stability", () => {
  it("hands back the SAME ref object across renders, so inputs stay attached", () => {
    const screen = render(<Harness count={2} />);
    const first = chain(0).inputRef;
    screen.rerender(<Harness count={2} />);
    expect(chain(0).inputRef).toBe(first);
  });
});
