import { BadRequestException, Injectable } from '@nestjs/common';
import { AgentRegistry } from '../agents/agent.registry';
import { AgentId } from '../agents/agent.types';
import { ToolRegistry } from '../tools/tool.registry';
import { JarvisPlan } from './orchestrator.types';

@Injectable()
export class PlannerService {
  constructor(
    private readonly agentRegistry: AgentRegistry,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  plan(message: string): JarvisPlan {
    const normalized = message.trim().toLowerCase();

    if (!normalized) {
      throw new BadRequestException(
        'JARVIS requires a message.',
      );
    }

    /*
     * Milestone 4.3B:
     * approval-required actions are now planned here.
     *
     * The planner selects the action. The orchestrator decides
     * whether that action can execute based on the registered
     * tool permission.
     */
    if (
      normalized.includes('approval test') ||
      normalized.includes('test approval') ||
      normalized.includes('approval workflow')
    ) {
      return this.createPlan(
        'Run the JARVIS approval workflow test.',
        'chief-of-staff',
        [
          {
            toolId: 'jarvis.approval-test',
            intent: 'approval-test',
            arguments: {
              message: message.trim(),
            },
          },
        ],
      );
    }

    const repositoryFullName = this.extractRepositoryFullName(message);

    if (
      repositoryFullName &&
      (normalized.includes('status') || normalized.includes('check') || normalized.includes('inspect'))
    ) {
      return this.createPlan(
        `Check the GitHub repository status for ${repositoryFullName}.`,
        'github',
        [
          {
            toolId: 'jarvis.owner.github.repository-status',
            intent: 'inspect-repository',
            arguments: { repositoryFullName },
          },
        ],
      );
    }

    /*
     * Milestone 4.1 intentionally uses a deterministic planner.
     *
     * This is the contract that a future LLM planner will satisfy.
     * The planner may select only registered agents and tools.
     */

    if (
      normalized.includes('why') &&
      (
        normalized.includes('payment') ||
        normalized.includes('payments') ||
        normalized.includes('checkout') ||
        normalized.includes('transaction')
      )
    ) {
      return this.createPlan(
        'Investigate payment operations and identify potential issues.',
        'payments',
        [
          {
            toolId: 'command-center.overview',
            intent: 'status',
          },
          {
            toolId: 'payments.gateway-health',
            intent: 'gateway-health',
          },
          {
            toolId: 'payments.webhook-health',
            intent: 'webhook-health',
          },
          {
            toolId: 'payments.recent',
            intent: 'recent-payments',
          },
        ],
      );
    }

    if (
      normalized.includes('payment') ||
      normalized.includes('payments') ||
      normalized.includes('transaction') ||
      normalized.includes('gateway')
    ) {
      return this.createPlan(
        'Review current payment operations.',
        'payments',
        [
          {
            toolId: 'command-center.overview',
            intent: 'status',
          },
          {
            toolId: 'payments.gateway-health',
            intent: 'gateway-health',
          },
        ],
      );
    }

    if (
      normalized.includes('revenue') ||
      normalized.includes('financial') ||
      normalized.includes('finance') ||
      normalized.includes('money')
    ) {
      return this.createPlan(
        'Review current financial performance.',
        'finance',
        [
          {
            toolId: 'finance.revenue-summary',
            intent: 'revenue',
          },
        ],
      );
    }

    if (
      normalized.includes('webhook')
    ) {
      return this.createPlan(
        'Review webhook delivery health.',
        'payments',
        [
          {
            toolId: 'payments.webhook-health',
            intent: 'webhook-health',
          },
        ],
      );
    }

    if (
      normalized.includes('recent payment') ||
      normalized.includes('recent transaction') ||
      normalized.includes('latest payment') ||
      normalized.includes('latest transaction')
    ) {
      return this.createPlan(
        'Review recent payment activity.',
        'payments',
        [
          {
            toolId: 'payments.recent',
            intent: 'recent-payments',
          },
        ],
      );
    }

    if (
      normalized.includes('status') ||
      normalized.includes('overview') ||
      normalized.includes('what is happening') ||
      normalized.includes("what's happening") ||
      normalized.includes('how is stackaura')
    ) {
      return this.createPlan(
        'Review the current Stackaura operational status.',
        'chief-of-staff',
        [
          {
            toolId: 'command-center.overview',
            intent: 'status',
          },
        ],
      );
    }

    return this.createPlan(
      'Understand and route the request.',
      'chief-of-staff',
      [],
    );
  }

  private extractRepositoryFullName(message: string): string | undefined {
    const candidate = message.split(' ').find((token) => token.includes('/'));
    return candidate?.replace(/[.,!?]+$/, '');
  }

  private createPlan(
    goal: string,
    agent: AgentId,
    steps: JarvisPlan['steps'],
  ): JarvisPlan {
    const registeredAgent = this.agentRegistry.get(agent);

    if (!registeredAgent || !registeredAgent.enabled) {
      throw new BadRequestException(
        `JARVIS agent "${agent}" is unavailable.`,
      );
    }

    for (const step of steps) {
      const tool = this.toolRegistry.get(step.toolId);

      if (!tool) {
        throw new BadRequestException(
          `JARVIS planned tool "${step.toolId}" is not registered.`,
        );
      }
    }

    return {
      goal,
      agent,
      steps,
    };
  }
}
