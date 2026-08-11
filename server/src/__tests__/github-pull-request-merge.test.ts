import { describe, expect, it, vi } from "vitest";
import { createPullRequestMergeDetailsResolver } from "../services/github-pull-request-merge.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeCommitSha = "c".repeat(40);
const observedAt = new Date("2026-08-11T12:05:00.000Z");
const reference = { host: "github.com", owner: "paperclipai", repo: "paperclip", number: 321 } as const;

function completeMergedPullRequest() {
  return {
    state: "closed",
    merged: true,
    draft: false,
    title: "Ship governance evidence",
    updated_at: "2026-08-11T12:04:00.000Z",
    merged_at: "2026-08-11T12:03:00.000Z",
    merge_commit_sha: mergeCommitSha,
    head: { ref: "codex/governance", sha: headSha },
    base: {
      ref: "master",
      sha: baseSha,
      repo: { node_id: "R_kgDOPaperclip", name: "paperclip", owner: { login: "paperclipai" } },
    },
  };
}

function response(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", etag: '"snapshot-etag"' },
  });
}

function resolverFor(body: Record<string, unknown>) {
  const fetch = vi.fn(async () => response(body));
  return {
    fetch,
    resolve: createPullRequestMergeDetailsResolver({} as never, {
      fetch,
      tokenProvider: null,
      now: () => observedAt,
    }),
  };
}

describe("GitHub pull request immutable merge details", () => {
  it("returns a complete immutable merged envelope", async () => {
    const { fetch, resolve } = resolverFor(completeMergedPullRequest());
    const result = await resolve("company-1", reference);

    expect(fetch).toHaveBeenCalledOnce();
    expect(result).toEqual({
      state: "merged",
      repositoryId: "R_kgDOPaperclip",
      owner: "paperclipai",
      repo: "paperclip",
      number: 321,
      headRef: "codex/governance",
      headSha,
      baseSha,
      mergeCommitSha,
      mergedAt: "2026-08-11T12:03:00.000Z",
      providerSnapshotId: 'github:R_kgDOPaperclip:pull/321:2026-08-11T12:04:00.000Z:"snapshot-etag"',
      observedAt: observedAt.toISOString(),
    });
  });

  it("preserves a provider-confirmed open state without claiming merge proof", async () => {
    const open = completeMergedPullRequest();
    open.state = "open";
    open.merged = false;
    open.merged_at = "";
    open.merge_commit_sha = "";
    const { resolve } = resolverFor(open);

    await expect(resolve("company-1", reference)).resolves.toMatchObject({
      state: "open",
      headRef: "codex/governance",
      headSha,
      mergeCommitSha: null,
    });
  });

  it("treats a merely closed pull request as unknown", async () => {
    const closed = completeMergedPullRequest();
    closed.merged = false;
    closed.merged_at = "";
    closed.merge_commit_sha = "";
    const { resolve } = resolverFor(closed);

    await expect(resolve("company-1", reference)).resolves.toMatchObject({
      state: "unknown",
      mergeCommitSha: null,
      providerSnapshotId: null,
    });
  });

  it.each([
    ["repository identity", (body: ReturnType<typeof completeMergedPullRequest>) => { body.base.repo = {} as typeof body.base.repo; }],
    ["base SHA", (body: ReturnType<typeof completeMergedPullRequest>) => { body.base.sha = ""; }],
    ["head SHA", (body: ReturnType<typeof completeMergedPullRequest>) => { body.head.sha = headSha.slice(0, 12); }],
    ["merge SHA", (body: ReturnType<typeof completeMergedPullRequest>) => { body.merge_commit_sha = ""; }],
    ["merged timestamp", (body: ReturnType<typeof completeMergedPullRequest>) => { body.merged_at = ""; }],
    ["provider snapshot identity", (body: ReturnType<typeof completeMergedPullRequest>) => { body.updated_at = ""; }],
  ])("returns unknown when merged evidence omits %s", async (_label, mutate) => {
    const body = completeMergedPullRequest();
    mutate(body);
    const { resolve } = resolverFor(body);

    const result = await resolve("company-1", reference);
    expect(result.state).toBe("unknown");
    expect(result.mergeCommitSha).toBeNull();
  });
});
