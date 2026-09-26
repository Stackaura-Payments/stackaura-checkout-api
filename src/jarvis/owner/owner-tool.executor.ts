import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JarvisOwnerOperationStatus } from '@prisma/client';
import { PermissionService } from '../permissions/permission.service';
import { ToolRegistry } from '../tools/tool.registry';
import { JarvisRuntimeContext } from '../context/jarvis-runtime-context';
import { OwnerOperationService } from './owner-operation.service';
import { GitHubOwnerService } from './github-owner.service';
import { VercelOwnerService } from './vercel-owner.service';
import { OwnerApprovalService } from '../approvals/owner-approval.service';
import { EngineeringDiagnosticService } from '../engineering/engineering-diagnostic.service';
import { EngineeringRepairWorkflowService } from '../engineering/engineering-repair-workflow.service';
import { PaymentsService } from '../../payments/payments.service';

const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface OwnerToolExecutionContext extends JarvisRuntimeContext {
  agent?: string;
  intent?: string;
  arguments?: unknown;
  approved?: boolean;
  approvalId?: string;
}

@Injectable()
export class OwnerToolExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly permissionService: PermissionService,
    private readonly ownerOperationService: OwnerOperationService,
    private readonly githubOwnerService: GitHubOwnerService,
    private readonly vercelOwnerService: VercelOwnerService,
    private readonly ownerApprovalService: OwnerApprovalService,
    private readonly engineeringDiagnosticService: EngineeringDiagnosticService,
    private readonly engineeringRepairWorkflowService: EngineeringRepairWorkflowService,
    private readonly paymentsService: PaymentsService,
  ) {}

  getRecoveryPlan(toolId: string, argumentsValue: unknown): Record<string, unknown> {
    const args = this.requireObject(argumentsValue);
    if (toolId === 'jarvis.owner.payments.failover') {
      const reference = this.requireString(args.reference, 'reference');
      return {
        strategy: 'retry-failover-after-provider-rejection',
        executable: true,
        approvalRequired: true,
        toolId: 'jarvis.owner.payments.failover',
        intent: 'recover-payment-failover-' + reference,
        arguments: {
          merchantId: this.requireString(args.merchantId, 'merchantId'),
          reference,
        },
        reason: 'Retry the governed gateway failover only after a fresh owner recovery approval. Stackaura routing will select the next eligible gateway and the result will be independently verified.',
        note: 'Recovery is a new approval-gated mutation attempt; the original approval is never reused after provider rejection or failed verification.',
      };
    }
    if (!toolId.startsWith('jarvis.owner.github.')) {
      return { strategy: 'manual-review', executable: false, approvalRequired: true };
    }
    return this.githubOwnerService.getRecoveryPlan(toolId, args);
  }

  async verify(toolId: string, argumentsValue: unknown, result?: unknown): Promise<Record<string, unknown>> {
    const args = this.requireObject(argumentsValue);
    if (toolId === 'jarvis.owner.payments.failover') {
      const merchantId = this.requireString(args.merchantId, 'merchantId');
      const reference = this.requireString(args.reference, 'reference');
      const payment = await this.paymentsService.getPaymentByReference(merchantId, reference);
      const record = payment as Record<string, unknown>;
      const verified = record.status === 'PENDING' && record.gateway !== null && record.gateway !== undefined;
      return { verified, mode: 'payment-state-and-gateway-attempt', merchantId, reference, status: record.status, gateway: record.gateway, checkedAt: new Date().toISOString() };
    }
    if (!toolId.startsWith('jarvis.owner.github.')) {
      throw new BadRequestException('JARVIS provider verification is not available for this tool.');
    }
    return this.githubOwnerService.verifyMutation(toolId, args, result);
  }

  async executeApprovedRecovery(
    toolId: string,
    context: OwnerToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.toolRegistry.get(toolId);
    if (!tool) throw new NotFoundException('JARVIS tool "' + toolId + '" is not registered.');
    if (tool.scope !== 'owner' || tool.permission !== 'approval') {
      throw new BadRequestException('Recovery execution requires an owner-scoped approval-gated tool.');
    }
    if (!context.identity.ownerId || !context.identity.userId || context.identity.ownerId !== context.identity.userId) {
      throw new BadRequestException('JARVIS recovery execution requires the authenticated owner identity.');
    }
    return this.executeTool(tool.id, context);
  }

  async execute(
    toolId: string,
    context: OwnerToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.toolRegistry.get(toolId);

    if (!tool) {
      throw new NotFoundException(
        'JARVIS tool "' + toolId + '" is not registered.',
      );
    }

    if (tool.scope !== 'owner') {
      throw new BadRequestException(
        'JARVIS tool "' + tool.id + '" is not owner-scoped.',
      );
    }

    if (!context.identity.ownerId || !context.identity.userId) {
      throw new BadRequestException(
        'JARVIS owner execution requires an authenticated owner identity.',
      );
    }

    if (tool.permission === 'human-only') {
      throw new ForbiddenException(
        'Owner-scoped JARVIS tool "' + tool.id + '" requires direct human authorization.',
      );
    }

    const operationInput = {
      ownerId: context.identity.ownerId,
      userId: context.identity.userId,
      agent: context.agent ?? 'chief-of-staff',
      toolId: tool.id,
      intent: context.intent ?? 'unknown',
      permission: tool.permission,
      approved: context.approved ?? false,
      request: {
        toolId: tool.id,
        intent: context.intent ?? 'unknown',
        arguments: context.arguments,
      },
    };

    if (tool.permission === 'approval') {
      if (!context.approvalId) {
        const error = new BadRequestException(
          'Owner approval is required before this JARVIS action can execute.',
        );
        await this.ownerOperationService.deny(operationInput, error);
        throw error;
      }

      const execution = await this.ownerApprovalService.consumeForExecution({
        ownerId: context.identity.ownerId,
        approvalId: context.approvalId,
        toolId: tool.id,
        intent: context.intent ?? 'unknown',
        arguments: context.arguments,
        userId: context.identity.userId,
        agent: context.agent ?? 'chief-of-staff',
        permission: tool.permission,
      });

      try {
        const result = await this.executeTool(tool.id, context);
        const sanitizedResult = this.sanitizeOutput(result);
        await this.ownerOperationService.succeed(execution.id, sanitizedResult);
        return sanitizedResult;
      } catch (error) {
        await this.ownerOperationService.fail(execution.id, error);
        throw error;
      }
    }

    try {
      this.permissionService.assertCanExecute(tool, context.approved ?? false);
    } catch (error) {
      await this.ownerOperationService.deny(operationInput, error);
      throw error;
    }

    const operation = await this.ownerOperationService.start(operationInput);

    try {
      const result = await this.executeTool(tool.id, context);
      const sanitizedResult = this.sanitizeOutput(result);
      await this.ownerOperationService.succeed(operation.id, sanitizedResult);
      return sanitizedResult;
    } catch (error) {
      await this.ownerOperationService.fail(operation.id, error);
      throw error;
    }
  }

  private async executeTool(
    toolId: string,
    context: OwnerToolExecutionContext,
  ): Promise<unknown> {

    if (toolId === 'jarvis.owner.payments.failover') {
      const args = this.requireObject(context.arguments);
      return this.paymentsService.failoverPayment(
        this.requireString(args.merchantId, 'merchantId'),
        this.requireString(args.reference, 'reference'),
      );
    }

    if (toolId === 'jarvis.owner.vercel.deploy') {
      const args = this.requireObject(context.arguments);
      const projectId = this.requireString(args.projectId, 'projectId');
      const target = args.target === undefined ? 'production' : this.requireEnum(args.target, ['production', 'preview'] as const, 'target');
      const ref = args.ref === undefined ? undefined : this.requireString(args.ref, 'ref');
      return this.vercelOwnerService.deploy({ projectId, target, ref });
    }

    if (toolId === 'jarvis.owner.github.update-file') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.updateFile({
        repositoryFullName: this.requireString(args.repositoryFullName, 'repositoryFullName'),
        path: this.requireString(args.path, 'path'),
        content: this.requireString(args.content, 'content'),
        message: this.requireString(args.message, 'message'),
        sha: this.requireString(args.sha, 'sha'),
        branch: args.branch === undefined ? undefined : this.requireString(args.branch, 'branch'),
      });
    }

    if (toolId === 'jarvis.owner.github.create-branch') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.createBranch({
        repositoryFullName: this.requireString(args.repositoryFullName, 'repositoryFullName'),
        branchName: this.requireString(args.branchName, 'branchName'),
        sha: this.requireString(args.sha, 'sha'),
      });
    }

    if (toolId === 'jarvis.owner.github.delete-branch') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.deleteBranch({
        repositoryFullName: this.requireString(args.repositoryFullName, 'repositoryFullName'),
        branchName: this.requireString(args.branchName, 'branchName'),
      });
    }

    if (toolId === 'jarvis.owner.github.merge-pull-request') {
      const args = this.requireObject(context.arguments);
      const method = args.mergeMethod === undefined ? 'squash' : this.requireEnum(args.mergeMethod, ['merge', 'squash', 'rebase'] as const, 'mergeMethod');
      return this.githubOwnerService.mergePullRequest({
        repositoryFullName: this.requireString(args.repositoryFullName, 'repositoryFullName'),
        prNumber: this.requireInteger(args.prNumber, 'prNumber'),
        mergeMethod: method,
      });
    }

    if (toolId === 'jarvis.owner.github.rerun-workflow') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.rerunWorkflowJob({
        repositoryFullName: this.requireString(args.repositoryFullName, 'repositoryFullName'),
        jobId: this.requireInteger(args.jobId, 'jobId'),
      });
    }

    if (toolId === 'jarvis.owner.vercel.deployment-status') {
      return this.vercelOwnerService.getLatestDeployment();
    }

    if (toolId === 'jarvis.owner.engineering.repair') {
      const args = this.requireObject(context.arguments);
      return this.engineeringRepairWorkflowService.execute(
        context.identity.ownerId,
        this.requireString(args.repairId, 'repairId'),
      );
    }

    if (toolId === 'jarvis.owner.engineering.diagnose-deployment') {
      return context.arguments && typeof context.arguments === 'object'
        ? await this.engineeringDiagnosticService.diagnoseLatestVercelDeployment()
        : await this.engineeringDiagnosticService.diagnoseLatestVercelDeployment();
    }

    if (toolId === 'jarvis.owner.github.branch-inspect') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.getBranchSnapshot(
        this.requireString(args.repositoryFullName, 'repositoryFullName'),
        this.requireString(args.branchName, 'branchName'),
      );
    }

    if (toolId === 'jarvis.owner.github.file-inspect') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.getFile(
        this.requireString(args.repositoryFullName, 'repositoryFullName'),
        this.requireString(args.path, 'path'),
        args.ref === undefined ? undefined : this.requireString(args.ref, 'ref'),
      );
    }

    if (toolId === 'jarvis.owner.github.commit-inspect') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.getCommitSnapshot(
        this.requireString(args.repositoryFullName, 'repositoryFullName'),
        this.requireString(args.sha, 'sha'),
      );
    }

    if (toolId === 'jarvis.owner.github.compare') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.getCompareSnapshot(
        this.requireString(args.repositoryFullName, 'repositoryFullName'),
        this.requireString(args.base, 'base'),
        this.requireString(args.head, 'head'),
      );
    }

    if (toolId === 'jarvis.owner.github.pull-request-inspect') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.getPullRequest(
        this.requireString(args.repositoryFullName, 'repositoryFullName'),
        this.requireInteger(args.prNumber, 'prNumber'),
      );
    }

    if (toolId === 'jarvis.owner.github.workflow-inspect') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.getWorkflowRun(
        this.requireString(args.repositoryFullName, 'repositoryFullName'),
        this.requireInteger(args.runId, 'runId'),
      );
    }

    if (toolId === 'jarvis.owner.github.create-pull-request') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.createPullRequest({
        repositoryFullName: this.requireString(args.repositoryFullName, 'repositoryFullName'),
        title: this.requireString(args.title, 'title'),
        body: args.body === undefined ? undefined : this.requireString(args.body, 'body'),
        head: this.requireString(args.head, 'head'),
        base: this.requireString(args.base, 'base'),
        draft: args.draft === undefined ? undefined : Boolean(args.draft),
      });
    }

    if (toolId === 'jarvis.owner.github.close-pull-request') {
      const args = this.requireObject(context.arguments);
      return this.githubOwnerService.closePullRequest({
        repositoryFullName: this.requireString(args.repositoryFullName, 'repositoryFullName'),
        prNumber: this.requireInteger(args.prNumber, 'prNumber'),
      });
    }

    if (toolId === 'jarvis.owner.github.repository-status') {
      const args =
        context.arguments && typeof context.arguments === 'object'
          ? (context.arguments as Record<string, unknown>)
          : {};
      const repositoryFullName =
        typeof args.repositoryFullName === 'string'
          ? args.repositoryFullName.trim()
          : '';

      if (!GITHUB_REPOSITORY_PATTERN.test(repositoryFullName)) {
        throw new BadRequestException(
          'GitHub repository must use the owner/name format.',
        );
      }

      return this.githubOwnerService.getRepositoryStatus(repositoryFullName);
    }

    if (toolId === 'jarvis.owner-operations.list') {
      const argumentsObject =
        context.arguments && typeof context.arguments === 'object'
          ? (context.arguments as Record<string, unknown>)
          : {};

      const limit =
        typeof argumentsObject.limit === 'number'
          ? Math.min(Math.max(Math.trunc(argumentsObject.limit), 1), 100)
          : undefined;

      const status =
        typeof argumentsObject.status === 'string' &&
        Object.values(JarvisOwnerOperationStatus).includes(
          argumentsObject.status as JarvisOwnerOperationStatus,
        )
          ? (argumentsObject.status as JarvisOwnerOperationStatus)
          : undefined;

      const operations = await this.ownerOperationService.list({
        ownerId: context.identity.ownerId,
        userId: context.identity.userId,
        status,
        agent:
          typeof argumentsObject.agent === 'string'
            ? argumentsObject.agent
            : undefined,
        toolId:
          typeof argumentsObject.toolId === 'string'
            ? argumentsObject.toolId
            : undefined,
        limit,
      });

      return this.sanitizeOutput(operations);
    }

    throw new NotFoundException(
      'No owner executor is implemented for JARVIS tool "' + toolId + '".',
    );
  }


  private requireObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('JARVIS tool arguments must be a JSON object.');
    }
    return value as Record<string, unknown>;
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(field + ' must be a non-empty string.');
    }
    return value.trim();
  }

  private requireInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new BadRequestException(field + ' must be an integer.');
    }
    return value;
  }

  private requireEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new BadRequestException(field + ' is invalid.');
    }
    return value as T[number];
  }

  private sanitizeOutput(value: unknown): unknown {
    try {
      return JSON.parse(
        JSON.stringify(value, (key, currentValue) => {
          if (
            typeof currentValue === 'string' &&
            /password|secret|token|private.?key|api.?key/i.test(key)
          ) {
            return '[REDACTED]';
          }
          return currentValue;
        }),
      );
    } catch {
      return { value: '[UNSERIALIZABLE]' };
    }
  }
}
