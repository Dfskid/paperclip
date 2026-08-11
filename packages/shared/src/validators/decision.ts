import { z } from "zod";
import { ISSUE_STATUSES } from "../constants.js";
import { decisionEffectRequiredCapability, decisionEffectTargetIssueIds } from "../types/decision.js";

export const decisionEffectStalenessSchema = z.enum(["strict", "lenient"]);
export const decisionOptionStyleSchema = z.enum(["default", "primary", "destructive"]);

const decisionEffectBaseShape = {
  targetIssueId: z.string().uuid(),
  staleness: decisionEffectStalenessSchema,
};

export const commentOnIssueDecisionEffectSchema = z.object({
  type: z.literal("comment_on_issue"),
  ...decisionEffectBaseShape,
  bodyMarkdown: z.string().trim().min(1).max(20_000),
}).strict();

export const createIssueDecisionEffectSchema = z.object({
  type: z.literal("create_issue"),
  ...decisionEffectBaseShape,
  draft: z.object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
    assigneeAgentId: z.string().uuid().nullable().optional(),
    assigneeUserId: z.string().trim().min(1).nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    goalId: z.string().uuid().nullable().optional(),
    blockedByIssueIds: z.array(z.string().uuid()).max(100).optional(),
  }).strict(),
}).strict();

export const updateIssueStatusDecisionEffectSchema = z.object({
  type: z.literal("update_issue_status"),
  ...decisionEffectBaseShape,
  status: z.enum(ISSUE_STATUSES),
  comment: z.string().trim().min(1).max(20_000).nullable().optional(),
}).strict();

export const assignIssueDecisionEffectSchema = z.object({
  type: z.literal("assign_issue"),
  ...decisionEffectBaseShape,
  assigneeAgentId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().trim().min(1).nullable().optional(),
  comment: z.string().trim().min(1).max(20_000).nullable().optional(),
}).strict();

export const cancelIssueTreeDecisionEffectSchema = z.object({
  type: z.literal("cancel_issue_tree"),
  targetIssueId: z.string().uuid(),
  staleness: z.literal("strict"),
  reasonComment: z.string().trim().min(1).max(20_000),
}).strict();

export const resolveBlockerDecisionEffectSchema = z.object({
  type: z.literal("resolve_blocker"),
  ...decisionEffectBaseShape,
  removeBlockedByIssueIds: z.array(z.string().uuid()).min(1).max(100),
}).strict();

export const decisionEffectSchema = z.discriminatedUnion("type", [
  commentOnIssueDecisionEffectSchema,
  createIssueDecisionEffectSchema,
  updateIssueStatusDecisionEffectSchema,
  assignIssueDecisionEffectSchema,
  cancelIssueTreeDecisionEffectSchema,
  resolveBlockerDecisionEffectSchema,
]).superRefine((effect, ctx) => {
  if (effect.type === "create_issue" && effect.draft.assigneeAgentId && effect.draft.assigneeUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only one assignee may be set",
      path: ["draft", "assigneeUserId"],
    });
  }

  if (effect.type === "assign_issue") {
    const assigneeCount = Number(Boolean(effect.assigneeAgentId)) + Number(Boolean(effect.assigneeUserId));
    if (assigneeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one assignee must be set",
        path: ["assigneeAgentId"],
      });
    }
  }
});

export const decisionInputSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  placeholder: z.string().max(500).nullable().optional(),
  required: z.boolean().optional(),
  maxLength: z.number().int().positive().max(20_000).optional(),
}).strict();

export const decisionOptionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  description: z.string().max(2_000).nullable().optional(),
  style: decisionOptionStyleSchema.optional(),
  effects: z.array(decisionEffectSchema).max(10),
}).strict().superRefine((option, ctx) => {
  if (option.effects.some((effect) => effect.type === "cancel_issue_tree") && option.style !== "destructive") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Options that cancel an issue tree must use destructive style",
      path: ["style"],
    });
  }
});

export const decisionOptionsSchema = z.array(decisionOptionSchema).min(1).max(8).superRefine((options, ctx) => {
  const seenIds = new Set<string>();
  for (const [index, option] of options.entries()) {
    if (seenIds.has(option.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Decision option ids must be unique",
        path: [index, "id"],
      });
    }
    seenIds.add(option.id);
  }
});

export const decisionInputsSchema = z.array(decisionInputSchema).max(4).superRefine((inputs, ctx) => {
  const seenIds = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    if (seenIds.has(input.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Decision input ids must be unique",
        path: [index, "id"],
      });
    }
    seenIds.add(input.id);
  }
});

export const decisionAuthorityClassSchema = z.enum(["design_approval", "execution_authority"]);
export const decisionCapabilitySchema = z.enum([
  "implementation",
  "money",
  "publish",
  "deploy",
  "delivery",
  "merge",
]);
export const decisionExternalGateSchema = z.enum([
  "github_actor",
  "codeowners_review",
  "branch_protection",
  "required_checks",
  "exact_head",
  "merge_gate",
]);

const decisionGrantIssuerSchema = z.object({
  userId: z.string().trim().min(1).max(240),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("issue"), id: z.string().uuid() }).strict(),
    z.object({ kind: z.literal("decision"), id: z.string().uuid() }).strict(),
  ]),
  issuedAt: z.string().datetime({ offset: true }),
}).strict();

const decisionGrantActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("user"), id: z.string().trim().min(1).max(240) }).strict(),
]);

const decisionGrantBaseShape = {
  schemaVersion: z.literal(1),
  issuer: decisionGrantIssuerSchema,
  actor: decisionGrantActorSchema,
  targetIssueIds: z.array(z.string().uuid()).max(200),
  expiresAt: z.string().datetime({ offset: true }),
};

export const decisionAuthorityGrantSchema = z.discriminatedUnion("authorityClass", [
  z.object({
    ...decisionGrantBaseShape,
    authorityClass: z.literal("design_approval"),
    capabilities: z.array(decisionCapabilitySchema).length(0),
    requiredExternalGates: z.array(decisionExternalGateSchema).length(0),
  }).strict(),
  z.object({
    ...decisionGrantBaseShape,
    authorityClass: z.literal("execution_authority"),
    targetIssueIds: z.array(z.string().uuid()).min(1).max(200),
    capabilities: z.array(decisionCapabilitySchema).min(1).max(6),
    requiredExternalGates: z.array(decisionExternalGateSchema).max(6),
  }).strict(),
]).superRefine((grant, ctx) => {
  if (Date.parse(grant.issuer.issuedAt) >= Date.parse(grant.expiresAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Authority must expire after it is issued", path: ["expiresAt"] });
  }
  for (const [path, values] of [
    [["targetIssueIds"], grant.targetIssueIds],
    [["capabilities"], grant.capabilities],
    [["requiredExternalGates"], grant.requiredExternalGates],
  ] as Array<[(string | number)[], string[]]>) {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate values are not allowed", path });
    }
  }
});

const fullGitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i, "Expected a full 40-character Git SHA");
const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/i, "Expected a SHA-256 fingerprint");

const requiredCheckSchema = z.object({
  runId: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(500),
  appId: z.number().int().nonnegative().nullable(),
  conclusion: z.enum(["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required"]),
  commitSha: fullGitShaSchema,
}).strict();

const reviewSchema = z.object({
  id: z.string().trim().min(1).max(240),
  actor: z.string().trim().min(1).max(240),
  state: z.enum(["approved", "changes_requested", "commented", "dismissed"]),
  commitSha: fullGitShaSchema,
  submittedAt: z.string().datetime({ offset: true }),
}).strict();

export const decisionTechnicalEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal("github"),
  repository: z.object({
    id: z.string().trim().min(1).max(240),
    owner: z.string().trim().min(1).max(240),
    name: z.string().trim().min(1).max(240),
  }).strict(),
  pullRequest: z.object({
    number: z.number().int().positive(),
    baseSha: fullGitShaSchema,
    headSha: fullGitShaSchema,
    mergeCommitSha: fullGitShaSchema.nullable(),
    mergedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  fingerprints: z.object({
    environment: fingerprintSchema,
    configuration: fingerprintSchema,
    branchRules: fingerprintSchema,
  }).strict(),
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  requiredChecks: z.array(requiredCheckSchema).max(200),
  reviews: z.array(reviewSchema).max(200),
}).strict().superRefine((evidence, ctx) => {
  if (Date.parse(evidence.observedAt) >= Date.parse(evidence.expiresAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence must expire after it was observed", path: ["expiresAt"] });
  }
  if ((evidence.pullRequest.mergeCommitSha == null) !== (evidence.pullRequest.mergedAt == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Merge SHA and merged timestamp must be present together", path: ["pullRequest"] });
  }
  if (evidence.pullRequest.mergedAt && Date.parse(evidence.pullRequest.mergedAt) > Date.parse(evidence.observedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Merge timestamp cannot follow evidence observation", path: ["pullRequest", "mergedAt"] });
  }
  for (const [path, records] of [
    [["requiredChecks"], evidence.requiredChecks.map((record) => record.runId)],
    [["reviews"], evidence.reviews.map((record) => record.id)],
  ] as Array<[(string | number)[], string[]]>) {
    if (new Set(records).size !== records.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence record ids must be unique", path });
    }
  }
  evidence.requiredChecks.forEach((check, index) => {
    if (check.commitSha !== evidence.pullRequest.headSha) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Required checks must bind to the exact PR head", path: ["requiredChecks", index, "commitSha"] });
    }
  });
  // Preserve the complete, immutable review history. Provider evaluation only
  // counts the latest exact-head approval for each reviewer; older full-SHA
  // reviews are evidence, not authorization.
});

const externalGateResultSchema = z.object({
  type: decisionExternalGateSchema,
  status: z.enum(["passed", "failed"]),
  evidenceIds: z.array(z.string().trim().min(1).max(500)).min(1).max(200),
}).strict();

const REQUIRED_GITHUB_GATES = [
  "github_actor",
  "codeowners_review",
  "branch_protection",
  "required_checks",
  "exact_head",
  "merge_gate",
] as const;

export const externalEnforcementEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal("github"),
  repositoryId: z.string().trim().min(1).max(240),
  pullRequestNumber: z.number().int().positive(),
  actor: z.string().trim().min(1).max(240),
  headSha: fullGitShaSchema,
  evaluatedAt: z.string().datetime({ offset: true }),
  allowed: z.boolean(),
  gates: z.array(externalGateResultSchema).length(REQUIRED_GITHUB_GATES.length),
}).strict().superRefine((evidence, ctx) => {
  const byType = new Map(evidence.gates.map((gate) => [gate.type, gate]));
  for (const gate of REQUIRED_GITHUB_GATES) {
    if (!byType.has(gate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Missing ${gate} enforcement result`, path: ["gates"] });
    }
  }
  const allPassed = evidence.gates.every((gate) => gate.status === "passed");
  if (evidence.allowed !== allPassed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Allowed must equal the complete external gate result", path: ["allowed"] });
  }
});

export const decisionSpecSchema = z.object({
  authority: decisionAuthorityGrantSchema,
  technicalEvidence: decisionTechnicalEvidenceSchema.nullable().optional(),
  externalEnforcement: externalEnforcementEvidenceSchema.nullable().optional(),
  options: decisionOptionsSchema,
  inputs: decisionInputsSchema.nullable().optional(),
}).strict().superRefine((spec, ctx) => {
  const targetIds = new Set(spec.authority.targetIssueIds);
  for (const [optionIndex, option] of spec.options.entries()) {
    for (const [effectIndex, effect] of option.effects.entries()) {
      for (const id of decisionEffectTargetIssueIds(effect)) {
        if (!targetIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Every effect target must be included in the signed authority scope",
            path: ["options", optionIndex, "effects", effectIndex, "targetIssueId"],
          });
        }
      }

      if (spec.authority.authorityClass === "design_approval") {
        const isSafeComment = effect.type === "comment_on_issue";
        const isBlockedTask = effect.type === "create_issue"
          && !effect.draft.assigneeAgentId
          && !effect.draft.assigneeUserId
          && (effect.draft.blockedByIssueIds?.length ?? 0) > 0;
        if (!isSafeComment && !isBlockedTask) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Design approval may only comment or create an unassigned task blocked by a signed prerequisite",
            path: ["options", optionIndex, "effects", effectIndex],
          });
        }
      } else {
        const capability = decisionEffectRequiredCapability(effect);
        if (capability && !spec.authority.capabilities.includes(capability)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Effect requires ${capability} authority`,
            path: ["options", optionIndex, "effects", effectIndex],
          });
        }
      }
    }
  }

  const hasEvidence = spec.technicalEvidence != null;
  const hasEnforcement = spec.externalEnforcement != null;
  if (hasEvidence !== hasEnforcement) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Technical and external-enforcement evidence must be supplied together", path: ["technicalEvidence"] });
  }
  if (spec.authority.requiredExternalGates.length > 0 && (!hasEvidence || !hasEnforcement)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "External gates require immutable technical evidence", path: ["authority", "requiredExternalGates"] });
  }
  const githubAffecting = spec.authority.capabilities.some((capability) => capability === "merge" || capability === "deploy");
  if (githubAffecting) {
    const missingGate = REQUIRED_GITHUB_GATES.some((gate) => !spec.authority.requiredExternalGates.includes(gate));
    if (!hasEvidence || !hasEnforcement || missingGate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Merge and deploy authority require provider-captured evidence and all GitHub gates",
        path: ["authority", "requiredExternalGates"],
      });
    }
  }
  if (spec.technicalEvidence && spec.externalEnforcement) {
    const expected = spec.technicalEvidence;
    const actual = spec.externalEnforcement;
    if (actual.repositoryId !== expected.repository.id
      || actual.pullRequestNumber !== expected.pullRequest.number
      || actual.headSha !== expected.pullRequest.headSha) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "External enforcement must bind to the same repository, PR, and exact head", path: ["externalEnforcement"] });
    }
    for (const requiredGate of spec.authority.requiredExternalGates) {
      const result = actual.gates.find((gate) => gate.type === requiredGate);
      if (!result || result.status !== "passed") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Required gate ${requiredGate} did not pass`, path: ["externalEnforcement", "gates"] });
      }
    }
  }
});

export type DecisionEffectInput = z.input<typeof decisionEffectSchema>;
export type DecisionOptionInput = z.input<typeof decisionOptionSchema>;
export type DecisionInputInput = z.input<typeof decisionInputSchema>;
export type DecisionAuthorityGrantInput = z.input<typeof decisionAuthorityGrantSchema>;
export type DecisionTechnicalEvidenceInput = z.input<typeof decisionTechnicalEvidenceSchema>;
export type ExternalEnforcementEvidenceInput = z.input<typeof externalEnforcementEvidenceSchema>;
export type DecisionSpecInput = z.input<typeof decisionSpecSchema>;
