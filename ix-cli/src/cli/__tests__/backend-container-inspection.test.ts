import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFileSync }));

import { BACKEND_IMAGE, checkBackendImage, inspectBackendContainer } from "../backend-status.js";

describe("inspectBackendContainer", () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it("checks the memory-layer image behind a compose port proxy", () => {
    execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "info") return "ok";
      if (args[0] === "ps" && args.includes("publish=8090")) return "proxy-id";
      if (args[0] === "inspect" && args[1] === "proxy-id") {
        return "sha256:proxy|::|nginx:stable|::|ix|::|/tmp/docker-compose.yml";
      }
      if (args[0] === "image" && args[2] === "sha256:proxy") {
        return '["nginx@sha256:proxy"]';
      }
      if (args[0] === "ps" && args.includes("label=com.docker.compose.service=memory-layer")) {
        return "backend-id";
      }
      if (args[0] === "inspect" && args[1] === "backend-id") {
        return `sha256:backend|::|${BACKEND_IMAGE}:latest|::|ix|::|/tmp/docker-compose.yml`;
      }
      if (args[0] === "image" && args[2] === "sha256:backend") {
        return `["${BACKEND_IMAGE}@sha256:backend"]`;
      }
      if (args[0] === "image" && args[2] === `${BACKEND_IMAGE}:latest`) {
        return "sha256:backend";
      }
      throw new Error(`unexpected docker invocation: ${args.join(" ")}`);
    });

    expect(checkBackendImage()).toMatchObject({
      kind: "ok",
      container: {
        containerId: "backend-id",
        imageRef: `${BACKEND_IMAGE}:latest`,
        imageId: "sha256:backend",
      },
    });
    expect(execFileSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "label=com.docker.compose.project=ix",
        "label=com.docker.compose.service=memory-layer",
      ]),
      expect.any(Object),
    );
  });

  it("keeps a directly-published local backend available for freshness warnings", () => {
    execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "ps" && args.includes("publish=8090")) return "local-id";
      if (args[0] === "inspect" && args[1] === "local-id") {
        return "sha256:local|::|ix-memory-layer-dev:latest|::||::|";
      }
      if (args[0] === "image" && args[2] === "sha256:local") return "[]";
      throw new Error(`unexpected docker invocation: ${args.join(" ")}`);
    });

    expect(inspectBackendContainer()).toMatchObject({
      containerId: "local-id",
      imageRef: "ix-memory-layer-dev:latest",
    });
  });
});
