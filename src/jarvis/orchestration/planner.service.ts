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

    if (
      (normalized.includes('routing') || normalized.includes('route') || normalized.includes('gateway selection')) &&
      (normalized.includes('payment') || normalized.includes('gateway'))
    ) {
      return this.createPlan(
        'Review payment routing intelligence and historical gateway performance.',
        'payments',
        [{ toolId: 'payments.routing-intelligence', intent: 'payment-routing-intelligence', arguments: { windowMinutes: 24 * 60 * 30 } }],
      );
    }

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

    if (
      (normalized.includes('why') || normalized.includes('diagnos') || normalized.includes('investigat') || normalized.includes('failed')) &&
      (normalized.includes('deployment') || normalized.includes('deploy') || normalized.includes('vercel'))
    ) {
      return this.createPlan(
        'Diagnose the latest Vercel production deployment using provider evidence and source correlation.',
        'engineering',
        [{
          toolId: 'jarvis.owner.engineering.diagnose-deployment',
          intent: 'diagnose-latest-deployment',
          arguments: {},
        }],
      );
    }

    if (
      (normalized.includes('deploy') || normalized.includes('deployment')) &&
      !normalized.includes('status') &&
      !normalized.includes('check') &&
      !normalized.includes('inspect')
    ) {
      return this.createPlan(
        'Deploy the current frontend to Vercel production.',
        'engineering',
        [
          {
            toolId: 'jarvis.owner.vercel.deploy',
            intent: 'deploy-production',
            arguments: {
              target: 'production',
              ref: normalized.includes('main') ? 'main' : undefined,
            },
          },
        ],
      );
    }

    if (
      (normalized.includes('deployment') || normalized.includes('deploy')) &&
      (normalized.includes('latest') || normalized.includes('status') || normalized.includes('check'))
    ) {
      return this.createPlan(
        'Check the latest Vercel deployment status.',
        'vercel',
        [
          {
            toolId: 'jarvis.owner.vercel.deployment-status',
            intent: 'inspect-deployment',
          },
        ],
      );
    }

    const repositoryFullName = this.extractRepositoryFullName(message);

    const branchMatch = message.match(/(?:branch|ref)\s+["'`]?([^"'`\s]+)["'`]?/i);
    const prMatch = message.match(/(?:pull request|pr)\s+#?(\d+)/i);
    const runMatch = message.match(/(?:workflow|run)\s+#?(\d+)/i);

    if (repositoryFullName && branchMatch && (normalized.includes('inspect') || normalized.includes('status') || normalized.includes('check'))) {
      return this.createPlan(
        'Inspect GitHub branch ' + branchMatch[1] + ' in ' + repositoryFullName + '.',
        'github',
        [{ toolId: 'jarvis.owner.github.branch-inspect', intent: 'inspect-branch', arguments: { repositoryFullName, branchName: branchMatch[1] } }],
      );
    }

    if (repositoryFullName && prMatch && (normalized.includes('inspect') || normalized.includes('status') || normalized.includes('check'))) {
      return this.createPlan(
        'Inspect GitHub pull request #' + prMatch[1] + ' in ' + repositoryFullName + '.',
        'github',
        [{ toolId: 'jarvis.owner.github.pull-request-inspect', intent: 'inspect-pull-request', arguments: { repositoryFullName, prNumber: Number(prMatch[1]) } }],
      );
    }

    if (repositoryFullName && runMatch && (normalized.includes('inspect') || normalized.includes('status') || normalized.includes('check'))) {
      return this.createPlan(
        'Inspect GitHub Actions workflow run #' + runMatch[1] + ' in ' + repositoryFullName + '.',
        'github',
        [{ toolId: 'jarvis.owner.github.workflow-inspect', intent: 'inspect-workflow-run', arguments: { repositoryFullName, runId: Number(runMatch[1]) } }],
      );
    }

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
      (normalized.includes('diagnos') || normalized.includes('why') || normalized.includes('failed')) &&
      (normalized.includes('payment') || normalized.includes('payments') || normalized.includes('checkout') || normalized.includes('transaction') || normalized.includes('gateway'))
    ) {
      return this.createPlan(
        'Diagnose payment failures using provider signatures, gateway concentration and failure timing.',
        'payments',
        [{ toolId: 'payments.failure-diagnosis', intent: 'payment-failure-diagnosis', arguments: { windowMinutes: 60 } }],
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
        [{ toolId: 'payments.recent', intent: 'recent-payments', arguments: { limit: 10 } }],
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
        [{ toolId: 'payments.status', intent: 'payment-status', arguments: { windowMinutes: 60 } }],
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
