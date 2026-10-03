import { Injectable, UnauthorizedException } from '@nestjs/common';
import { MemoryService } from './memory/memory.service';
import { OrchestratorService } from './orchestration/orchestrator.service';
import { JarvisAskResponseContract } from './contracts/jarvis-response.types';
import { JarvisRuntimeContext } from './context/jarvis-runtime-context';

export interface JarvisAskInput {
  message: string;
  context: JarvisRuntimeContext;
}

@Injectable()
export class JarvisService {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly orchestratorService: OrchestratorService,
  ) {}

  async ask(
    input: JarvisAskInput,
  ): Promise<JarvisAskResponseContract> {
    const message = input.message.trim();

    if (!message) {
      throw new UnauthorizedException(
        'JARVIS requires a message.',
      );
    }

    if (
      !input.context.identity.ownerId ||
      !input.context.identity.userId
    ) {
      throw new UnauthorizedException(
        'User context is required.',
      );
    }

    /*
     * All JARVIS requests flow through the orchestration layer.
     *
     * Merchant-scoped plans are required to carry merchant
     * resource context by the merchant executor. Owner-scoped
     * plans deliberately do not require merchant context.
     *
     * The orchestrator owns planning, permissions, approval
     * creation, execution, and result collection.
     */
    const orchestration =
      await this.orchestratorService.orchestrate({
        message,
        context: input.context,
      });

    this.memoryService.set(
      'last_request',
      {
        message,
        agent: orchestration.agent,
        goal: orchestration.goal,
        actions: orchestration.actions,
        requiresApproval:
          orchestration.requiresApproval,
        timestamp: new Date(),
      },
    );

    const primaryIntent =
      orchestration.results[0]?.intent ??
      'general';

    return {
      message: orchestration.message,
      agent: orchestration.agent,
      intent: primaryIntent,
      actions: orchestration.actions,
      requiresApproval:
        orchestration.requiresApproval,
      data: orchestration.results,
    };
  }
}
