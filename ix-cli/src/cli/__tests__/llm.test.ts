import { describe, it, expect } from "vitest";
import { llmQuote, llmField, llmLine, llmError } from "../llm.js";

describe("llmQuote", () => {
  it("leaves bare values untouched", () => {
    expect(llmQuote("auth.py")).toBe("auth.py");
    expect(llmQuote("god_module")).toBe("god_module");
    expect(llmQuote("0.62")).toBe("0.62");
    expect(llmQuote("a,b,c")).toBe("a,b,c");
  });

  it("quotes values containing spaces", () => {
    expect(llmQuote("Cli / Client")).toBe('"Cli / Client"');
  });

  it("quotes values containing = or \"", () => {
    expect(llmQuote("a=b")).toBe('"a=b"');
    expect(llmQuote('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("escapes backslashes", () => {
    expect(llmQuote("a\\b")).toBe('"a\\\\b"');
  });

  it("encodes newlines/tabs so the record stays on one line", () => {
    expect(llmQuote("line1\nline2")).toBe('"line1\\nline2"');
    expect(llmQuote("a\tb")).toBe('"a\\tb"');
    expect(llmQuote("line1\nline2")).not.toContain("\n");
  });

  it("renders the empty string as explicit empty quotes", () => {
    expect(llmQuote("")).toBe('""');
  });
});

describe("llmField", () => {
  it("drops null/undefined/empty", () => {
    expect(llmField("k", null)).toBeNull();
    expect(llmField("k", undefined)).toBeNull();
    expect(llmField("k", "")).toBeNull();
  });

  it("renders numbers and booleans", () => {
    expect(llmField("files", 87)).toBe("files=87");
    expect(llmField("cross", true)).toBe("cross=true");
    expect(llmField("n", 0)).toBe("n=0");
  });

  it("quotes string values that need it", () => {
    expect(llmField("label", "Cli / Client")).toBe('label="Cli / Client"');
  });
});

describe("llmLine", () => {
  it("emits a record-kind token then key=value pairs", () => {
    const line = llmLine("region", [
      ["id", "cli-client"],
      ["label", "Cli / Client"],
      ["level", 2],
      ["files", 87],
    ]);
    expect(line).toBe('region id=cli-client label="Cli / Client" level=2 files=87');
  });

  it("skips omitted fields", () => {
    const line = llmLine("region", [
      ["id", "root"],
      ["parent", null],
      ["files", 0],
    ]);
    expect(line).toBe("region id=root files=0");
  });

  it("accepts a plain object and supports no record kind", () => {
    expect(llmLine(null, { a: 1, b: "x" })).toBe("a=1 b=x");
  });
});

describe("llmError", () => {
  it("renders a uniform error record", () => {
    const line = llmError("unknown_target", "No entity named 'Foo' found", [
      ["suggestions", "Bar,Baz"],
    ]);
    expect(line).toBe(
      'error code=unknown_target message="No entity named \'Foo\' found" suggestions=Bar,Baz'
    );
  });
});
