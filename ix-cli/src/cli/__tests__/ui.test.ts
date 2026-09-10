// Copyright 2026 Ix Infrastructure INC

import { describe, it, expect } from "vitest";
import {
  renderBreadcrumb,
  renderKeyValue,
  renderSection,
  renderNote,
  renderWarning,
  renderSuccess,
  renderError,
  renderResolvedHeader,
  colorizeKind,
  colorizeEntity,
} from "../ui.js";

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n");
}

describe("renderBreadcrumb", () => {
  it("joins node names with separator", () => {
    const result = renderBreadcrumb([{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }]);
    expect(stripAnsi(result)).toBe("Alpha → Beta → Gamma");
  });

  it("uses custom separator when provided", () => {
    const result = renderBreadcrumb([{ name: "A" }, { name: "B" }], " / ");
    expect(stripAnsi(result)).toContain("A");
    expect(stripAnsi(result)).toContain("B");
  });

  it("handles single node", () => {
    const result = renderBreadcrumb([{ name: "Solo" }]);
    expect(stripAnsi(result)).toBe("Solo");
  });
});

describe("renderKeyValue", () => {
  it("includes colon-suffixed label and value", () => {
    const output = captureLog(() => renderKeyValue("File", "/src/index.ts"));
    const stripped = stripAnsi(output);
    expect(stripped).toContain("File:");
    expect(stripped).toContain("/src/index.ts");
  });

  it("pads label to 18 characters", () => {
    const output = captureLog(() => renderKeyValue("A", "val"));
    const stripped = stripAnsi(output);
    // "A:" padded to 18 means 16 trailing spaces before value
    expect(stripped).toMatch(/A:\s+val/);
  });
});

describe("renderSection", () => {
  it("output starts with newline", () => {
    const output = captureLog(() => renderSection("Overview"));
    expect(output.startsWith("\n")).toBe(true);
  });

  it("contains the title", () => {
    const output = captureLog(() => renderSection("My Section"));
    expect(stripAnsi(output)).toContain("My Section");
  });
});

describe("renderNote", () => {
  it("contains Note and the text", () => {
    const output = captureLog(() => renderNote("check this"));
    const stripped = stripAnsi(output);
    expect(stripped).toContain("Note");
    expect(stripped).toContain("check this");
  });
});

describe("renderWarning", () => {
  it("contains Warning and the text", () => {
    const output = captureLog(() => renderWarning("something stale"));
    const stripped = stripAnsi(output);
    expect(stripped).toContain("Warning");
    expect(stripped).toContain("something stale");
  });
});

describe("renderSuccess", () => {
  it("contains the text", () => {
    const output = captureLog(() => renderSuccess("All good"));
    expect(stripAnsi(output)).toContain("All good");
  });
});

describe("renderError", () => {
  it("contains Error and the text", () => {
    const output = captureLog(() => renderError("something failed"));
    const stripped = stripAnsi(output);
    expect(stripped).toContain("Error");
    expect(stripped).toContain("something failed");
  });
});

describe("renderResolvedHeader", () => {
  it("contains Resolved:, the kind, and the name", () => {
    const output = captureLog(() => renderResolvedHeader("class", "IxClient"));
    const stripped = stripAnsi(output);
    expect(stripped).toContain("Resolved:");
    expect(stripped).toContain("class");
    expect(stripped).toContain("IxClient");
  });
});

describe("colorizeKind", () => {
  it("stripped result is the kind padded to 10 chars", () => {
    const result = colorizeKind("function");
    expect(stripAnsi(result)).toBe("function  ");
  });

  it("handles empty string", () => {
    const result = colorizeKind("");
    expect(stripAnsi(result)).toBe("          ");
  });
});

describe("colorizeEntity", () => {
  it("stripped result is the name", () => {
    const result = colorizeEntity("MyClass");
    expect(stripAnsi(result)).toBe("MyClass");
  });
});
