// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { registerEdgeCommand } from "../edge-command.js";

export function registerContainsCommand(program: Command): void {
  registerEdgeCommand(program, {
    name: "contains",
    description: "Show members contained by the given entity (class, module, file)",
    helpAfter: "\nExamples:\n  ix contains IngestionService\n  ix contains auth.py --kind file --format json\n  ix contains MyClass --limit 20\n  ix contains package --path crates/regex/Cargo.toml",
    direction: "out",
    predicates: ["CONTAINS"],
    withSites: false,
  });
}
