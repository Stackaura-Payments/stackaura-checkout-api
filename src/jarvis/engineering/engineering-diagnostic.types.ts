export type DiagnosticConfidence = 'high' | 'medium' | 'low';

export interface EngineeringEvidence {
  source: string;
  fact: string;
  confidence: DiagnosticConfidence;
  data?: Record<string, unknown>;
}

export interface EngineeringDiagnosis {
  provider: 'vercel';
  target: 'production' | 'preview' | 'unknown';
  deployment: {
    id: string;
    state: string;
    createdAt: string;
    url: string;
    commitSha: string | null;
    commitMessage: string | null;
    branch: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    errorStep: string | null;
  };
  evidence: EngineeringEvidence[];
  diagnosis: {
    category: string;
    rootCause: string;
    confidence: DiagnosticConfidence;
    impact: string;
  };
  remediation: {
    summary: string;
    actions: Array<{
      toolId: string;
      intent: string;
      arguments: Record<string, unknown>;
      requiresApproval: true;
    }>;
  };
  limitations: string[];
}
