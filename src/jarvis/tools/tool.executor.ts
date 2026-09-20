import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  JarvisApprovalStatus,
  Prisma,
} from '@prisma/client';
import { CommandCenterService } from '../../command-center/command-center.service';
import { PermissionService } from '../permissions/permission.service';
import { AuditService } from '../audit/audit.service';
import { ToolRegistry } from './tool.registry';
import { ApprovalService } from '../approvals/approval.service';
import { JarvisRuntimeContext } from '../context/jarvis-runtime-context';

export interface ToolExecutionContext extends JarvisRuntimeContext {
  agent?: string;
  intent?: string;
  arguments?: unknown;
  approved?: boolean;
  approvalId?: string;
}

@Injectable()
export class ToolExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly permissionService: PermissionService,
    private readonly commandCenterService: CommandCenterService,
    private readonly auditService: AuditService,
    private readonly approvalService: ApprovalService,
  ) {}

  async execute(
    toolId: string,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.toolRegistry.get(toolId);

    if (!tool) {
      throw new NotFoundException(
        `JARVIS tool "${toolId}" is not registered.`,
      );
    }

    const auditInput = {
      merchantId: context.merchantId,
      userId: context.userId,
      agent: context.agent ?? 'chief-of-staff',
      toolId,
      intent: context.intent ?? 'unknown',
      permission: tool.permission,
      approved: context.approved ?? false,
      request: {
        toolId,
        intent: context.intent ?? 'unknown',
        arguments: context.arguments,
        approvalId: context.approvalId,
      },
    };

    /*
     * Approval-gated tools MUST use a real approval record.
     *
     * Do this before the generic permission check so an approval
     * cannot be simulated by passing approved=true from a caller.
     */
    if (tool.permission === 'approval') {
      if (!context.approvalId) {
        const error = new BadRequestException(
          `Tool "${tool.id}" requires an approvalId.`,
        );

        await this.auditService.deny(auditInput, error);
        throw error;
      }

      try {
        const execution =
          await this.approvalService.consumeForExecution({
            merchantId: context.merchantId,
            approvalId: context.approvalId,
            toolId,
            intent: context.intent ?? 'unknown',
            arguments: context.arguments,
            userId: context.userId,
            agent: context.agent ?? 'chief-of-staff',
            permission: tool.permission,
          });

        return await this.executeApprovedTool(
          tool.id,
          context,
          execution.id,
        );
      } catch (error) {
        /*
         * consumeForExecution creates the execution audit row only
         * after all approval validation passes.
         *
         * Therefore an approval rejection gets a DENIED audit row.
         */
        if (
          !(error instanceof BadRequestException) &&
          !(error instanceof NotFoundException)
        ) {
          throw error;
        }

        await this.auditService.deny(auditInput, error);
        throw error;
      }
    }

    try {
      this.permissionService.assertCanExecute(
        tool,
        context.approved ?? false,
      );
    } catch (error) {
      await this.auditService.deny(auditInput, error);
      throw error;
    }

    const execution = await this.auditService.start(auditInput);

    try {
      return await this.executeTool(
        tool.id,
        context,
        execution.id,
      );
    } catch (error) {
      await this.auditService.fail(
        execution.id,
        error,
      );

      throw error;
    }
  }

  private async executeApprovedTool(
    toolId: string,
    context: ToolExecutionContext,
    executionId: string,
  ): Promise<unknown> {
    try {
      return await this.executeTool(
        toolId,
        context,
        executionId,
      );
    } catch (error) {
      await this.auditService.fail(
        executionId,
        error,
      );

      throw error;
    }
  }

  private async executeTool(
    toolId: string,
    context: ToolExecutionContext,
    executionId: string,
  ): Promise<unknown> {
    let result: unknown;

    /*
     * Harmless approval-gated test tool.
     *
     * This intentionally does not touch Command Center, Supabase,
     * payments, or any other external system. Its purpose is to
     * verify the complete approval -> execution -> audit workflow.
     */
    if (toolId === 'jarvis.approval-test') {
      result = {
        ok: true,
        message: 'Approval-gated JARVIS tool executed successfully.',
        merchantId: context.merchantId,
        arguments: context.arguments ?? null,
      };
    } else {
      /*
       * Only tools that actually need operational data should
       * query Command Center.
       */
      const overview =
        await this.commandCenterService.getOverview(
          context.merchantId,
        );

      switch (toolId) {
        case 'command-center.overview':
          result = overview;
          break;

        case 'payments.recent':
          result = {
            recentPayments: overview.recentPayments ?? [],
            updatedAt: overview.updatedAt,
          };
          break;

        case 'payments.gateway-health':
          result = {
            gateways: overview.gateways ?? [],
            updatedAt: overview.updatedAt,
          };
          break;

        case 'payments.webhook-health':
          result = {
            webhooks: overview.webhooks ?? {},
            updatedAt: overview.updatedAt,
          };
          break;

        case 'finance.revenue-summary':
          result = {
            today: {
              totalTransactions:
                overview.today?.totalTransactions ?? 0,
              paidTransactions:
                overview.today?.paidTransactions ?? 0,
              grossRevenueCents:
                overview.today?.grossRevenueCents ?? 0,
              platformFeesCents:
                overview.today?.platformFeesCents ?? 0,
              providerFeesCents:
                overview.today?.providerFeesCents ?? 0,
              merchantNetCents:
                overview.today?.merchantNetCents ?? 0,
              successRate:
                overview.today?.successRate ?? 0,
            },
            updatedAt: overview.updatedAt,
          };
          break;

        default:
          throw new NotFoundException(
            `No executor is implemented for JARVIS tool "${toolId}".`,
          );
      }
    }

    await this.auditService.succeed(
      executionId,
      result,
    );

    return result;
  }

}
