// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";

import { githubPatchId } from "../commands/ingest.js";
import { fetchGitHubData, ghFetchList } from "../github/fetch.js";

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

describe("fetchGitHubData", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Stubs fetch with endpoints that each hold `total` items; returns the URLs asked for. */
  const stubGitHub = (total: number) => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const q = new URL(url).searchParams;
      const perPage = Number(q.get("per_page") ?? 30);
      const start = (Number(q.get("page") ?? 1) - 1) * perPage;
      const n = Math.max(0, Math.min(perPage, total - start));
      const body = Array.from({ length: n }, (_, i) => ({ number: start + i + 1, comments: 0 }));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return urls;
  };

  it("pages every list past 100, commits to twice the limit, and keeps since on the commits query", async () => {
    const urls = stubGitHub(10_000);
    const data = await fetchGitHubData({ owner: "o", repo: "r" }, "t", { since: "2026-01-01", limit: 300 });

    expect(data.issues).toHaveLength(300);
    expect(data.pullRequests).toHaveLength(300);
    expect(data.commits).toHaveLength(600);
    const commitUrls = urls.filter(u => u.includes("/commits?"));
    expect(commitUrls).toHaveLength(6);
    expect(commitUrls[0]).toBe("https://api.github.com/repos/o/r/commits?since=2026-01-01&per_page=100&page=1");
  });

  it("builds a well-formed commits query without since", async () => {
    const urls = stubGitHub(5);
    await fetchGitHubData({ owner: "o", repo: "r" }, "t", { limit: 2 });
    expect(urls.filter(u => u.includes("/commits"))).toEqual(["https://api.github.com/repos/o/r/commits?per_page=4&page=1"]);
  });
});

describe("githubPatchId", () => {
  const repo = { owner: "o", repo: "r" };
  const ops = [{ type: "UpsertNode", id: "n1", attrs: { title: "a" } }];

  it("is the same on every run for the same ops, whatever the clock says", () => {
    const first = githubPatchId(repo, ops);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      expect(githubPatchId(repo, structuredClone(ops))).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes when what is sent changes, or when the repo does", () => {
    const base = githubPatchId(repo, ops);
    expect(githubPatchId(repo, [{ ...ops[0], attrs: { title: "b" } }])).not.toBe(base);
    expect(githubPatchId({ owner: "o", repo: "other" }, ops)).not.toBe(base);
  });
});
