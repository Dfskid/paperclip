import type { Db } from "@paperclipai/db";
import {
  createGitHubExternalObjectProvider,
  type GitHubExternalObjectProviderOptions,
} from "./github-external-object-provider.js";

export type GitHubPullRequestReference = {
  host: "github.com";
  owner: string;
  repo: string;
  number: number;
};

export type PullRequestMergeState = "merged" | "open" | "unknown";

export type PullRequestMergeDetails = {
  state: PullRequestMergeState;
  repositoryId: string | null;
  owner: string;
  repo: string;
  number: number;
  headRef: string | null;
  headSha: string | null;
  baseSha: string | null;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  providerSnapshotId: string | null;
  observedAt: string | null;
};

export type PullRequestMergeStateResolver = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<PullRequestMergeState>;

export type PullRequestMergeDetailsResolver = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<PullRequestMergeDetails>;

export const PULL_REQUEST_CACHE_MAX_ENTRIES = 1_000;

export function setBoundedPullRequestCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
) {
  cache.delete(key);
  while (cache.size >= PULL_REQUEST_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(key, value);
}

const GITHUB_PULL_REQUEST_URL_PATTERN = /https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/gi;
const GITHUB_PULL_REQUEST_SHORTHAND_PATTERN = /(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g;

function addPullRequestReference(
  references: Map<string, GitHubPullRequestReference>,
  owner: string,
  repo: string,
  rawNumber: string,
) {
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return;
  const reference = { host: "github.com", owner, repo, number } as const;
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  if (!references.has(key)) references.set(key, reference);
}

export function extractGitHubPullRequestReferences(values: readonly unknown[]) {
  const references = new Map<string, GitHubPullRequestReference>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    GITHUB_PULL_REQUEST_URL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_URL_PATTERN)) {
      addPullRequestReference(references, match[1]!, match[2]!, match[3]!);
    }
    GITHUB_PULL_REQUEST_SHORTHAND_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_SHORTHAND_PATTERN)) {
      addPullRequestReference(references, match[2]!, match[3]!, match[4]!);
    }
  }
  return [...references.values()];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFullGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function unknownDetails(reference: GitHubPullRequestReference): PullRequestMergeDetails {
  return {
    state: "unknown",
    repositoryId: null,
    owner: reference.owner,
    repo: reference.repo,
    number: reference.number,
    headRef: null,
    headSha: null,
    baseSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    providerSnapshotId: null,
    observedAt: null,
  };
}

export function createPullRequestMergeDetailsResolver(
  db: Db,
  providerOptions: GitHubExternalObjectProviderOptions = {},
): PullRequestMergeDetailsResolver {
  const resolver = createGitHubExternalObjectProvider(db, providerOptions).resolvers
    .find((candidate) => candidate.objectType === "pull_request") ?? null;

  return async (companyId, reference) => {
    if (!resolver) return unknownDetails(reference);
    const result = await resolver.resolve({
      companyId,
      object: {
        externalId: `${reference.owner}/${reference.repo}#pull/${reference.number}`,
        sanitizedCanonicalUrl: `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`,
      } as never,
    });
    if (!result.ok) return unknownDetails(reference);
    const data = readRecord(result.snapshot.data);
    const headRef = typeof data?.headRef === "string" ? data.headRef : null;
    const headSha = isFullGitSha(data?.headSha) ? data.headSha : null;
    if (result.snapshot.statusKey === "open" || result.snapshot.statusKey === "draft") {
      return {
        ...unknownDetails(reference),
        state: "open",
        headRef,
        headSha,
      };
    }
    const repositoryId = typeof data?.repositoryId === "string" && data.repositoryId.length > 0
      ? data.repositoryId
      : null;
    const baseSha = isFullGitSha(data?.baseSha) ? data.baseSha : null;
    const mergeCommitSha = isFullGitSha(data?.mergeCommitSha) ? data.mergeCommitSha : null;
    const mergedAt = isTimestamp(data?.mergedAt) ? data.mergedAt : null;
    const providerSnapshotId = typeof data?.providerSnapshotId === "string" && data.providerSnapshotId.length > 0
      ? data.providerSnapshotId
      : null;
    const observedAt = isTimestamp(data?.observedAt) ? data.observedAt : null;
    const immutableMergeComplete = (result.snapshot.statusKey === "merged" || data?.merged === true)
      && repositoryId !== null
      && headSha !== null
      && baseSha !== null
      && mergeCommitSha !== null
      && mergedAt !== null
      && providerSnapshotId !== null
      && observedAt !== null
      && Date.parse(mergedAt!) <= Date.parse(observedAt!);
    if (!immutableMergeComplete) return unknownDetails(reference);
    return {
      state: "merged",
      repositoryId,
      owner: reference.owner,
      repo: reference.repo,
      number: reference.number,
      headRef,
      headSha,
      baseSha,
      mergeCommitSha,
      mergedAt,
      providerSnapshotId,
      observedAt,
    };
  };
}

export function createPullRequestMergeStateResolver(db: Db): PullRequestMergeStateResolver {
  const resolveDetails = createPullRequestMergeDetailsResolver(db);
  return async (companyId, reference) => (await resolveDetails(companyId, reference)).state;
}
