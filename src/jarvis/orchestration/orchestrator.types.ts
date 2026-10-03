import { JarvisStepResponse } from '../contracts/jarvis-response.types';
import { AgentId } from '../agents/agent.types';
import { JarvisRuntimeContext } from '../context/jarvis-runtime-context';

export interface JarvisPlanStep {
  toolId: string;
  intent: string;
  arguments?: unknown;
}

export interface JarvisPlan {
  goal: string;
  agent: AgentId;
  steps: JarvisPlanStep[];
}

export interface OrchestrationInput {
  message: string;
  context: JarvisRuntimeContext;
}

export interface OrchestrationApproval {
  approvalId: string;
  status: string;
  toolId: string;
  intent: string;
  arguments?: unknown;
  requestedAt?: Date;
  expiresAt?: Date | null;
}

export type OrchestrationStepResult = JarvisStepResponse;

export interface OrchestrationResult {
  message: string;
  agent: AgentId;
  goal: string;
  actions: string[];
  requiresApproval: boolean;
  results: OrchestrationStepResult[];
}
