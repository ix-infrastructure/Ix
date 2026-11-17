// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { registerEdgeCommand } from "../edge-command.js";

export function registerImportsCommand(program: Command): void {
  registerEdgeCommand(program, {
    name: "imports",
    description: "Show what the given entity imports",
    helpAfter: "\nExamples:\n  ix imports auth.py\n  ix imports IngestionService --format json",
    direction: "out",
    predicates: ["IMPORTS"],
    withSites: true,
  });

  registerEdgeCommand(program, {
    name: "imported-by",
    description: "Show what imports the given entity",
    helpAfter: "\nExamples:\n  ix imported-by AuthProvider\n  ix imported-by io.circe.Json --format json",
    direction: "in",
    predicates: ["IMPORTS"],
    withSites: true,
  });
}
