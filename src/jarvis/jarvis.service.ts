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

    if (!input.context.userId) {
      throw new UnauthorizedException(
        'User context is required.',
      );
    }

    /*
     * Current operational tools are merchant-backed.
     *
     * Keep that requirement explicit at the service boundary
     * while allowing the broader JARVIS runtime context to
     * eventually operate without a merchant resource.
     */
    if (!input.context.merchantId) {
      throw new UnauthorizedException(
        'Merchant context is required.',
      );
    }

    /*
     * All JARVIS requests flow through the orchestration layer.
     *
     * The orchestrator owns planning, permissions,
     * approval creation, execution, and result collection.
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
