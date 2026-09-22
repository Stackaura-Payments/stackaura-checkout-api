import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { AgentRegistry } from '../agents/agent.registry';
import { ToolRegistry } from '../tools/tool.registry';
import { ToolExecutor } from '../tools/tool.executor';
import { OwnerToolExecutor } from '../owner/owner-tool.executor';
import { ApprovalService } from '../approvals/approval.service';
import {
  OrchestrationInput,
  OrchestrationResult,
  OrchestrationStepResult,
} from './orchestrator.types';
import { PlannerService } from './planner.service';

@Injectable()
export class OrchestratorService {
  constructor(
    private readonly plannerService: PlannerService,
    private readonly agentRegistry: AgentRegistry,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly ownerToolExecutor: OwnerToolExecutor,
    private readonly approvalService: ApprovalService,
  ) {}

  async orchestrate(
    input: OrchestrationInput,
  ): Promise<OrchestrationResult> {
    const message = input.message.trim();

    if (!message) {
      throw new BadRequestException(
        'JARVIS requires a message.',
      );
    }

    const plan = this.plannerService.plan(message);

    const agent = this.agentRegistry.get(plan.agent);

    if (!agent || !agent.enabled) {
      throw new BadRequestException(
        `JARVIS agent "${plan.agent}" is unavailable.`,
      );
    }

    const results: OrchestrationStepResult[] = [];
    let requiresApproval = false;

    for (const step of plan.steps) {
      const tool = this.toolRegistry.get(step.toolId);

      if (!tool) {
        throw new BadRequestException(
          `JARVIS tool "${step.toolId}" is not registered.`,
        );
      }

      const agentScope = this.agentRegistry.get(plan.agent)?.scope;

      if (
        tool.scope === 'merchant' &&
        plan.agent !== 'chief-of-staff' &&
        agentScope &&
        agentScope !== 'merchant'
      ) {
        throw new BadRequestException(
          `JARVIS agent "${plan.agent}" cannot execute merchant-scoped tool "${tool.id}".`,
        );
      }

      if (
        tool.scope === 'owner' &&
        plan.agent !== 'chief-of-staff' &&
        agentScope &&
        agentScope !== 'owner'
      ) {
        throw new BadRequestException(
          `JARVIS agent "${plan.agent}" cannot execute owner-scoped tool "${tool.id}".`,
        );
      }

      if (tool.permission === 'human-only') {
        requiresApproval = true;

        results.push({
          toolId: step.toolId,
          intent: step.intent,
          succeeded: false,
          error:
            'This action requires direct human authorization.',
        });

        continue;
      }

      if (tool.permission === 'approval') {
        requiresApproval = true;

        const merchantId =
          this.requireMerchantResource(input.context);

        try {
          const approval =
            await this.approvalService.create({
              merchantId,
              userId: input.context.identity.userId,
              toolId: step.toolId,
              intent: step.intent,
              arguments: step.arguments,
            });

          results.push({
            toolId: step.toolId,
            intent: step.intent,
            succeeded: false,
            error:
              'This action requires approval before execution.',
            approval: {
              approvalId: approval.id,
              status: approval.status,
              toolId: approval.toolId,
              intent: approval.intent,
              arguments: approval.arguments,
              requestedAt: approval.requestedAt,
              expiresAt: approval.expiresAt,
            },
          });
        } catch (error) {
          results.push({
            toolId: step.toolId,
            intent: step.intent,
            succeeded: false,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          });
        }

        continue;
      }

      try {
        const executionContext = {
          identity: input.context.identity,
          resource: input.context.resource,
          agent: plan.agent,
          intent: step.intent,
          arguments: step.arguments,
          approved: false,
        };

        const result =
          tool.scope === 'owner'
            ? await this.ownerToolExecutor.execute(
                step.toolId,
                executionContext,
              )
            : await this.toolExecutor.execute(
                step.toolId,
                executionContext,
              );

        results.push({
          toolId: step.toolId,
          intent: step.intent,
          result,
          succeeded: true,
        });
      } catch (error) {
        results.push({
          toolId: step.toolId,
          intent: step.intent,
          succeeded: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    }

    return {
      message: this.buildResponse(
        plan.goal,
        plan.agent,
        results,
        requiresApproval,
      ),
      agent: plan.agent,
      goal: plan.goal,
      actions: plan.steps.map(
        (step) => step.toolId,
      ),
      requiresApproval,
      results,
    };
  }

  private requireMerchantResource(
    context: OrchestrationInput['context'],
  ): string {
    if (
      !context.resource ||
      context.resource.type !== 'merchant' ||
      !context.resource.id
    ) {
      throw new BadRequestException(
        'Merchant resource context is required for this operation.',
      );
    }

    return context.resource.id;
  }

  private buildResponse(
    goal: string,
    agent: string,
    results: OrchestrationStepResult[],
    requiresApproval: boolean,
  ): string {
    const successful = results.filter(
      (result) => result.succeeded,
    ).length;

    const failed = results.filter(
      (result) => !result.succeeded,
    ).length;

    const lines = [
      `JARVIS completed the ${agent} investigation.`,
      '',
      `Objective: ${goal}`,
      '',
      `Steps completed: ${successful}`,
    ];

    if (failed > 0) {
      lines.push(
        `Steps requiring attention: ${failed}`,
      );
    }

    if (requiresApproval) {
      lines.push(
        '',
        'One or more planned actions require approval or direct human authorization.',
      );
    } else {
      lines.push(
        '',
        'No approval-gated actions were executed.',
      );
    }

    return lines.join('\n');
  }
}
