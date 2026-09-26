import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AgentRegistry } from '../agents/agent.registry';
import { ToolRegistry } from '../tools/tool.registry';
import { ToolExecutor } from '../tools/tool.executor';
import { OwnerToolExecutor } from '../owner/owner-tool.executor';
import { PlannerService } from './planner.service';
import { OrchestratorService } from './orchestrator.service';
import { ApprovalService } from '../approvals/approval.service';
import { ActionLifecycleService } from '../owner/action-lifecycle.service';

describe('OrchestratorService', () => {
  let service: OrchestratorService;

  const plannerService = {
    plan: jest.fn(),
  };

  const agentRegistry = {
    get: jest.fn(),
  };

  const toolRegistry = {
    get: jest.fn(),
  };

  const toolExecutor = {
    execute: jest.fn(),
  };

  const ownerToolExecutor = {
    execute: jest.fn(),
  };

  const actionLifecycleService = {
    propose: jest.fn().mockResolvedValue({
      action: { id: 'action-123' },
      approval: {
        id: 'owner-approval-123',
        status: 'PENDING',
        toolId: 'jarvis.owner.vercel.deploy',
        intent: 'deploy-production',
        arguments: { projectId: 'project-123', target: 'production', ref: 'main' },
        requestedAt: new Date('2026-09-23T00:00:00.000Z'),
        expiresAt: new Date('2026-09-23T00:15:00.000Z'),
      },
    }),
  };

  const approvalService = {
    create: jest.fn().mockResolvedValue({
      id: 'approval-123',
      status: 'PENDING',
      toolId: 'engineering.production-deploy',
      intent: 'deploy',
      arguments: null,
      requestedAt: new Date('2026-09-16T00:00:00.000Z'),
      expiresAt: null,
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule =
      await Test.createTestingModule({
        providers: [
          OrchestratorService,
          {
            provide: PlannerService,
            useValue: plannerService,
          },
          {
            provide: AgentRegistry,
            useValue: agentRegistry,
          },
          {
            provide: ToolRegistry,
            useValue: toolRegistry,
          },
          {
            provide: ToolExecutor,
            useValue: toolExecutor,
          },
          {
            provide: OwnerToolExecutor,
            useValue: ownerToolExecutor,
          },
          {
            provide: ApprovalService,
            useValue: approvalService,
          },
          {
            provide: ActionLifecycleService,
            useValue: actionLifecycleService,
          },
        ],
      }).compile();

    service =
      module.get<OrchestratorService>(
        OrchestratorService,
      );
  });

  it('executes a multi-tool payments plan', async () => {
    plannerService.plan.mockReturnValue({
      goal: 'Investigate payment operations.',
      agent: 'payments',
      steps: [
        {
          toolId: 'command-center.overview',
          intent: 'status',
        },
        {
          toolId: 'payments.gateway-health',
          intent: 'gateway-health',
        },
        {
          toolId: 'payments.webhook-health',
          intent: 'webhook-health',
        },
      ],
    });

    agentRegistry.get.mockReturnValue({
      id: 'payments',
      name: 'Payments Agent',
      enabled: true,
    });

    toolRegistry.get.mockImplementation(
      (toolId: string) => ({
        id: toolId,
        permission: 'observe',
        readOnly: true,
        scope: 'merchant',
      }),
    );

    toolExecutor.execute
      .mockResolvedValueOnce({
        today: {
          totalTransactions: 100,
        },
      })
      .mockResolvedValueOnce({
        gateways: [],
      })
      .mockResolvedValueOnce({
        webhooks: {
          successful: 98,
          failed: 2,
        },
      });

    const result =
      await service.orchestrate({
        message: 'Why are payments failing?',
        context: {
          identity: {
            ownerId: 'user-1',
            userId: 'user-1',
          },
          resource: {
            type: 'merchant',
            id: 'merchant-1',
          },
        },
      });

    expect(result.agent).toBe('payments');
    expect(result.goal).toBe(
      'Investigate payment operations.',
    );

    expect(result.actions).toEqual([
      'command-center.overview',
      'payments.gateway-health',
      'payments.webhook-health',
    ]);

    expect(result.requiresApproval).toBe(false);

    expect(result.results).toHaveLength(3);

    expect(
      result.results.every(
        (item) => item.succeeded === true,
      ),
    ).toBe(true);

    expect(toolExecutor.execute).toHaveBeenCalledTimes(3);

    expect(toolExecutor.execute).toHaveBeenNthCalledWith(
      1,
      'command-center.overview',
      {
        identity: {
          ownerId: 'user-1',
          userId: 'user-1',
        },
        resource: {
          type: 'merchant',
          id: 'merchant-1',
        },
        agent: 'payments',
        intent: 'status',
        arguments: undefined,
        approved: false,
      },
    );
  });

  it('routes owner-scoped tools through the owner executor without merchant context', async () => {
    plannerService.plan.mockReturnValue({
      goal: 'Check the GitHub repository status.',
      agent: 'github',
      steps: [{
        toolId: 'jarvis.owner.github.repository-status',
        intent: 'inspect-repository',
        arguments: { repositoryFullName: 'Stackaura-Payments/stackaura-checkout-api' },
      }],
    });
    agentRegistry.get.mockReturnValue({ id: 'github', name: 'GitHub Agent', enabled: true, scope: 'owner' });
    toolRegistry.get.mockReturnValue({ id: 'jarvis.owner.github.repository-status', permission: 'owner-observe', readOnly: true, scope: 'owner' });
    ownerToolExecutor.execute.mockResolvedValue({ provider: 'github', readOnly: true, mutationsEnabled: false });

    const result = await service.orchestrate({
      message: 'Check the status of Stackaura-Payments/stackaura-checkout-api',
      context: { identity: { ownerId: 'user-1', userId: 'user-1' } },
    });

    expect(ownerToolExecutor.execute).toHaveBeenCalledWith(
      'jarvis.owner.github.repository-status',
      expect.objectContaining({
        agent: 'github',
        intent: 'inspect-repository',
        resource: undefined,
      }),
    );
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    expect(result.results[0].succeeded).toBe(true);
  });

  it('continues orchestration when one tool fails', async () => {
    plannerService.plan.mockReturnValue({
      goal: 'Check payment health.',
      agent: 'payments',
      steps: [
        {
          toolId: 'payments.gateway-health',
          intent: 'gateway-health',
        },
        {
          toolId: 'payments.webhook-health',
          intent: 'webhook-health',
        },
      ],
    });

    agentRegistry.get.mockReturnValue({
      id: 'payments',
      name: 'Payments Agent',
      enabled: true,
    });

    toolRegistry.get.mockImplementation(
      (toolId: string) => ({
        id: toolId,
        permission: 'observe',
        readOnly: true,
        scope: 'merchant',
      }),
    );

    toolExecutor.execute
      .mockRejectedValueOnce(
        new Error('Gateway service unavailable'),
      )
      .mockResolvedValueOnce({
        successful: 100,
        failed: 0,
      });

    const result =
      await service.orchestrate({
        message: 'Check payment health.',
        context: {
          identity: {
            ownerId: 'user-1',
            userId: 'user-1',
          },
          resource: {
            type: 'merchant',
            id: 'merchant-1',
          },
        },
      });

    expect(result.results).toHaveLength(2);

    expect(result.results[0]).toEqual({
      toolId: 'payments.gateway-health',
      intent: 'gateway-health',
      succeeded: false,
      error: 'Gateway service unavailable',
    });

    expect(result.results[1]).toEqual({
      toolId: 'payments.webhook-health',
      intent: 'webhook-health',
      result: {
        successful: 100,
        failed: 0,
      },
      succeeded: true,
    });

    expect(result.message).toContain(
      'Steps requiring attention: 1',
    );
  });

  it('creates an owner action proposal for owner-scoped approval tools', async () => {
    plannerService.plan.mockReturnValue({
      goal: 'Deploy the current frontend to production.',
      agent: 'engineering',
      steps: [{
        toolId: 'jarvis.owner.vercel.deploy',
        intent: 'deploy-production',
        arguments: { projectId: 'project-123', target: 'production', ref: 'main' },
      }],
    });
    agentRegistry.get.mockReturnValue({ id: 'engineering', name: 'Engineering Agent', enabled: true, scope: 'owner' });
    toolRegistry.get.mockReturnValue({ id: 'jarvis.owner.vercel.deploy', permission: 'approval', readOnly: false, scope: 'owner' });

    process.env.VERCEL_PROJECT_ID = 'project-123';

    const result = await service.orchestrate({
      message: 'Deploy the current frontend to production.',
      context: { identity: { ownerId: 'user-1', userId: 'user-1' } },
    });

    expect(actionLifecycleService.propose).toHaveBeenCalledWith({
      ownerId: 'user-1',
      requestedByUserId: 'user-1',
      toolId: 'jarvis.owner.vercel.deploy',
      intent: 'deploy-production',
      arguments: { projectId: 'project-123', target: 'production', ref: 'main' },
      riskLevel: 'HIGH',
    });
    expect(ownerToolExecutor.execute).not.toHaveBeenCalled();
    expect(result.requiresApproval).toBe(true);
    expect(result.results[0].approval).toMatchObject({ approvalId: 'owner-approval-123', status: 'PENDING' });
    delete process.env.VERCEL_PROJECT_ID;
  });

  it('does not execute approval-gated tools automatically', async () => {
    plannerService.plan.mockReturnValue({
      goal: 'Deploy a checkout fix.',
      agent: 'engineering',
      steps: [
        {
          toolId: 'engineering.production-deploy',
          intent: 'deploy',
        },
      ],
    });

    agentRegistry.get.mockReturnValue({
      id: 'engineering',
      name: 'Engineering Agent',
      enabled: true,
    });

    toolRegistry.get.mockReturnValue({
      id: 'engineering.production-deploy',
      permission: 'approval',
      readOnly: false,
      scope: 'merchant',
    });

    const result =
      await service.orchestrate({
        message: 'Deploy the checkout fix.',
        context: {
          identity: {
            ownerId: 'user-1',
            userId: 'user-1',
          },
          resource: {
            type: 'merchant',
            id: 'merchant-1',
          },
        },
      });

    expect(
      toolExecutor.execute,
    ).not.toHaveBeenCalled();

    expect(result.requiresApproval).toBe(true);

    expect(result.results).toEqual([
      {
        toolId: 'engineering.production-deploy',
        intent: 'deploy',
        succeeded: false,
        error:
          'This action requires approval before execution.',
        approval: {
          approvalId: 'approval-123',
          status: 'PENDING',
          toolId: 'engineering.production-deploy',
          intent: 'deploy',
          arguments: null,
          requestedAt: new Date('2026-09-16T00:00:00.000Z'),
          expiresAt: null,
        },
      },
    ]);

    expect(approvalService.create).toHaveBeenCalledWith({
      merchantId: 'merchant-1',
      userId: 'user-1',
      toolId: 'engineering.production-deploy',
      intent: 'deploy',
      arguments: undefined,
    });
  });

  it('does not execute human-only tools automatically', async () => {
    plannerService.plan.mockReturnValue({
      goal: 'Perform a restricted action.',
      agent: 'engineering',
      steps: [
        {
          toolId: 'engineering.critical-action',
          intent: 'critical-action',
        },
      ],
    });

    agentRegistry.get.mockReturnValue({
      id: 'engineering',
      name: 'Engineering Agent',
      enabled: true,
    });

    toolRegistry.get.mockReturnValue({
      id: 'engineering.critical-action',
      permission: 'human-only',
      readOnly: false,
      scope: 'merchant',
    });

    const result =
      await service.orchestrate({
        message: 'Perform the restricted action.',
        context: {
          identity: {
            ownerId: 'user-1',
            userId: 'user-1',
          },
          resource: {
            type: 'merchant',
            id: 'merchant-1',
          },
        },
      });

    expect(
      toolExecutor.execute,
    ).not.toHaveBeenCalled();

    expect(result.requiresApproval).toBe(true);

    expect(result.results[0].error).toBe(
      'This action requires direct human authorization.',
    );
  });

  it('rejects an unavailable agent', async () => {
    plannerService.plan.mockReturnValue({
      goal: 'Test unavailable agent.',
      agent: 'payments',
      steps: [],
    });

    agentRegistry.get.mockReturnValue(undefined);

    await expect(
      service.orchestrate({
        message: 'Test unavailable agent.',
        context: {
          identity: {
            ownerId: 'user-1',
            userId: 'user-1',
          },
          resource: {
            type: 'merchant',
            id: 'merchant-1',
          },
        },
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'JARVIS agent "payments" is unavailable.',
      ),
    );

    expect(
      toolExecutor.execute,
    ).not.toHaveBeenCalled();
  });

  it('rejects an unregistered tool before execution', async () => {
    plannerService.plan.mockReturnValue({
      goal: 'Test unknown tool.',
      agent: 'payments',
      steps: [
        {
          toolId: 'payments.fake-tool',
          intent: 'fake',
        },
      ],
    });

    agentRegistry.get.mockReturnValue({
      id: 'payments',
      name: 'Payments Agent',
      enabled: true,
    });

    toolRegistry.get.mockReturnValue(undefined);

    await expect(
      service.orchestrate({
        message: 'Test unknown tool.',
        context: {
          identity: {
            ownerId: 'user-1',
            userId: 'user-1',
          },
          resource: {
            type: 'merchant',
            id: 'merchant-1',
          },
        },
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'JARVIS tool "payments.fake-tool" is not registered.',
      ),
    );

    expect(
      toolExecutor.execute,
    ).not.toHaveBeenCalled();
  });

  it('rejects an empty request before planning', async () => {
    await expect(
      service.orchestrate({
        message: '   ',
        context: {
          identity: {
            ownerId: 'user-1',
            userId: 'user-1',
          },
          resource: {
            type: 'merchant',
            id: 'merchant-1',
          },
        },
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'JARVIS requires a message.',
      ),
    );

    expect(
      plannerService.plan,
    ).not.toHaveBeenCalled();
  });
});
