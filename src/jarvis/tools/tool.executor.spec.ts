import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CommandCenterService } from '../../command-center/command-center.service';
import { AuditService } from '../audit/audit.service';
import { ApprovalService } from '../approvals/approval.service';
import { PermissionService } from '../permissions/permission.service';
import { ToolRegistry } from './tool.registry';
import { ToolExecutor } from './tool.executor';

describe('ToolExecutor', () => {
  let executor: ToolExecutor;

  let toolRegistry: {
    get: jest.Mock;
  };

  let permissionService: {
    assertCanExecute: jest.Mock;
  };

  let commandCenterService: {
    getOverview: jest.Mock;
  };

  let auditService: {
    start: jest.Mock;
    succeed: jest.Mock;
    fail: jest.Mock;
    deny: jest.Mock;
  };

  let approvalService: {
    consumeForExecution: jest.Mock;
  };

  const approvalTool = {
    id: 'command-center.overview',
    name: 'Command Center Overview',
    description: 'Approval-gated test execution path.',
    permission: 'approval',
    readOnly: false,
  };

  const context = {
    identity: {
      ownerId: 'user-1',
      userId: 'user-1',
    },
    resource: {
      type: 'merchant' as const,
      id: 'merchant-1',
    },
    agent: 'chief-of-staff',
    intent: 'test-approval',
    arguments: {
      message: 'harmless test',
    },
    approved: false,
    approvalId: 'approval-1',
  };

  const execution = {
    id: 'execution-1',
    merchantId: 'merchant-1',
    userId: 'user-1',
    agent: 'chief-of-staff',
    toolId: 'command-center.overview',
    intent: 'test-approval',
    permission: 'approval',
    approved: true,
    status: 'STARTED',
  };

  const overview = {
    merchant: {
      id: 'merchant-1',
      name: 'Merchant One',
    },
    today: {
      totalTransactions: 0,
      paidTransactions: 0,
      grossRevenueCents: 0,
    },
    gateways: [],
    webhooks: {},
    recentPayments: [],
    updatedAt: '2026-09-16T05:00:00.000Z',
  };

  beforeEach(async () => {
    toolRegistry = {
      get: jest.fn().mockReturnValue(approvalTool),
    };

    permissionService = {
      assertCanExecute: jest.fn(),
    };

    commandCenterService = {
      getOverview: jest.fn().mockResolvedValue(overview),
    };

    auditService = {
      start: jest.fn(),
      succeed: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
      deny: jest.fn().mockResolvedValue(undefined),
    };

    approvalService = {
      consumeForExecution: jest.fn(),
    };

    const module: TestingModule =
      await Test.createTestingModule({
        providers: [
          ToolExecutor,
          {
            provide: ToolRegistry,
            useValue: toolRegistry,
          },
          {
            provide: PermissionService,
            useValue: permissionService,
          },
          {
            provide: CommandCenterService,
            useValue: commandCenterService,
          },
          {
            provide: AuditService,
            useValue: auditService,
          },
          {
            provide: ApprovalService,
            useValue: approvalService,
          },
        ],
      }).compile();

    executor = module.get<ToolExecutor>(ToolExecutor);
  });

  it('approved -> executes through the approval service', async () => {
    approvalService.consumeForExecution.mockResolvedValue(
      execution,
    );

    const result = await executor.execute(
      approvalTool.id,
      context,
    );

    expect(result).toEqual(overview);

    expect(
      approvalService.consumeForExecution,
    ).toHaveBeenCalledWith({
      merchantId: 'merchant-1',
      approvalId: 'approval-1',
      toolId: 'command-center.overview',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      userId: 'user-1',
      agent: 'chief-of-staff',
      permission: 'approval',
    });

    expect(
      commandCenterService.getOverview,
    ).toHaveBeenCalledWith('merchant-1');

    expect(auditService.succeed).toHaveBeenCalledWith(
      'execution-1',
      overview,
    );

    expect(
      permissionService.assertCanExecute,
    ).not.toHaveBeenCalled();
  });

  it('caller cannot bypass approval by setting approved=true', async () => {
    approvalService.consumeForExecution.mockRejectedValue(
      new BadRequestException(
        'Approval must be APPROVED before execution.',
      ),
    );

    await expect(
      executor.execute(approvalTool.id, {
        ...context,
        approved: true,
      }),
    ).rejects.toThrow(
      'Approval must be APPROVED before execution.',
    );

    expect(
      approvalService.consumeForExecution,
    ).toHaveBeenCalled();

    expect(
      commandCenterService.getOverview,
    ).not.toHaveBeenCalled();

    expect(auditService.deny).toHaveBeenCalled();
  });

  it('missing approvalId -> rejected before execution', async () => {
    await expect(
      executor.execute(approvalTool.id, {
        ...context,
        approvalId: undefined,
      }),
    ).rejects.toThrow(
      `Tool "${approvalTool.id}" requires an approvalId.`,
    );

    expect(
      approvalService.consumeForExecution,
    ).not.toHaveBeenCalled();

    expect(
      commandCenterService.getOverview,
    ).not.toHaveBeenCalled();

    expect(auditService.deny).toHaveBeenCalled();
  });

  it('approval rejection -> tool is never executed', async () => {
    approvalService.consumeForExecution.mockRejectedValue(
      new BadRequestException(
        'Approval arguments do not match the approved arguments.',
      ),
    );

    await expect(
      executor.execute(approvalTool.id, context),
    ).rejects.toThrow(
      'Approval arguments do not match the approved arguments.',
    );

    expect(
      commandCenterService.getOverview,
    ).not.toHaveBeenCalled();

    expect(auditService.deny).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'merchant-1',
        toolId: 'command-center.overview',
        intent: 'test-approval',
        approved: false,
      }),
      expect.any(BadRequestException),
    );
  });

  it('unexpected approval failure is not converted into a fake denial', async () => {
    const error = new Error('database unavailable');

    approvalService.consumeForExecution.mockRejectedValue(
      error,
    );

    await expect(
      executor.execute(approvalTool.id, context),
    ).rejects.toThrow('database unavailable');

    expect(auditService.deny).not.toHaveBeenCalled();

    expect(
      commandCenterService.getOverview,
    ).not.toHaveBeenCalled();
  });

  it('unknown tool -> rejected before approval processing', async () => {
    toolRegistry.get.mockReturnValue(undefined);

    await expect(
      executor.execute('does.not.exist', context),
    ).rejects.toThrow(NotFoundException);

    expect(
      approvalService.consumeForExecution,
    ).not.toHaveBeenCalled();

    expect(
      commandCenterService.getOverview,
    ).not.toHaveBeenCalled();
  });
});
