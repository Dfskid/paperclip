import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  decisionTechnicalEvidenceSchema,
  externalEnforcementEvidenceSchema,
  type DecisionTechnicalEvidenceV1,
  type ExternalEnforcementEvidenceV1,
} from "@paperclipai/shared";
import {
  resolveGitHubApiToken,
  type GitHubExternalObjectProviderOptions,
} from "./github-external-object-provider.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

export type DecisionEvidenceSnapshot = {
  technicalEvidence: DecisionTechnicalEvidenceV1;
  externalEnforcement: ExternalEnforcementEvidenceV1;
};

export type DecisionEvidenceLoader = (
  companyId: string,
  expected: DecisionEvidenceSnapshot,
) => Promise<DecisionEvidenceSnapshot>;

export type DecisionEvidenceCaptureInput = {
  repository: { owner: string; name: string };
  pullRequestNumber: number;
  actor: string;
  expiresAt: string;
};

export type DecisionEvidenceCapture = (
  companyId: string,
  input: DecisionEvidenceCaptureInput,
) => Promise<DecisionEvidenceSnapshot>;

export type DecisionEvidenceValidation = DecisionEvidenceSnapshot & {
  ok: boolean;
  reason:
    | null
    | "evidence_expired"
    | "evidence_unavailable"
    | "evidence_unparsable"
    | "evidence_drifted"
    | "external_enforcement_denied";
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fullSha(value: unknown) {
  const candidate = asString(value);
  return candidate && /^[0-9a-f]{40}$/i.test(candidate) ? candidate : null;
}

function enabledFlag(value: unknown) {
  const record = asRecord(value);
  return record ? asBoolean(record.enabled) : null;
}

function normalizeBranchProtection(value: Record<string, unknown> | null) {
  if (!value) throw new Error("GitHub branch-protection evidence was invalid");
  const has = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
  const nullableRecord = (key: string) => value[key] === null || asRecord(value[key]) !== null;
  const requiredFlag = (key: string) => {
    const record = asRecord(value[key]);
    return record !== null && asBoolean(record.enabled) !== null;
  };
  if (!has("required_status_checks") || !nullableRecord("required_status_checks")
    || !has("required_pull_request_reviews") || !nullableRecord("required_pull_request_reviews")
    || !has("restrictions") || !nullableRecord("restrictions")
    || !requiredFlag("enforce_admins")
    || !requiredFlag("required_linear_history")
    || !requiredFlag("required_conversation_resolution")
    || !requiredFlag("allow_force_pushes")
    || !requiredFlag("allow_deletions")) {
    throw new Error("GitHub branch-protection evidence was incomplete");
  }
  const statusChecks = asRecord(value.required_status_checks);
  const reviews = asRecord(value.required_pull_request_reviews);
  const restrictions = asRecord(value.restrictions);
  if (statusChecks && (
    asBoolean(statusChecks.strict) === null
    || !Array.isArray(statusChecks.contexts)
    || statusChecks.contexts.some((context) => typeof context !== "string" || context.trim().length === 0)
    || !Array.isArray(statusChecks.checks)
  )) {
    throw new Error("GitHub required-status-check evidence was incomplete");
  }
  if (reviews && (
    asBoolean(reviews.dismiss_stale_reviews) === null
    || asBoolean(reviews.require_code_owner_reviews) === null
    || !Number.isInteger(asNumber(reviews.required_approving_review_count))
    || (asNumber(reviews.required_approving_review_count) ?? -1) < 0
    || asBoolean(reviews.require_last_push_approval) === null
  )) {
    throw new Error("GitHub review-rule evidence was incomplete");
  }
  if (restrictions && [restrictions.users, restrictions.teams, restrictions.apps].some((actors) => !Array.isArray(actors))) {
    throw new Error("GitHub branch-restriction evidence was incomplete");
  }
  const normalizeActors = (actors: unknown) => Array.isArray(actors)
    ? actors.map((actor) => asRecord(actor)).filter(Boolean).map((actor) => ({
        id: asNumber(actor!.id),
        login: asString(actor!.login) ?? asString(actor!.slug),
      })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    : [];
  const checks = Array.isArray(statusChecks?.checks)
    ? statusChecks.checks.map((item) => {
        const record = asRecord(item);
        const context = asString(record?.context);
        const rawAppId = asNumber(record?.app_id);
        if (!record || !context || !Number.isInteger(rawAppId) || (rawAppId ?? -2) < -1) {
          throw new Error("GitHub required-check evidence was incomplete");
        }
        return {
          context,
          // GitHub's classic branch-protection sentinel -1 means any app.
          appId: rawAppId === -1 ? null : rawAppId,
        };
      }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    : [];
  const contexts = Array.isArray(statusChecks?.contexts)
    ? statusChecks.contexts.filter((item): item is string => typeof item === "string").sort()
    : [];
  return {
    protected: true,
    requiredStatusChecks: statusChecks ? {
      strict: asBoolean(statusChecks.strict),
      contexts: [...new Set([...contexts, ...checks.map((check) => check.context).filter((item): item is string => Boolean(item))])].sort(),
      checks,
    } : null,
    requiredPullRequestReviews: reviews ? {
      dismissStaleReviews: asBoolean(reviews.dismiss_stale_reviews),
      requireCodeOwnerReviews: asBoolean(reviews.require_code_owner_reviews),
      requiredApprovingReviewCount: asNumber(reviews.required_approving_review_count),
      requireLastPushApproval: asBoolean(reviews.require_last_push_approval),
    } : null,
    enforceAdmins: enabledFlag(value.enforce_admins),
    requiredLinearHistory: enabledFlag(value.required_linear_history),
    requiredConversationResolution: enabledFlag(value.required_conversation_resolution),
    allowForcePushes: enabledFlag(value.allow_force_pushes),
    allowDeletions: enabledFlag(value.allow_deletions),
    restrictions: restrictions ? {
      users: normalizeActors(restrictions.users),
      teams: normalizeActors(restrictions.teams),
      apps: normalizeActors(restrictions.apps),
    } : null,
  };
}

function normalizeRepositoryConfiguration(value: Record<string, unknown>) {
  return {
    id: asString(value.node_id) ?? asNumber(value.id)?.toString() ?? null,
    archived: asBoolean(value.archived),
    disabled: asBoolean(value.disabled),
    visibility: asString(value.visibility),
    allowAutoMerge: asBoolean(value.allow_auto_merge),
    allowMergeCommit: asBoolean(value.allow_merge_commit),
    allowRebaseMerge: asBoolean(value.allow_rebase_merge),
    allowSquashMerge: asBoolean(value.allow_squash_merge),
    deleteBranchOnMerge: asBoolean(value.delete_branch_on_merge),
    webCommitSignoffRequired: asBoolean(value.web_commit_signoff_required),
    mergeCommitMessage: asString(value.merge_commit_message),
    mergeCommitTitle: asString(value.merge_commit_title),
    squashMergeCommitMessage: asString(value.squash_merge_commit_message),
    squashMergeCommitTitle: asString(value.squash_merge_commit_title),
  };
}

function normalizeDeployments(value: unknown) {
  if (!Array.isArray(value)) throw new Error("GitHub deployment evidence was not an array");
  return value.map((item) => asRecord(item)).filter(Boolean).map((deployment) => ({
    id: asNumber(deployment!.id)?.toString() ?? asString(deployment!.node_id),
    nodeId: asString(deployment!.node_id),
    sha: fullSha(deployment!.sha),
    environment: asString(deployment!.environment),
    task: asString(deployment!.task),
    productionEnvironment: asBoolean(deployment!.production_environment),
    transientEnvironment: asBoolean(deployment!.transient_environment),
    createdAt: asString(deployment!.created_at),
    updatedAt: asString(deployment!.updated_at),
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

type GitHubApiResult = { body: unknown; response: Response };

/**
 * Production effect-time loader. It uses the same credential and fetch seams as
 * the GitHub external-object provider, then recomputes every signed GitHub fact.
 */
function createGitHubDecisionEvidenceResolver(
  db: Db,
  options: GitHubExternalObjectProviderOptions = {},
) {
  const fetchImpl = options.fetch ?? ghFetch;
  const now = options.now ?? (() => new Date());

  return async (companyId: string, target: DecisionEvidenceCaptureInput & { expectedHeadSha: string | null }) => {
    const token = await resolveGitHubApiToken(db, companyId, options);
    if (!token) throw new Error("GitHub credentials are unavailable");
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "paperclip-decision-evidence-resolver",
      "x-github-api-version": "2022-11-28",
    };
    const owner = encodeURIComponent(target.repository.owner);
    const repo = encodeURIComponent(target.repository.name);
    const apiBase = `${gitHubApiBase("github.com")}/repos/${owner}/${repo}`;
    const request = async (url: string, allowNotFound = false): Promise<GitHubApiResult> => {
      const response = await fetchImpl(url, { headers });
      if (allowNotFound && response.status === 404) return { body: null, response };
      if (!response.ok) throw new Error(`GitHub evidence request failed with HTTP ${response.status}`);
      if (/rel="next"/.test(response.headers.get("link") ?? "")) {
        throw new Error("GitHub evidence pagination exceeded the bounded complete response");
      }
      return { body: await response.json(), response };
    };
    const requestReviewPolicy = async (): Promise<GitHubApiResult> => {
      const response = await fetchImpl(`${gitHubApiBase("github.com")}/graphql`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          query: `query PaperclipDecisionReviewPolicy($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) { reviewDecision mergeStateStatus }
            }
          }`,
          variables: {
            owner: target.repository.owner,
            name: target.repository.name,
            number: target.pullRequestNumber,
          },
        }),
      });
      if (!response.ok) throw new Error(`GitHub review-policy request failed with HTTP ${response.status}`);
      const body = await response.json();
      const root = asRecord(body);
      if (!root || (Object.prototype.hasOwnProperty.call(root, "errors")
        && (!Array.isArray(root.errors) || root.errors.length > 0))) {
        throw new Error("GitHub review-policy response contained GraphQL errors");
      }
      return { body, response };
    };

    const prNumber = target.pullRequestNumber;
    const prResult = await request(`${apiBase}/pulls/${prNumber}`);
    const pr = asRecord(prResult.body);
    if (!pr) throw new Error("GitHub pull request evidence was invalid");
    const base = asRecord(pr.base);
    const head = asRecord(pr.head);
    const baseRepository = asRecord(base?.repo);
    const baseRef = asString(base?.ref);
    const baseSha = fullSha(base?.sha);
    const headSha = fullSha(head?.sha);
    const repositoryId = asString(baseRepository?.node_id) ?? asNumber(baseRepository?.id)?.toString() ?? null;
    if (!baseRef || !baseSha || !headSha || !repositoryId) {
      throw new Error("GitHub pull request omitted immutable identity fields");
    }

    const encodedHead = encodeURIComponent(headSha);
    const [checksResult, statusesResult, reviewsResult, protectionResult, deploymentsResult, repositoryResult, actorResult, reviewPolicyResult] = await Promise.all([
      request(`${apiBase}/commits/${encodedHead}/check-runs?per_page=100`),
      request(`${apiBase}/commits/${encodedHead}/status?per_page=100`),
      request(`${apiBase}/pulls/${prNumber}/reviews?per_page=100`),
      request(`${apiBase}/branches/${encodeURIComponent(baseRef)}/protection`, true),
      request(`${apiBase}/deployments?sha=${encodedHead}&per_page=100`),
      request(apiBase),
      request(`${gitHubApiBase("github.com")}/user`),
      requestReviewPolicy(),
    ]);
    const checksBody = asRecord(checksResult.body);
    const statusesBody = asRecord(statusesResult.body);
    const reviewsBody = reviewsResult.body;
    const protection = protectionResult.response.status === 404
      ? { protected: false as const }
      : normalizeBranchProtection(asRecord(protectionResult.body));
    const repository = asRecord(repositoryResult.body);
    const actor = asRecord(actorResult.body);
    const reviewPolicyRoot = asRecord(reviewPolicyResult.body);
    const reviewPolicyData = asRecord(reviewPolicyRoot?.data);
    const reviewPolicyRepository = asRecord(reviewPolicyData?.repository);
    const reviewPolicy = asRecord(reviewPolicyRepository?.pullRequest);
    const providerReviewDecision = asString(reviewPolicy?.reviewDecision);
    const providerMergeStateStatus = asString(reviewPolicy?.mergeStateStatus);
    if (!checksBody || !Array.isArray(checksBody.check_runs)
      || !statusesBody || !Array.isArray(statusesBody.statuses)
      || !Array.isArray(reviewsBody) || !repository || !actor
      || !providerMergeStateStatus) {
      throw new Error("GitHub returned incomplete decision evidence");
    }
    const actorLogin = asString(actor.login);
    const resolvedRepositoryId = asString(repository.node_id) ?? asNumber(repository.id)?.toString() ?? null;
    if (!actorLogin || resolvedRepositoryId !== repositoryId) {
      throw new Error("GitHub repository or actor identity drifted");
    }

    const requiredStatusChecks = protection.protected ? protection.requiredStatusChecks : null;
    const appBoundContextKeys = new Set(requiredStatusChecks?.checks
      .map((check) => check.context.toLowerCase()) ?? []);
    const requiredCheckRequirements = requiredStatusChecks ? [
      ...requiredStatusChecks.checks,
      ...requiredStatusChecks.contexts
        .filter((context) => !appBoundContextKeys.has(context.toLowerCase()))
        .map((context) => ({ context, appId: null })),
    ] : [];
    const requiredContexts = [...new Set(requiredCheckRequirements
      .map((requirement) => requirement.context)
      .filter((context): context is string => Boolean(context)))];
    const requiredContextKeys = new Set(requiredContexts.map((context) => context.toLowerCase()));
    const checkRuns = checksBody.check_runs;
    const allCombinedStatuses = statusesBody.statuses;
    const latestStatusByContext = new Map<string, { status: Record<string, unknown>; timestamp: number; id: number }>();
    for (const rawStatus of allCombinedStatuses) {
      const status = asRecord(rawStatus);
      const context = asString(status?.context);
      const id = asNumber(status?.id);
      const timestamp = Date.parse(asString(status?.updated_at) ?? asString(status?.created_at) ?? "");
      if (!status || !context || id === null || !Number.isFinite(timestamp)) {
        throw new Error("GitHub commit-status evidence was invalid");
      }
      const key = context.toLowerCase();
      const current = latestStatusByContext.get(key);
      if (!current || timestamp > current.timestamp || (timestamp === current.timestamp && id > current.id)) {
        latestStatusByContext.set(key, { status, timestamp, id });
      }
    }
    const combinedStatuses = [...latestStatusByContext.values()].map((entry) => entry.status);
    const requiredChecks: DecisionTechnicalEvidenceV1["requiredChecks"] = [
      ...checkRuns.map((item) => asRecord(item)).filter(Boolean).filter((item) => requiredContextKeys.has((asString(item!.name) ?? "").toLowerCase())).map((item) => {
        const id = asNumber(item!.id)?.toString() ?? asString(item!.node_id);
        const name = asString(item!.name);
        const conclusion = asString(item!.conclusion);
        const appId = asNumber(asRecord(item!.app)?.id);
        if (!id || !name) throw new Error("GitHub check-run evidence was invalid");
        const normalizedConclusion = conclusion && ["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required"].includes(conclusion)
          ? conclusion as DecisionTechnicalEvidenceV1["requiredChecks"][number]["conclusion"]
          : "action_required" as const;
        return { runId: `check:${id}`, name, appId, conclusion: normalizedConclusion, commitSha: headSha };
      }),
      ...combinedStatuses.map((item) => asRecord(item)).filter(Boolean).filter((item) => requiredContextKeys.has((asString(item!.context) ?? "").toLowerCase())).map((item) => {
        const id = asNumber(item!.id)?.toString() ?? asString(item!.node_id);
        const name = asString(item!.context);
        const state = asString(item!.state);
        if (!id || !name) throw new Error("GitHub status evidence was invalid");
        const conclusion = state === "success" ? "success" as const : state === "pending" ? "action_required" as const : "failure" as const;
        return { runId: `status:${id}`, name, appId: null, conclusion, commitSha: headSha };
      }),
    ].sort((left, right) => left.runId.localeCompare(right.runId));

    const reviews: DecisionTechnicalEvidenceV1["reviews"] = reviewsBody.map((item) => asRecord(item)).filter(Boolean).map((item) => {
      const id = asNumber(item!.id)?.toString() ?? asString(item!.node_id);
      const reviewer = asRecord(item!.user);
      const reviewerLogin = asString(reviewer?.login);
      const state = asString(item!.state)?.toLowerCase();
      const commitSha = fullSha(item!.commit_id);
      const submittedAt = asString(item!.submitted_at);
      if (!id || !reviewerLogin || !commitSha || !state || !submittedAt || !Number.isFinite(Date.parse(submittedAt)) || !["approved", "changes_requested", "commented", "dismissed"].includes(state)) {
        throw new Error("GitHub review evidence was invalid");
      }
      return {
        id,
        actor: reviewerLogin,
        state: state as DecisionTechnicalEvidenceV1["reviews"][number]["state"],
        commitSha,
        submittedAt,
      };
    }).sort((left, right) => left.submittedAt.localeCompare(right.submittedAt) || left.id.localeCompare(right.id));

    const observedAt = now().toISOString();
    const mergedAt = asString(pr.merged_at);
    const merged = asBoolean(pr.merged) === true || Boolean(mergedAt);
    const mergeCommitSha = merged ? fullSha(pr.merge_commit_sha) : null;
    if (merged && (!mergeCommitSha || !mergedAt)) throw new Error("GitHub merge evidence was incomplete");
    const technicalEvidence: DecisionTechnicalEvidenceV1 = {
      schemaVersion: 1,
      provider: "github",
      repository: {
        id: repositoryId,
        owner: target.repository.owner,
        name: target.repository.name,
      },
      pullRequest: { number: prNumber, baseSha, headSha, mergeCommitSha, mergedAt: mergedAt ?? null },
      fingerprints: {
        environment: fingerprint(normalizeDeployments(deploymentsResult.body)),
        configuration: fingerprint({
          repository: normalizeRepositoryConfiguration(repository),
          pullRequest: {
            state: asString(pr.state),
            draft: asBoolean(pr.draft),
            baseRef,
            headRef: asString(head?.ref),
            mergeable: asBoolean(pr.mergeable),
            mergeableState: asString(pr.mergeable_state),
            rebaseable: asBoolean(pr.rebaseable),
            maintainerCanModify: asBoolean(pr.maintainer_can_modify),
          },
        }),
        branchRules: fingerprint(protection),
      },
      observedAt,
      expiresAt: target.expiresAt,
      requiredChecks,
      reviews,
    };

    const latestReviewByActor = new Map<string, DecisionTechnicalEvidenceV1["reviews"][number]>();
    for (const review of reviews) latestReviewByActor.set(review.actor.toLowerCase(), review);
    const approvedHeadReviews = [...latestReviewByActor.values()]
      .filter((review) => review.state === "approved" && review.commitSha === headSha);
    const requiredChecksPassed = requiredCheckRequirements.every((requirement) => requiredChecks.some((check) => (
      check.name.toLowerCase() === requirement.context?.toLowerCase()
      && check.conclusion === "success"
      && (requirement.appId === null || check.appId === requirement.appId)
    )));
    const reviewRules = protection.protected ? protection.requiredPullRequestReviews : null;
    const requiresCodeOwners = reviewRules?.requireCodeOwnerReviews === true;
    const requiredApprovalCount = Math.max(reviewRules?.requiredApprovingReviewCount ?? 0, 0);
    const hasReviewPolicy = requiredApprovalCount > 0 || requiresCodeOwners || reviewRules?.requireLastPushApproval === true;
    const mergeabilityClean = asBoolean(pr.mergeable) === true
      && asString(pr.mergeable_state) === "clean"
      && providerMergeStateStatus === "CLEAN";
    // reviewDecision is GitHub's provider-owned aggregate for configured review
    // policy, including CODEOWNERS and last-push approval rules. REST review rows
    // independently prove only latest-per-reviewer exact-head approval count.
    const codeownersPassed = !hasReviewPolicy || (
      mergeabilityClean
      && providerReviewDecision === "APPROVED"
      && approvedHeadReviews.length >= requiredApprovalCount
    );
    const gate = (
      type: ExternalEnforcementEvidenceV1["gates"][number]["type"],
      passed: boolean,
      evidenceIds: string[],
    ): ExternalEnforcementEvidenceV1["gates"][number] => ({
      type,
      status: passed ? "passed" : "failed",
      evidenceIds: evidenceIds.length > 0 ? evidenceIds : [`${type}:not_satisfied`],
    });
    const exactHead = target.expectedHeadSha === null || headSha === target.expectedHeadSha;
    const actorPassed = actorLogin.toLowerCase() === target.actor.toLowerCase();
    const branchProtectionPassed = protection.protected;
    const mergeGatePassed = merged || (
      asString(pr.state) === "open"
      && asBoolean(pr.draft) === false
      && mergeabilityClean
      && branchProtectionPassed
      && requiredChecksPassed
      && codeownersPassed
    );
    const gates: ExternalEnforcementEvidenceV1["gates"] = [
      gate("github_actor", actorPassed, [`github:user:${actorLogin}`]),
      gate("codeowners_review", codeownersPassed, hasReviewPolicy
        ? [
            `github:branch-rules:${technicalEvidence.fingerprints.branchRules}`,
            `github:exact-head-approval-count:${approvedHeadReviews.length}/${requiredApprovalCount}`,
            `github:review-decision:${providerReviewDecision}`,
            `github:mergeability:${asString(pr.mergeable_state) ?? "unknown"}`,
          ]
        : ["github:codeowners:not_required_by_rule"]),
      gate("branch_protection", branchProtectionPassed, [`github:branch-protection:${baseRef}:${technicalEvidence.fingerprints.branchRules}`]),
      gate(
        "required_checks",
        requiredChecksPassed,
        requiredContexts.length === 0
          ? ["github:required-checks:none_required"]
          : requiredChecks.map((check) => `github:${check.runId}:${check.conclusion}`),
      ),
      gate("exact_head", exactHead, [`github:head:${headSha}`]),
      gate("merge_gate", mergeGatePassed, [`github:pull:${prNumber}:${asString(pr.mergeable_state) ?? (merged ? "merged" : "unknown")}`]),
    ];
    const externalEnforcement: ExternalEnforcementEvidenceV1 = {
      schemaVersion: 1,
      provider: "github",
      repositoryId,
      pullRequestNumber: prNumber,
      actor: actorLogin,
      headSha,
      evaluatedAt: observedAt,
      allowed: gates.every((item) => item.status === "passed"),
      gates,
    };
    return { technicalEvidence, externalEnforcement };
  };
}

/** Capture a complete provider-derived envelope that a client can submit. */
export function createGitHubDecisionEvidenceCapture(
  db: Db,
  options: GitHubExternalObjectProviderOptions = {},
): DecisionEvidenceCapture {
  const resolve = createGitHubDecisionEvidenceResolver(db, options);
  return async (companyId, input) => {
    const snapshot = await resolve(companyId, { ...input, expectedHeadSha: null });
    return {
      technicalEvidence: decisionTechnicalEvidenceSchema.parse(snapshot.technicalEvidence),
      externalEnforcement: externalEnforcementEvidenceSchema.parse(snapshot.externalEnforcement),
    };
  };
}

/** Re-resolve a submitted envelope at create/effect time and bind exact head. */
export function createGitHubDecisionEvidenceLoader(
  db: Db,
  options: GitHubExternalObjectProviderOptions = {},
): DecisionEvidenceLoader {
  const resolve = createGitHubDecisionEvidenceResolver(db, options);
  return (companyId, expected) => resolve(companyId, {
    repository: {
      owner: expected.technicalEvidence.repository.owner,
      name: expected.technicalEvidence.repository.name,
    },
    pullRequestNumber: expected.technicalEvidence.pullRequest.number,
    actor: expected.externalEnforcement.actor,
    expiresAt: expected.technicalEvidence.expiresAt,
    expectedHeadSha: expected.technicalEvidence.pullRequest.headSha,
  });
}

function immutableTechnicalState(evidence: DecisionTechnicalEvidenceV1) {
  return {
    schemaVersion: evidence.schemaVersion,
    provider: evidence.provider,
    repository: evidence.repository,
    pullRequest: evidence.pullRequest,
    fingerprints: evidence.fingerprints,
    requiredChecks: evidence.requiredChecks,
    reviews: evidence.reviews,
  };
}

function denialFromExpected(
  expected: ExternalEnforcementEvidenceV1,
  reason: string,
  now: Date,
): ExternalEnforcementEvidenceV1 {
  return {
    ...expected,
    evaluatedAt: now.toISOString(),
    allowed: false,
    gates: expected.gates.map((gate) => ({
      ...gate,
      status: "failed",
      evidenceIds: [reason],
    })),
  };
}

/**
 * Revalidates the complete signed technical state and keeps GitHub's gate result
 * as separate evidence. Authentication or a Paperclip signature alone cannot
 * turn a denied or unavailable external gate into authorization.
 */
export async function revalidateDecisionEvidence(input: {
  companyId: string;
  expectedTechnicalEvidence: unknown;
  expectedExternalEnforcement: unknown;
  load: DecisionEvidenceLoader | undefined;
  now?: Date;
}): Promise<DecisionEvidenceValidation> {
  const startedAt = input.now ?? new Date();
  const expectedTechnical = decisionTechnicalEvidenceSchema.safeParse(input.expectedTechnicalEvidence);
  const expectedExternal = externalEnforcementEvidenceSchema.safeParse(input.expectedExternalEnforcement);
  if (!expectedTechnical.success || !expectedExternal.success) {
    const fallback = expectedExternal.success
      ? denialFromExpected(expectedExternal.data, "evidence_unparsable", startedAt)
      : null;
    if (!expectedTechnical.success || !fallback) {
      throw new Error("Stored decision evidence is unparsable");
    }
    return {
      ok: false,
      reason: "evidence_unparsable",
      technicalEvidence: expectedTechnical.data,
      externalEnforcement: fallback,
    };
  }

  const expected = {
    technicalEvidence: expectedTechnical.data,
    externalEnforcement: expectedExternal.data,
  };
  if (Date.parse(expected.technicalEvidence.expiresAt) <= startedAt.getTime()) {
    return {
      ok: false,
      reason: "evidence_expired",
      technicalEvidence: expected.technicalEvidence,
      externalEnforcement: denialFromExpected(expected.externalEnforcement, "evidence_expired", startedAt),
    };
  }
  if (!input.load) {
    return {
      ok: false,
      reason: "evidence_unavailable",
      technicalEvidence: expected.technicalEvidence,
      externalEnforcement: denialFromExpected(expected.externalEnforcement, "evidence_unavailable", startedAt),
    };
  }

  let loaded: DecisionEvidenceSnapshot;
  try {
    loaded = await input.load(input.companyId, expected);
  } catch {
    return {
      ok: false,
      reason: "evidence_unavailable",
      technicalEvidence: expected.technicalEvidence,
      externalEnforcement: denialFromExpected(expected.externalEnforcement, "evidence_unavailable", input.now ?? new Date()),
    };
  }
  // Provider observations are stamped only after asynchronous requests finish.
  // Compare them against a post-load time so legitimate fresh evidence is not
  // rejected merely because the provider call took time.
  const validatedAt = input.now ?? new Date();
  const actualTechnical = decisionTechnicalEvidenceSchema.safeParse(loaded.technicalEvidence);
  const actualExternal = externalEnforcementEvidenceSchema.safeParse(loaded.externalEnforcement);
  if (!actualTechnical.success || !actualExternal.success) {
    return {
      ok: false,
      reason: "evidence_unparsable",
      technicalEvidence: expected.technicalEvidence,
      externalEnforcement: denialFromExpected(expected.externalEnforcement, "evidence_unparsable", validatedAt),
    };
  }
  if (Date.parse(actualTechnical.data.observedAt) > validatedAt.getTime()
    || Date.parse(actualTechnical.data.expiresAt) <= validatedAt.getTime()
    || canonicalJson(immutableTechnicalState(actualTechnical.data)) !== canonicalJson(immutableTechnicalState(expected.technicalEvidence))) {
    return {
      ok: false,
      reason: "evidence_drifted",
      technicalEvidence: actualTechnical.data,
      externalEnforcement: actualExternal.data.allowed
        ? denialFromExpected(actualExternal.data, "evidence_drifted", validatedAt)
        : actualExternal.data,
    };
  }
  const external = actualExternal.data;
  const externalEvaluatedAt = Date.parse(external.evaluatedAt);
  if (!external.allowed
    || externalEvaluatedAt < Date.parse(actualTechnical.data.observedAt)
    || externalEvaluatedAt > validatedAt.getTime()
    || external.repositoryId !== expected.externalEnforcement.repositoryId
    || external.pullRequestNumber !== expected.externalEnforcement.pullRequestNumber
    || external.headSha !== expected.externalEnforcement.headSha
    || external.actor !== expected.externalEnforcement.actor) {
    return {
      ok: false,
      reason: "external_enforcement_denied",
      technicalEvidence: actualTechnical.data,
      externalEnforcement: external.allowed
        ? denialFromExpected(external, "external_enforcement_denied", validatedAt)
        : external,
    };
  }
  return {
    ok: true,
    reason: null,
    technicalEvidence: actualTechnical.data,
    externalEnforcement: external,
  };
}
