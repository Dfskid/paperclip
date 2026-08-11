import {
  decisionTechnicalEvidenceSchema,
  externalEnforcementEvidenceSchema,
  type DecisionTechnicalEvidenceV1,
  type ExternalEnforcementEvidenceV1,
} from "@paperclipai/shared";

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
 * Revalidates the complete signed technical state and keeps a provider's gate
 * result as separate evidence. Provider-specific capture and resolution remain
 * outside this authority-contract unit.
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
