import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PermissionService } from '../permissions/permission.service';
import { ToolRegistry } from '../tools/tool.registry';
import { OwnerOperationService } from './owner-operation.service';
import { GitHubOwnerService } from './github-owner.service';
import { VercelOwnerService } from './vercel-owner.service';
import { OwnerToolExecutor } from './owner-tool.executor';
import { OwnerApprovalService } from '../approvals/owner-approval.service';
import { EngineeringDiagnosticService } from '../engineering/engineering-diagnostic.service';
import { EngineeringRepairWorkflowService } from '../engineering/engineering-repair-workflow.service';
import { PaymentsService } from '../../payments/payments.service';

describe('OwnerToolExecutor', () => {
  let executor: OwnerToolExecutor;
  const toolRegistry = { get: jest.fn() };
  const permissionService = { assertCanExecute: jest.fn() };
  const ownerApprovalService = {
    consumeForExecution: jest.fn(),
  };

  const ownerOperationService = {
    start: jest.fn(),
    succeed: jest.fn(),
    fail: jest.fn(),
    deny: jest.fn(),
    list: jest.fn(),
  };

  const githubOwnerService = {
    getRepositoryStatus: jest.fn(),
  };

  const vercelOwnerService = {
    getLatestDeployment: jest.fn(),
  };
  const engineeringDiagnosticService = {
    diagnoseLatestVercelDeployment: jest.fn(),
  };
  const engineeringRepairWorkflowService = {
    execute: jest.fn(),
  };
  const paymentsService = {
    failoverPayment: jest.fn(),
    getPaymentByReference: jest.fn(),
  };

  const ownerTool = {
    id: 'jarvis.owner-test',
    name: 'JARVIS Owner Test',
    description: 'Harmless owner execution boundary test tool.',
    permission: 'observe',
    readOnly: true,
    scope: 'owner',
  };

  const context = {
    identity: { ownerId: 'owner-1', userId: 'user-1' },
    resource: undefined,
    agent: 'chief-of-staff',
    intent: 'inspect-owner-runtime',
    arguments: { target: 'self' },
    approved: false,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    toolRegistry.get.mockReturnValue(ownerTool);
    permissionService.assertCanExecute.mockImplementation(() => undefined);
    ownerOperationService.start.mockResolvedValue({ id: 'owner-op-1' });
    githubOwnerService.getRepositoryStatus.mockResolvedValue({
      repository: {
        id: 1183538769,
        fullName: 'Stackaura-Payments/stackaura-checkout-api',
        name: 'stackaura-checkout-api',
        owner: 'Stackaura-Payments',
        visibility: 'public',
        defaultBranch: 'main',
        archived: false,
        sizeKb: 644,
      },
      provider: 'github',
      readOnly: true,
      mutationsEnabled: false,
    });
    vercelOwnerService.getLatestDeployment.mockResolvedValue({
      deployment: {
        id: 'dpl_test',
        projectId: 'prj_test',
        url: 'stackaura-test.vercel.app',
        state: 'READY',
        target: 'production',
        createdAt: '2026-09-22T08:00:00.000Z',
        commitSha: 'abc123',
        commitMessage: 'test deployment',
        branch: 'main',
      },
      provider: 'vercel',
      readOnly: true,
      mutationsEnabled: false,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OwnerToolExecutor,
        { provide: ToolRegistry, useValue: toolRegistry },
        { provide: PermissionService, useValue: permissionService },
        { provide: OwnerOperationService, useValue: ownerOperationService },
        { provide: GitHubOwnerService, useValue: githubOwnerService },
        { provide: VercelOwnerService, useValue: vercelOwnerService },
        { provide: OwnerApprovalService, useValue: ownerApprovalService },
        { provide: EngineeringDiagnosticService, useValue: engineeringDiagnosticService },
        { provide: EngineeringRepairWorkflowService, useValue: engineeringRepairWorkflowService },
        { provide: PaymentsService, useValue: paymentsService },
      ],
    }).compile();
    executor = module.get<OwnerToolExecutor>(OwnerToolExecutor);
  });

  it('executes an approved payment failover through the payment service', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.owner.payments.failover',
      permission: 'approval',
      readOnly: false,
    });
    ownerApprovalService.consumeForExecution.mockResolvedValue({ id: 'owner-op-payment-1' });
    paymentsService.failoverPayment.mockResolvedValue({
      paymentId: 'payment-1', reference: 'INV-1', gateway: 'YOCO', attemptId: 'attempt-1',
    });

    const result = await executor.execute('jarvis.owner.payments.failover', {
      ...context,
      arguments: { merchantId: 'merchant-1', reference: 'INV-1' },
      approvalId: 'approval-1',
    });

    expect(paymentsService.failoverPayment).toHaveBeenCalledWith('merchant-1', 'INV-1');
    expect(ownerApprovalService.consumeForExecution).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ gateway: 'YOCO' }));
  });

  it('executes Vercel deployment status without a merchant resource and records the operation', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.owner.vercel.deployment-status',
      permission: 'owner-observe',
    });

    await expect(
      executor.execute('jarvis.owner.vercel.deployment-status', {
        ...context,
        agent: 'vercel',
        intent: 'inspect-deployment',
      }),
    ).resolves.toMatchObject({
      deployment: {
        id: 'dpl_test',
        state: 'READY',
        target: 'production',
      },
      provider: 'vercel',
      readOnly: true,
      mutationsEnabled: false,
    });

    expect(vercelOwnerService.getLatestDeployment).toHaveBeenCalledTimes(1);
    expect(ownerOperationService.start).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        userId: 'user-1',
        agent: 'vercel',
        toolId: 'jarvis.owner.vercel.deployment-status',
        permission: 'owner-observe',
      }),
    );
    expect(ownerOperationService.succeed).toHaveBeenCalled();
  });

  it('executes GitHub repository status without a merchant resource and records the operation', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.owner.github.repository-status',
      permission: 'owner-observe',
    });

    await expect(
      executor.execute('jarvis.owner.github.repository-status', {
        ...context,
        agent: 'github',
        intent: 'inspect-repository',
        arguments: {
          repositoryFullName: 'Stackaura-Payments/stackaura-checkout-api',
        },
      }),
    ).resolves.toEqual({
      repository: {
        id: 1183538769,
        fullName: 'Stackaura-Payments/stackaura-checkout-api',
        name: 'stackaura-checkout-api',
        owner: 'Stackaura-Payments',
        visibility: 'public',
        defaultBranch: 'main',
        archived: false,
        sizeKb: 644,
      },
      provider: 'github',
      readOnly: true,
      mutationsEnabled: false,
    });

    expect(githubOwnerService.getRepositoryStatus).toHaveBeenCalledWith(
      'Stackaura-Payments/stackaura-checkout-api',
    );

    expect(ownerOperationService.start).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        userId: 'user-1',
        agent: 'github',
        toolId: 'jarvis.owner.github.repository-status',
        permission: 'owner-observe',
      }),
    );
    expect(ownerOperationService.succeed).toHaveBeenCalled();
  });

  it('rejects malformed GitHub repository input before provider execution', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.owner.github.repository-status',
      permission: 'owner-observe',
    });

    await expect(
      executor.execute('jarvis.owner.github.repository-status', {
        ...context,
        arguments: { repositoryFullName: 'not-a-repository' },
      }),
    ).rejects.toThrow('owner/name format');
  });

  it('does not permit mutation arguments on the GitHub status tool', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.owner.github.repository-status',
      permission: 'owner-observe',
    });

    await expect(
      executor.execute('jarvis.owner.github.repository-status', {
        ...context,
        arguments: {
          repositoryFullName: 'Stackaura-Payments/stackaura-checkout-api',
          operation: 'delete-repository',
        },
      }),
    ).resolves.toMatchObject({ mutationsEnabled: false });
  });

  it('executes the registered owner operation history tool without a merchant resource', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.owner-operations.list',
      permission: 'owner-observe',
    });
    ownerOperationService.list.mockResolvedValue([]);

    await expect(
      executor.execute('jarvis.owner-operations.list', {
        ...context,
        arguments: { limit: 10 },
      }),
    ).resolves.toEqual([]);

    expect(ownerOperationService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        userId: 'user-1',
        limit: 10,
      }),
    );
  });

  it('executes an owner-scoped tool without a merchant resource', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.owner-operations.list',
      permission: 'owner-observe',
    });
    ownerOperationService.list.mockResolvedValue([]);

    await expect(
      executor.execute('jarvis.owner-operations.list', {
        ...context,
        arguments: { limit: 10 },
      }),
    ).resolves.toEqual([]);

    expect(ownerOperationService.start).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        userId: 'user-1',
        toolId: 'jarvis.owner-operations.list',
        permission: 'owner-observe',
      }),
    );
    expect(ownerOperationService.succeed).toHaveBeenCalledWith(
      'owner-op-1',
      [],
    );
  });

  it('rejects execution without owner identity', async () => {
    await expect(
      executor.execute(ownerTool.id, {
        ...context,
        identity: { ownerId: '', userId: 'user-1' },
      }),
    ).rejects.toThrow(BadRequestException);

    expect(permissionService.assertCanExecute).not.toHaveBeenCalled();
    expect(ownerOperationService.start).not.toHaveBeenCalled();
  });

  it('rejects a merchant-scoped tool before any owner operation is created', async () => {
    toolRegistry.get.mockReturnValue({ ...ownerTool, scope: 'merchant' });
    await expect(executor.execute(ownerTool.id, context)).rejects.toThrow(
      BadRequestException,
    );
    expect(ownerOperationService.start).not.toHaveBeenCalled();
  });

  it('requires an owner approval id for approval-gated owner tools', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      permission: 'approval',
    });

    await expect(executor.execute(ownerTool.id, context)).rejects.toThrow(
      'Owner approval is required',
    );
    expect(ownerApprovalService.consumeForExecution).not.toHaveBeenCalled();
    expect(ownerOperationService.deny).toHaveBeenCalled();
  });

  it('records permission denial in the owner operation ledger', async () => {
    const error = new ForbiddenException('blocked');
    permissionService.assertCanExecute.mockImplementation(() => {
      throw error;
    });

    await expect(executor.execute(ownerTool.id, context)).rejects.toThrow(
      'blocked',
    );
    expect(ownerOperationService.deny).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner-1', userId: 'user-1' }),
      error,
    );
  });

  it('sanitizes sensitive values returned by an owner tool', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.owner-operations.list',
      permission: 'owner-observe',
    });
    ownerOperationService.list.mockResolvedValue([
      {
        id: 'op-1',
        result: { apiKey: 'secret-value', nested: { token: 'secret-token' } },
      },
    ]);

    await expect(
      executor.execute('jarvis.owner-operations.list', {
        ...context,
        arguments: { limit: 5 },
      }),
    ).resolves.toEqual([
      {
        id: 'op-1',
        result: {
          apiKey: '[REDACTED]',
          nested: { token: '[REDACTED]' },
        },
      },
    ]);
  });

  it('marks failed owner execution and rethrows the original error', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.unimplemented-owner-tool',
    });

    await expect(
      executor.execute('jarvis.unimplemented-owner-tool', context),
    ).rejects.toThrow('No owner executor is implemented');

    expect(ownerOperationService.fail).toHaveBeenCalledWith(
      'owner-op-1',
      expect.any(Error),
    );
  });
});
