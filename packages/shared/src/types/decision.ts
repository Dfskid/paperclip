import type { IssueStatus } from "../constants.js";

export type DecisionEffectStaleness = "strict" | "lenient";
export type DecisionOptionStyle = "default" | "primary" | "destructive";
export type DecisionAuthorityClass = "design_approval" | "execution_authority";
export type DecisionCapability = "implementation" | "money" | "publish" | "deploy" | "delivery" | "merge";
export type DecisionExternalGate =
  | "github_actor"
  | "codeowners_review"
  | "branch_protection"
  | "required_checks"
  | "exact_head"
  | "merge_gate";

export interface DecisionAuthorityGrantV1 {
  schemaVersion: 1;
  authorityClass: DecisionAuthorityClass;
  issuer: {
    userId: string;
    source: { kind: "issue" | "decision"; id: string };
    issuedAt: string;
  };
  actor: { kind: "agent" | "user"; id: string };
  targetIssueIds: string[];
  capabilities: DecisionCapability[];
  expiresAt: string;
  requiredExternalGates: DecisionExternalGate[];
}

export interface DecisionTechnicalEvidenceV1 {
  schemaVersion: 1;
  provider: "github";
  repository: {
    id: string;
    owner: string;
    name: string;
  };
  pullRequest: {
    number: number;
    baseSha: string;
    headSha: string;
    mergeCommitSha: string | null;
    mergedAt: string | null;
  };
  fingerprints: {
    environment: string;
    configuration: string;
    branchRules: string;
  };
  observedAt: string;
  expiresAt: string;
  requiredChecks: Array<{
    runId: string;
    name: string;
    appId: number | null;
    conclusion: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral" | "action_required";
    commitSha: string;
  }>;
  reviews: Array<{
    id: string;
    actor: string;
    state: "approved" | "changes_requested" | "commented" | "dismissed";
    commitSha: string;
    submittedAt: string;
  }>;
}

export interface ExternalEnforcementEvidenceV1 {
  schemaVersion: 1;
  provider: "github";
  repositoryId: string;
  pullRequestNumber: number;
  actor: string;
  headSha: string;
  evaluatedAt: string;
  allowed: boolean;
  gates: Array<{
    type: DecisionExternalGate;
    status: "passed" | "failed";
    evidenceIds: string[];
  }>;
}

export interface DecisionInput {
  id: string;
  label: string;
  placeholder?: string | null;
  required?: boolean;
  maxLength?: number;
}

interface DecisionEffectBase {
  targetIssueId: string;
  staleness: DecisionEffectStaleness;
}

export interface CommentOnIssueDecisionEffect extends DecisionEffectBase {
  type: "comment_on_issue";
  bodyMarkdown: string;
}

export interface CreateIssueDecisionEffect extends DecisionEffectBase {
  type: "create_issue";
  draft: {
    title: string;
    description?: string | null;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    blockedByIssueIds?: string[];
  };
}

export interface UpdateIssueStatusDecisionEffect extends DecisionEffectBase {
  type: "update_issue_status";
  status: IssueStatus;
  comment?: string | null;
}

export interface AssignIssueDecisionEffect extends DecisionEffectBase {
  type: "assign_issue";
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  comment?: string | null;
}

export interface CancelIssueTreeDecisionEffect extends DecisionEffectBase {
  type: "cancel_issue_tree";
  staleness: "strict";
  reasonComment: string;
}

export interface ResolveBlockerDecisionEffect extends DecisionEffectBase {
  type: "resolve_blocker";
  removeBlockedByIssueIds: string[];
}

export type DecisionEffect =
  | CommentOnIssueDecisionEffect
  | CreateIssueDecisionEffect
  | UpdateIssueStatusDecisionEffect
  | AssignIssueDecisionEffect
  | CancelIssueTreeDecisionEffect
  | ResolveBlockerDecisionEffect;

/** The minimum explicit authority needed by each mutating effect. */
export function decisionEffectRequiredCapability(effect: DecisionEffect): DecisionCapability | null {
  switch (effect.type) {
    case "comment_on_issue":
      return null;
    case "create_issue":
    case "assign_issue":
      return "implementation";
    case "update_issue_status":
    case "cancel_issue_tree":
    case "resolve_blocker":
      return "delivery";
  }
}

export function decisionEffectTargetIssueIds(effect: DecisionEffect): string[] {
  const ids = new Set([effect.targetIssueId]);
  if (effect.type === "create_issue") {
    if (effect.draft.parentId) ids.add(effect.draft.parentId);
    for (const id of effect.draft.blockedByIssueIds ?? []) ids.add(id);
  }
  if (effect.type === "resolve_blocker") {
    for (const id of effect.removeBlockedByIssueIds) ids.add(id);
  }
  return [...ids];
}

export interface DecisionOption {
  id: string;
  label: string;
  description?: string | null;
  style?: DecisionOptionStyle;
  effects: DecisionEffect[];
}

export interface DecisionStatsCounts {
  proposed: number;
  accepted: number;
  rejected: number;
  expired: number;
}

export interface DecisionChosenOptionCount {
  optionId: string;
  count: number;
}

export interface DecisionRuleKeyStats extends DecisionStatsCounts {
  ruleKey: string | null;
  chosenOptions: DecisionChosenOptionCount[];
}

export interface DecisionStatsResponse {
  groupBy: "ruleKey";
  filters: {
    originAgentId: string | null;
    since: string | null;
  };
  totals: DecisionStatsCounts;
  groups: DecisionRuleKeyStats[];
}

export interface AttentionArchiveManifestEntry {
  companyId: string;
  sourceKind: string;
  sourceId: string;
  linkedIssueId: string;
  expectedVersion: number;
  activityAt: string;
  reason: string;
}

export interface AttentionArchiveTargetSnapshot {
  status: "attention";
  assigneeAgentId: null;
  assigneeUserId: null;
  updatedAt: string;
  attentionArchive: AttentionArchiveManifestEntry;
}
