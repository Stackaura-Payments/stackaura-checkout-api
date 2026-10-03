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

    const plan = await this.plannerService.plan(message, input.context);

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

  private isEngineeringDiagnosis(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    const deployment = record.deployment;
    const diagnosis = record.diagnosis;
    const remediation = record.remediation;
    return (
      record.provider === 'vercel' &&
      !!deployment && typeof deployment === 'object' &&
      !!diagnosis && typeof diagnosis === 'object' &&
      !!remediation && typeof remediation === 'object'
    );
  }

  private buildEngineeringDiagnosisResponse(diagnosis: Record<string, unknown>): string {
    const deployment = diagnosis.deployment as Record<string, unknown>;
    const diagnosisDetails = diagnosis.diagnosis as Record<string, unknown>;
    const sourceAnalysis = (diagnosis.sourceAnalysis ?? {}) as Record<string, unknown>;
    const remediation = diagnosis.remediation as Record<string, unknown>;
    const evidence = Array.isArray(diagnosis.evidence) ? diagnosis.evidence : [];
    const changedFiles = Array.isArray(sourceAnalysis.changedFiles) ? sourceAnalysis.changedFiles : [];
    const relevantFiles = Array.isArray(sourceAnalysis.relevantFiles) ? sourceAnalysis.relevantFiles : [];
    const findings = Array.isArray(sourceAnalysis.findings) ? sourceAnalysis.findings : [];
    const limitations = Array.isArray(diagnosis.limitations) ? diagnosis.limitations : [];

    const lines = [
      'JARVIS ENGINEERING DIAGNOSIS',
      '',
      `Deployment: ${String(deployment.id ?? 'unknown')}`,
      `State: ${String(deployment.state ?? 'unknown')}`,
      `Revision: ${String(deployment.commitSha ?? 'unknown')}`,
      `Branch: ${String(deployment.branch ?? 'unknown')}`,
      '',
      `Failure domain: ${String(diagnosisDetails.category ?? 'unknown')}`,
      `Root cause: ${String(diagnosisDetails.rootCause ?? 'Not determined')}`,
      `Confidence: ${String(diagnosisDetails.confidence ?? 'unknown')}`,
      `Impact: ${String(diagnosisDetails.impact ?? 'Unknown')}`,
    ];

    if (deployment.errorMessage || deployment.errorCode || deployment.errorStep) {
      lines.push('', 'Deployment error:');
      if (deployment.errorCode) lines.push(`- Code: ${String(deployment.errorCode)}`);
      if (deployment.errorStep) lines.push(`- Step: ${String(deployment.errorStep)}`);
      if (deployment.errorMessage) lines.push(`- Message: ${String(deployment.errorMessage)}`);
    }

    if (findings.length) {
      lines.push('', 'Source findings:');
      findings.slice(0, 8).forEach((finding) => lines.push(`- ${String(finding)}`));
    }

    if (evidence.length) {
      lines.push('', 'Evidence:');
      evidence.slice(0, 8).forEach((item) => {
        if (item && typeof item === 'object') {
          const entry = item as Record<string, unknown>;
          lines.push(`- [${String(entry.confidence ?? 'unknown')}] ${String(entry.source ?? 'source')}: ${String(entry.fact ?? '')}`);
        }
      });
    }

    if (changedFiles.length) {
      lines.push('', 'Changed files:');
      changedFiles.slice(0, 20).forEach((file) => lines.push(`- ${String(file)}`));
    }

    if (relevantFiles.length) {
      lines.push('', 'Relevant source:');
      relevantFiles.slice(0, 20).forEach((file) => lines.push(`- ${String(file)}`));
    }

    lines.push('', `Remediation: ${String(remediation.summary ?? 'No remediation proposed.')}`);
    lines.push(`Exact fix: ${String(remediation.exactFix ?? 'No exact fix determined.')}`);

    const actions = Array.isArray(remediation.actions) ? remediation.actions : [];
    if (actions.length) {
      lines.push('', 'Approval-gated actions:');
      actions.slice(0, 8).forEach((action) => {
        if (action && typeof action === 'object') {
          const entry = action as Record<string, unknown>;
          lines.push(`- ${String(entry.intent ?? entry.toolId ?? 'action')} (approval required)`);
        }
      });
    } else {
      lines.push('', 'No remediation actions were executed.');
    }

    if (limitations.length) {
      lines.push('', 'Limitations:');
      limitations.slice(0, 8).forEach((limitation) => lines.push(`- ${String(limitation)}`));
    }

    return lines.join('\\n');
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

    const diagnosisResult = results.find(
      (result) =>
        result.succeeded &&
        result.toolId === 'jarvis.owner.engineering.diagnose-deployment',
    );

    if (diagnosisResult?.result && this.isEngineeringDiagnosis(diagnosisResult.result)) {
      return this.buildEngineeringDiagnosisResponse(diagnosisResult.result);
    }

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
