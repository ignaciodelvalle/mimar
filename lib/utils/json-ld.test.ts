import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "./json-ld";

const U2028 = String.fromCharCode(0x2028);
const U2029 = String.fromCharCode(0x2029);

describe("serializeJsonLd", () => {
  it("neutralises a </script> breakout in user free-text", () => {
    const out = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c/script\\u003e");
  });

  it("escapes < > & and the U+2028/U+2029 line separators", () => {
    const out = serializeJsonLd({ a: "<", b: ">", c: "&", d: U2028, e: U2029 });
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u003e");
    expect(out).toContain("\\u0026");
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
  });

  it("round-trips to the original object", () => {
    const obj = { "@context": "https://schema.org", name: "Firulais & <friends>" };
    expect(JSON.parse(serializeJsonLd(obj))).toEqual(obj);
  });
});
