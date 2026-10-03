import { AgentId } from '../agents/agent.types';

export interface JarvisApprovalResponse {
  approvalId: string;
  status: string;
  toolId: string;
  intent: string;
  arguments?: unknown;
  requestedAt?: Date;
  expiresAt?: Date | null;
}

export interface JarvisStepResponse {
  toolId: string;
  intent: string;
  result?: unknown;
  error?: string;
  succeeded: boolean;
  approval?: JarvisApprovalResponse;
}

export interface JarvisAskResponseContract {
  message: string;
  agent: AgentId;
  intent: string;
  actions: string[];
  requiresApproval: boolean;
  data: JarvisStepResponse[];
}
