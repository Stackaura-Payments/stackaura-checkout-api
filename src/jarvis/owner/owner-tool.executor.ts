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
  ) {}

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
    if (toolId === 'jarvis.owner.vercel.deployment-status') {
      return this.vercelOwnerService.getLatestDeployment();
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
