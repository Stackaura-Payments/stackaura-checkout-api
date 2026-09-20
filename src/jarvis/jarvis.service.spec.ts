import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MemoryService } from './memory/memory.service';
import { OrchestratorService } from './orchestration/orchestrator.service';
import { JarvisService } from './jarvis.service';

describe('JarvisService', () => {
  let service: JarvisService;

  const memoryService = {
    set: jest.fn(),
  };

  const orchestratorService = {
    orchestrate: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule =
      await Test.createTestingModule({
        providers: [
          JarvisService,
          {
            provide: MemoryService,
            useValue: memoryService,
          },
          {
            provide: OrchestratorService,
            useValue: orchestratorService,
          },
        ],
      }).compile();

    service = module.get<JarvisService>(
      JarvisService,
    );
  });

  it('rejects an empty message', async () => {
    await expect(
      service.ask({
        message: '   ',
        context: {
          ownerId: 'user-1',
          userId: 'user-1',
          merchantId: 'merchant-1',
        },
      }),
    ).rejects.toThrow(
      new UnauthorizedException(
        'JARVIS requires a message.',
      ),
    );

    expect(
      orchestratorService.orchestrate,
    ).not.toHaveBeenCalled();
  });

  it('rejects missing merchant context', async () => {
    await expect(
      service.ask({
        message: 'Check Stackaura',
        context: {
          ownerId: 'user-1',
          userId: 'user-1',
          merchantId: '',
        },
      }),
    ).rejects.toThrow(
      new UnauthorizedException(
        'Merchant context is required.',
      ),
    );

    expect(
      orchestratorService.orchestrate,
    ).not.toHaveBeenCalled();
  });

  it('routes an operational request through the orchestrator', async () => {
    orchestratorService.orchestrate.mockResolvedValue({
      message:
        'JARVIS completed the payments investigation.',
      agent: 'payments',
      goal: 'Review current payment operations.',
      actions: [
        'command-center.overview',
        'payments.gateway-health',
      ],
      requiresApproval: false,
      results: [
        {
          toolId: 'command-center.overview',
          intent: 'status',
          succeeded: true,
          result: {
            today: {
              totalTransactions: 10,
            },
          },
        },
        {
          toolId: 'payments.gateway-health',
          intent: 'gateway-health',
          succeeded: true,
          result: {
            gateways: [],
          },
        },
      ],
    });

    const result = await service.ask({
      message: 'Check payment health.',
      context: {
        ownerId: 'user-1',
        userId: 'user-1',
        merchantId: 'merchant-1',
      },
    });

    expect(
      orchestratorService.orchestrate,
    ).toHaveBeenCalledTimes(1);

    expect(
      orchestratorService.orchestrate,
    ).toHaveBeenCalledWith({
      message: 'Check payment health.',
      context: {
        ownerId: 'user-1',
        userId: 'user-1',
        merchantId: 'merchant-1',
      },
    });

    expect(result).toEqual({
      message:
        'JARVIS completed the payments investigation.',
      agent: 'payments',
      intent: 'status',
      actions: [
        'command-center.overview',
        'payments.gateway-health',
      ],
      requiresApproval: false,
      data: [
        {
          toolId: 'command-center.overview',
          intent: 'status',
          succeeded: true,
          result: {
            today: {
              totalTransactions: 10,
            },
          },
        },
        {
          toolId: 'payments.gateway-health',
          intent: 'gateway-health',
          succeeded: true,
          result: {
            gateways: [],
          },
        },
      ],
    });

    expect(
      memoryService.set,
    ).toHaveBeenCalledWith(
      'last_request',
      expect.objectContaining({
        message: 'Check payment health.',
      }),
    );
  });

  it('passes merchant and user identity to orchestration', async () => {
    orchestratorService.orchestrate.mockResolvedValue({
      message: 'Status checked.',
      agent: 'chief-of-staff',
      goal: 'Review the current Stackaura operational status.',
      actions: ['command-center.overview'],
      requiresApproval: false,
      results: [],
    });

    await service.ask({
      message: 'What is happening?',
      context: {
        ownerId: 'user-xyz',
        userId: 'user-xyz',
        merchantId: 'merchant-abc',
      },
    });

    expect(
      orchestratorService.orchestrate,
    ).toHaveBeenCalledWith({
      message: 'What is happening?',
      context: {
        ownerId: 'user-xyz',
        userId: 'user-xyz',
        merchantId: 'merchant-abc',
      },
    });
  });

  it('routes approval-gated requests through the orchestrator', async () => {
    orchestratorService.orchestrate.mockResolvedValue({
      message:
        'Approval is required before I can execute "jarvis.approval-test".',
      agent: 'chief-of-staff',
      goal: 'Run the JARVIS approval workflow test.',
      actions: ['jarvis.approval-test'],
      requiresApproval: true,
      results: [
        {
          toolId: 'jarvis.approval-test',
          intent: 'approval-test',
          succeeded: false,
          error:
            'This action requires approval before execution.',
          approval: {
            approvalId: 'approval-123',
            status: 'PENDING',
            toolId: 'jarvis.approval-test',
            intent: 'approval-test',
            arguments: {
              message: 'Run the approval workflow test',
            },
            requestedAt: new Date('2026-09-16T00:00:00.000Z'),
            expiresAt: null,
          },
        },
      ],
    });

    const result = await service.ask({
      message: 'Run the approval workflow test',
      context: {
        ownerId: 'user-1',
        userId: 'user-1',
        merchantId: 'merchant-1',
      },
    });

    expect(
      orchestratorService.orchestrate,
    ).toHaveBeenCalledWith({
      message: 'Run the approval workflow test',
      context: {
        ownerId: 'user-1',
        userId: 'user-1',
        merchantId: 'merchant-1',
      },
    });

    expect(result.requiresApproval).toBe(true);
    expect(result.data).toEqual([
      {
        toolId: 'jarvis.approval-test',
        intent: 'approval-test',
        succeeded: false,
        error:
          'This action requires approval before execution.',
        approval: {
          approvalId: 'approval-123',
          status: 'PENDING',
          toolId: 'jarvis.approval-test',
          intent: 'approval-test',
          arguments: {
            message: 'Run the approval workflow test',
          },
          requestedAt: new Date('2026-09-16T00:00:00.000Z'),
          expiresAt: null,
        },
      },
    ]);
  });

  it('does not directly execute tools for an orchestrated request', async () => {
    orchestratorService.orchestrate.mockResolvedValue({
      message: 'Revenue checked.',
      agent: 'finance',
      goal: 'Review current financial performance.',
      actions: ['finance.revenue-summary'],
      requiresApproval: false,
      results: [
        {
          toolId: 'finance.revenue-summary',
          intent: 'revenue',
          succeeded: true,
          result: {
            today: {
              grossRevenueCents: 50000,
            },
          },
        },
      ],
    });

    await service.ask({
      message: 'Show me revenue.',
      context: {
        ownerId: 'user-1',
        userId: 'user-1',
        merchantId: 'merchant-1',
      },
    });

    expect(
      orchestratorService.orchestrate,
    ).toHaveBeenCalledTimes(1);
  });
});
