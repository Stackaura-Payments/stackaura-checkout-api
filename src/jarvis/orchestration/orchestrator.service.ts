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
import { ActionLifecycleService } from '../owner/action-lifecycle.service';

@Injectable()
export class OrchestratorService {
  constructor(
    private readonly plannerService: PlannerService,
    private readonly agentRegistry: AgentRegistry,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly ownerToolExecutor: OwnerToolExecutor,
    private readonly approvalService: ApprovalService,
    private readonly actionLifecycleService: ActionLifecycleService,
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

        if (tool.scope === 'owner') {
          try {
            const proposal = await this.actionLifecycleService.propose({
              ownerId: input.context.identity.ownerId,
              requestedByUserId: input.context.identity.userId,
              toolId: step.toolId,
              intent: step.intent,
              arguments: this.resolveOwnerArguments(step.toolId, step.arguments),
              riskLevel: this.riskLevelFor(step.toolId),
            });

            results.push({
              toolId: step.toolId,
              intent: step.intent,
              succeeded: false,
              error: 'This owner action requires approval before execution.',
              approval: {
                approvalId: proposal.approval.id,
                status: proposal.approval.status,
                toolId: proposal.approval.toolId,
                intent: proposal.approval.intent,
                arguments: proposal.approval.arguments,
                requestedAt: proposal.approval.requestedAt,
                expiresAt: proposal.approval.expiresAt,
              },
            });
          } catch (error) {
            results.push({
              toolId: step.toolId,
              intent: step.intent,
              succeeded: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          continue;
        }

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

  private resolveOwnerArguments(toolId: string, argumentsValue: unknown): unknown {
    if (toolId !== 'jarvis.owner.vercel.deploy') return argumentsValue;

    const source = argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
      ? { ...(argumentsValue as Record<string, unknown>) }
      : {};
    const projectId = process.env.VERCEL_PROJECT_ID?.trim();
    if (!projectId) {
      throw new BadRequestException('Vercel project is not configured for JARVIS.');
    }
    return {
      projectId,
      target: source.target ?? 'production',
      ...(source.ref ? { ref: source.ref } : {}),
    };
  }

  private riskLevelFor(toolId: string): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    if (toolId === 'jarvis.owner.github.delete-branch') return 'MEDIUM';
    if (toolId === 'jarvis.owner.github.merge-pull-request') return 'HIGH';
    if (toolId === 'jarvis.owner.vercel.deploy') return 'HIGH';
    if (toolId === 'jarvis.owner.github.update-file') return 'HIGH';
    if (toolId === 'jarvis.owner.payments.failover') return 'HIGH';
    if (toolId === 'jarvis.owner.github.rerun-workflow') return 'MEDIUM';
    return 'MEDIUM';
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
