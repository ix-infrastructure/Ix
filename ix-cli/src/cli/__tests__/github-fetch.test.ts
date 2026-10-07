// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { ghFetchList } from "../github/fetch.js";

describe("parseGitHubRepo", () => {
  it("parses owner/repo format", async () => {
    const { parseGitHubRepo } = await import("../github/fetch.js");
    expect(parseGitHubRepo("ix-infrastructure/IX-Memory")).toEqual({
      owner: "ix-infrastructure",
      repo: "IX-Memory",
    });
  });

  it("throws on invalid format", async () => {
    const { parseGitHubRepo } = await import("../github/fetch.js");
    expect(() => parseGitHubRepo("invalid")).toThrow();
  });
});

describe("ghFetchList", () => {
  /** A list endpoint holding `total` items, recording the URLs it was asked for. */
  const endpoint = (total: number) => {
    const urls: string[] = [];
    const fetchPage = async (url: string): Promise<number[]> => {
      urls.push(url);
      const q = new URL(url).searchParams;
      const perPage = Math.min(Number(q.get("per_page")), 100);
      const page = Number(q.get("page"));
      const start = (page - 1) * perPage;
      return Array.from({ length: Math.max(0, Math.min(perPage, total - start)) }, (_, i) => start + i);
    };
    return { urls, fetchPage };
  };

  it("pages past GitHub's 100-item cap up to the limit asked for", async () => {
    const { urls, fetchPage } = endpoint(1000);
    const items = await ghFetchList("https://api.github.com/repos/o/r/issues?state=all", "t", 250, fetchPage);
    expect(items).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(urls).toEqual([
      "https://api.github.com/repos/o/r/issues?state=all&per_page=100&page=1",
      "https://api.github.com/repos/o/r/issues?state=all&per_page=100&page=2",
      "https://api.github.com/repos/o/r/issues?state=all&per_page=100&page=3",
    ]);
  });

  it("stops at a short page, and asks for no more than it needs", async () => {
    const short = endpoint(130);
    expect(await ghFetchList("https://api.github.com/x", "t", 500, short.fetchPage)).toHaveLength(130);
    expect(short.urls).toHaveLength(2);

    const small = endpoint(1000);
    expect(await ghFetchList("https://api.github.com/x", "t", 30, small.fetchPage)).toHaveLength(30);
    expect(small.urls).toEqual(["https://api.github.com/x?per_page=30&page=1"]);
  });
});
