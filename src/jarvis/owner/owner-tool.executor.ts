import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PermissionService } from '../permissions/permission.service';
import { ToolRegistry } from '../tools/tool.registry';
import { JarvisRuntimeContext } from '../context/jarvis-runtime-context';
import { OwnerOperationService } from './owner-operation.service';

export interface OwnerToolExecutionContext extends JarvisRuntimeContext {
  agent?: string;
  intent?: string;
  arguments?: unknown;
  approved?: boolean;
}

@Injectable()
export class OwnerToolExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly permissionService: PermissionService,
    private readonly ownerOperationService: OwnerOperationService,
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

    if (tool.permission === 'approval' || tool.permission === 'human-only') {
      throw new ForbiddenException(
        'Owner-scoped JARVIS tool "' + tool.id +
          '" requires an owner authorization path that is not implemented yet.',
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

    try {
      this.permissionService.assertCanExecute(
        tool,
        context.approved ?? false,
      );
    } catch (error) {
      await this.ownerOperationService.deny(operationInput, error);
      throw error;
    }

    const operation =
      await this.ownerOperationService.start(operationInput);

    try {
      const result = await this.executeTool(tool.id, context);
      await this.ownerOperationService.succeed(operation.id, result);
      return result;
    } catch (error) {
      await this.ownerOperationService.fail(operation.id, error);
      throw error;
    }
  }

  private async executeTool(
    toolId: string,
    context: OwnerToolExecutionContext,
  ): Promise<unknown> {
    if (toolId === 'jarvis.owner-test') {
      return {
        ok: true,
        message: 'Owner-scoped JARVIS tool executed successfully.',
        ownerId: context.identity.ownerId,
        arguments: context.arguments ?? null,
      };
    }

    throw new NotFoundException(
      'No owner executor is implemented for JARVIS tool "' + toolId + '".',
    );
  }
}
