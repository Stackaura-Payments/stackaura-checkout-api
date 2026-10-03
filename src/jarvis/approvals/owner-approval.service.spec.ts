import { BadRequestException } from '@nestjs/common';
import { JarvisApprovalStatus } from '@prisma/client';
import { OwnerApprovalService } from './owner-approval.service';

describe('OwnerApprovalService', () => {
  let service: OwnerApprovalService;

  const prisma = {
    jarvisOwnerApproval: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    jarvisOwnerOperation: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const toolRegistry = {
    get: jest.fn(),
  };

  const ownerTool = {
    id: 'jarvis.owner.deploy',
    name: 'Owner Deploy',
    description: 'Deploy owner infrastructure.',
    permission: 'approval',
    readOnly: false,
    scope: 'owner',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OwnerApprovalService(prisma as any, toolRegistry as any);
    toolRegistry.get.mockReturnValue(ownerTool);
    prisma.jarvisOwnerApproval.create.mockResolvedValue({
      id: 'approval-1',
      ownerId: 'owner-1',
      requestedByUserId: 'owner-1',
      toolId: ownerTool.id,
      intent: 'deploy-production',
      arguments: { commit: 'abc123' },
      riskLevel: 'HIGH',
      status: JarvisApprovalStatus.PENDING,
    });
    prisma.jarvisOwnerApproval.updateMany.mockResolvedValue({ count: 1 });
    prisma.jarvisOwnerOperation.create.mockResolvedValue({
      id: 'operation-1',
      ownerId: 'owner-1',
      userId: 'owner-1',
      approved: true,
      status: 'STARTED',
    });
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        jarvisOwnerApproval: prisma.jarvisOwnerApproval,
        jarvisOwnerOperation: prisma.jarvisOwnerOperation,
      }),
    );
  });

  it('creates an owner-scoped approval', async () => {
    const result = await service.create({
      ownerId: 'owner-1',
      requestedByUserId: 'owner-1',
      toolId: ownerTool.id,
      intent: 'deploy-production',
      arguments: { commit: 'abc123' },
      riskLevel: 'HIGH',
    });

    expect(result.id).toBe('approval-1');
    expect(prisma.jarvisOwnerApproval.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: 'owner-1',
          requestedByUserId: 'owner-1',
          toolId: ownerTool.id,
          status: JarvisApprovalStatus.PENDING,
          riskLevel: 'HIGH',
        }),
      }),
    );
  });

  it('rejects a request where owner identity and requester differ', async () => {
    await expect(
      service.create({
        ownerId: 'owner-1',
        requestedByUserId: 'other-user',
        toolId: ownerTool.id,
        intent: 'deploy-production',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.jarvisOwnerApproval.create).not.toHaveBeenCalled();
  });

  it('rejects approval for a non-owner-scoped tool', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      scope: 'merchant',
    });

    await expect(
      service.create({
        ownerId: 'owner-1',
        requestedByUserId: 'owner-1',
        toolId: ownerTool.id,
        intent: 'deploy-production',
      }),
    ).rejects.toThrow('not owner-scoped');
  });

  it('approves a pending action only for the owner', async () => {
    prisma.jarvisOwnerApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      ownerId: 'owner-1',
      status: JarvisApprovalStatus.PENDING,
      expiresAt: null,
    });

    const result = await service.approve('owner-1', 'approval-1', 'owner-1');

    expect(result.status).toBe(JarvisApprovalStatus.APPROVED);
    expect(prisma.jarvisOwnerApproval.updateMany).toHaveBeenCalled();
  });

  it('rejects approval decisions from another identity', async () => {
    await expect(
      service.approve('owner-1', 'approval-1', 'other-user'),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.jarvisOwnerApproval.findFirst).not.toHaveBeenCalled();
  });

  it('atomically consumes an approved one-shot approval', async () => {
    prisma.jarvisOwnerApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      ownerId: 'owner-1',
      toolId: ownerTool.id,
      intent: 'deploy-production',
      arguments: { commit: 'abc123' },
      status: JarvisApprovalStatus.APPROVED,
      executionId: null,
      expiresAt: null,
    });

    const result = await service.consumeForExecution({
      ownerId: 'owner-1',
      approvalId: 'approval-1',
      toolId: ownerTool.id,
      intent: 'deploy-production',
      arguments: { commit: 'abc123' },
      userId: 'owner-1',
      agent: 'chief-of-staff',
      permission: 'approval',
    });

    expect(result.id).toBe('operation-1');
    expect(prisma.jarvisOwnerOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: 'owner-1',
          approved: true,
          status: 'STARTED',
        }),
      }),
    );
    expect(prisma.jarvisOwnerApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'approval-1',
          executionId: null,
          status: JarvisApprovalStatus.APPROVED,
        }),
        data: { executionId: 'operation-1' },
      }),
    );
  });

  it('rejects changed arguments after approval', async () => {
    prisma.jarvisOwnerApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      ownerId: 'owner-1',
      toolId: ownerTool.id,
      intent: 'deploy-production',
      arguments: { commit: 'abc123' },
      status: JarvisApprovalStatus.APPROVED,
      executionId: null,
      expiresAt: null,
    });

    await expect(
      service.consumeForExecution({
        ownerId: 'owner-1',
        approvalId: 'approval-1',
        toolId: ownerTool.id,
        intent: 'deploy-production',
        arguments: { commit: 'different-commit' },
        userId: 'owner-1',
        agent: 'chief-of-staff',
        permission: 'approval',
      }),
    ).rejects.toThrow('arguments do not match');

    expect(prisma.jarvisOwnerOperation.create).not.toHaveBeenCalled();
  });

  it('rejects replay of an already consumed approval', async () => {
    prisma.jarvisOwnerApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      ownerId: 'owner-1',
      toolId: ownerTool.id,
      intent: 'deploy-production',
      arguments: { commit: 'abc123' },
      status: JarvisApprovalStatus.APPROVED,
      executionId: 'operation-existing',
      expiresAt: null,
    });

    await expect(
      service.consumeForExecution({
        ownerId: 'owner-1',
        approvalId: 'approval-1',
        toolId: ownerTool.id,
        intent: 'deploy-production',
        arguments: { commit: 'abc123' },
        userId: 'owner-1',
        agent: 'chief-of-staff',
        permission: 'approval',
      }),
    ).rejects.toThrow('already been consumed');

    expect(prisma.jarvisOwnerOperation.create).not.toHaveBeenCalled();
  });
});
