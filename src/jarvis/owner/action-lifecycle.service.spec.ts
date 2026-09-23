import { ConflictException } from '@nestjs/common';
import { JarvisActionStatus } from '@prisma/client';
import { ActionLifecycleService } from './action-lifecycle.service';

describe('ActionLifecycleService', () => {
  const ownerId = 'owner-1';
  const actionId = 'action-1';
  const baseAction = {
    id: actionId,
    ownerId,
    requestedBy: ownerId,
    toolId: 'jarvis.owner.github.update-file',
    intent: 'Update a file',
    arguments: {
      repositoryFullName: 'Stackaura-Payments/stackaura-checkout-api',
      path: 'README.md',
      content: 'new content',
      sha: 'old-sha',
      branch: 'main',
    },
    riskLevel: 'MEDIUM',
    status: JarvisActionStatus.APPROVED,
    executionId: null,
    verification: null,
    recovery: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    approvedAt: new Date(),
    startedAt: null,
    completedAt: null,
    approval: { id: 'approval-1' },
  };

  function makeService(updateManyCount: number) {
    const prisma = {
      jarvisOwnerAction: {
        findFirst: jest.fn().mockResolvedValue(baseAction),
        updateMany: jest.fn().mockResolvedValue({ count: updateManyCount }),
        update: jest.fn(),
      },
      jarvisOwnerOperation: { findFirst: jest.fn() },
    } as any;
    const ownerApprovalService = {} as any;
    const ownerToolExecutor = { execute: jest.fn(), verify: jest.fn() } as any;
    const toolRegistry = {} as any;
    const vercelOwnerService = {} as any;
    return { service: new ActionLifecycleService(prisma, ownerApprovalService, ownerToolExecutor, toolRegistry, vercelOwnerService), prisma, ownerToolExecutor };
  }

  it('atomically claims an approved action before executing it', async () => {
    const { service, prisma, ownerToolExecutor } = makeService(0);

    await expect(service.execute(ownerId, actionId, ownerId)).rejects.toThrow(ConflictException);

    expect(prisma.jarvisOwnerAction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: actionId,
        ownerId,
        status: JarvisActionStatus.APPROVED,
      }),
      data: expect.objectContaining({ status: JarvisActionStatus.EXECUTING }),
    }));
    expect(ownerToolExecutor.execute).not.toHaveBeenCalled();
  });
});
