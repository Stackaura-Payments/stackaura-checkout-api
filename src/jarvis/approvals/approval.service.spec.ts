import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  JarvisApprovalStatus,
  Prisma,
} from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { ToolRegistry } from '../tools/tool.registry';
import {
  ApprovalService,
  ConsumeApprovalInput,
} from './approval.service';

describe('ApprovalService', () => {
  let service: ApprovalService;

  let prisma: {
    jarvisApproval: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    jarvisExecution: {
      create: jest.Mock;
    };
    membership: {
      findFirst: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  let toolRegistry: {
    get: jest.Mock;
  };

  const baseInput: ConsumeApprovalInput = {
    merchantId: 'merchant-1',
    approvalId: 'approval-1',
    toolId: 'test.approval',
    intent: 'test-approval',
    arguments: {
      message: 'harmless test',
    },
    userId: 'user-1',
    agent: 'chief-of-staff',
    permission: 'approval',
  };

  const execution = {
    id: 'execution-1',
    merchantId: 'merchant-1',
    userId: 'user-1',
    agent: 'chief-of-staff',
    toolId: 'test.approval',
    intent: 'test-approval',
    permission: 'approval',
    approved: true,
    status: 'STARTED',
  };

  beforeEach(async () => {
    prisma = {
      jarvisApproval: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      jarvisExecution: {
        create: jest.fn(),
      },
      membership: {
        findFirst: jest.fn(),
      },
      $transaction: jest.fn(async (callback: unknown) => {
        const tx = {
          jarvisApproval: prisma.jarvisApproval,
          jarvisExecution: prisma.jarvisExecution,
        };

        return (callback as (tx: typeof tx) => Promise<unknown>)(tx);
      }),
    };

    toolRegistry = {
      get: jest.fn(),
    };

    const module: TestingModule =
      await Test.createTestingModule({
        providers: [
          ApprovalService,
          {
            provide: PrismaService,
            useValue: prisma,
          },
          {
            provide: ToolRegistry,
            useValue: toolRegistry,
          },
        ],
      }).compile();

    service =
      module.get<ApprovalService>(ApprovalService);

    prisma.jarvisExecution.create.mockResolvedValue(
      execution,
    );

    prisma.jarvisApproval.updateMany.mockResolvedValue({
      count: 1,
    });

    prisma.membership.findFirst.mockResolvedValue({
      role: 'OWNER',
    });
  });

  it('approved approval -> creates and consumes execution', async () => {
    prisma.jarvisApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      merchantId: 'merchant-1',
      userId: 'user-1',
      toolId: 'test.approval',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      status: JarvisApprovalStatus.APPROVED,
      executionId: null,
      expiresAt: null,
    });

    const result =
      await service.consumeForExecution(baseInput);

    expect(result).toEqual(execution);

    expect(
      prisma.jarvisExecution.create,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          merchantId: 'merchant-1',
          toolId: 'test.approval',
          intent: 'test-approval',
          approved: true,
          status: 'STARTED',
        }),
      }),
    );

    expect(
      prisma.jarvisApproval.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: 'approval-1',
        merchantId: 'merchant-1',
        status: JarvisApprovalStatus.APPROVED,
        executionId: null,
      },
      data: {
        executionId: 'execution-1',
      },
    });
  });

  it('pending approval -> rejected', async () => {
    prisma.jarvisApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      merchantId: 'merchant-1',
      toolId: 'test.approval',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      status: JarvisApprovalStatus.PENDING,
      executionId: null,
      expiresAt: null,
    });

    await expect(
      service.consumeForExecution(baseInput),
    ).rejects.toThrow(
      'Approval must be APPROVED before execution.',
    );

    expect(
      prisma.jarvisExecution.create,
    ).not.toHaveBeenCalled();
  });

  it('denied approval -> rejected', async () => {
    prisma.jarvisApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      merchantId: 'merchant-1',
      toolId: 'test.approval',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      status: JarvisApprovalStatus.DENIED,
      executionId: null,
      expiresAt: null,
    });

    await expect(
      service.consumeForExecution(baseInput),
    ).rejects.toThrow(
      'Approval must be APPROVED before execution.',
    );

    expect(
      prisma.jarvisExecution.create,
    ).not.toHaveBeenCalled();
  });

  it('expired approval -> rejected', async () => {
    prisma.jarvisApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      merchantId: 'merchant-1',
      toolId: 'test.approval',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      status: JarvisApprovalStatus.APPROVED,
      executionId: null,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      service.consumeForExecution(baseInput),
    ).rejects.toThrow('Approval has expired.');

    expect(
      prisma.jarvisExecution.create,
    ).not.toHaveBeenCalled();
  });

  it('wrong tool -> rejected', async () => {
    prisma.jarvisApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      merchantId: 'merchant-1',
      toolId: 'different.tool',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      status: JarvisApprovalStatus.APPROVED,
      executionId: null,
      expiresAt: null,
    });

    await expect(
      service.consumeForExecution(baseInput),
    ).rejects.toThrow(
      'Approval tool mismatch.',
    );

    expect(
      prisma.jarvisExecution.create,
    ).not.toHaveBeenCalled();
  });

  it('modified arguments -> rejected', async () => {
    prisma.jarvisApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      merchantId: 'merchant-1',
      toolId: 'test.approval',
      intent: 'test-approval',
      arguments: {
        message: 'original approved message',
      },
      status: JarvisApprovalStatus.APPROVED,
      executionId: null,
      expiresAt: null,
    });

    await expect(
      service.consumeForExecution(baseInput),
    ).rejects.toThrow(
      'Approval arguments do not match the approved arguments.',
    );

    expect(
      prisma.jarvisExecution.create,
    ).not.toHaveBeenCalled();
  });

  it('wrong merchant -> rejected', async () => {
    prisma.jarvisApproval.findFirst.mockResolvedValue(
      null,
    );

    await expect(
      service.consumeForExecution({
        ...baseInput,
        merchantId: 'attacker-merchant',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(
      prisma.jarvisApproval.findFirst,
    ).toHaveBeenCalledWith({
      where: {
        id: 'approval-1',
        merchantId: 'attacker-merchant',
      },
    });

    expect(
      prisma.jarvisExecution.create,
    ).not.toHaveBeenCalled();
  });

  it('approval replay -> rejected', async () => {
    prisma.jarvisApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      merchantId: 'merchant-1',
      toolId: 'test.approval',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      status: JarvisApprovalStatus.APPROVED,
      executionId: 'execution-already-used',
      expiresAt: null,
    });

    await expect(
      service.consumeForExecution(baseInput),
    ).rejects.toThrow(
      'Approval has already been consumed by an execution.',
    );

    expect(
      prisma.jarvisExecution.create,
    ).not.toHaveBeenCalled();
  });

  it('rejects a failed atomic consumption', async () => {
    prisma.jarvisApproval.findFirst.mockResolvedValue({
      id: 'approval-1',
      merchantId: 'merchant-1',
      toolId: 'test.approval',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      status: JarvisApprovalStatus.APPROVED,
      executionId: null,
      expiresAt: null,
    });

    prisma.jarvisApproval.updateMany.mockResolvedValue({
      count: 0,
    });

    await expect(
      service.consumeForExecution(baseInput),
    ).rejects.toThrow(
      'Approval could not be consumed because it was already used.',
    );
  });

  describe('approval decision authorization', () => {
    const pendingApproval = {
      id: 'approval-1',
      merchantId: 'merchant-1',
      userId: 'user-1',
      toolId: 'test.approval',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      status: JarvisApprovalStatus.PENDING,
      executionId: null,
      expiresAt: null,
    };

    it('OWNER -> can approve', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        role: 'OWNER',
      });

      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      await service.approve(
        'merchant-1',
        'approval-1',
        'owner-user',
      );

      expect(
        prisma.jarvisApproval.updateMany,
      ).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'approval-1',
          merchantId: 'merchant-1',
          status: JarvisApprovalStatus.PENDING,
          OR: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: JarvisApprovalStatus.APPROVED,
          decidedByUserId: 'owner-user',
        }),
      });
    });

    it('ADMIN -> can approve', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        role: 'ADMIN',
      });

      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      await service.approve(
        'merchant-1',
        'approval-1',
        'admin-user',
      );

      expect(
        prisma.jarvisApproval.updateMany,
      ).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'approval-1',
          merchantId: 'merchant-1',
          status: JarvisApprovalStatus.PENDING,
          OR: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: JarvisApprovalStatus.APPROVED,
          decidedByUserId: 'admin-user',
        }),
      });
    });

    it('MEMBER -> cannot approve', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        role: 'MEMBER',
      });

      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      await expect(
        service.approve(
          'merchant-1',
          'approval-1',
          'member-user',
        ),
      ).rejects.toThrow(
        'Only merchant owners and admins can approve or deny JARVIS actions.',
      );

      expect(
        prisma.jarvisApproval.update,
      ).not.toHaveBeenCalled();
    });

    it('VIEWER -> cannot approve', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        role: 'VIEWER',
      });

      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      await expect(
        service.approve(
          'merchant-1',
          'approval-1',
          'viewer-user',
        ),
      ).rejects.toThrow(
        'Only merchant owners and admins can approve or deny JARVIS actions.',
      );

      expect(
        prisma.jarvisApproval.update,
      ).not.toHaveBeenCalled();
    });

    it('non-member -> cannot approve', async () => {
      prisma.membership.findFirst.mockResolvedValue(null);

      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      await expect(
        service.approve(
          'merchant-1',
          'approval-1',
          'unknown-user',
        ),
      ).rejects.toThrow(
        'User is not a member of this merchant.',
      );

      expect(
        prisma.jarvisApproval.update,
      ).not.toHaveBeenCalled();
    });

    it('OWNER -> can deny', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        role: 'OWNER',
      });

      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      await service.deny(
        'merchant-1',
        'approval-1',
        'owner-user',
      );

      expect(
        prisma.jarvisApproval.updateMany,
      ).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'approval-1',
          merchantId: 'merchant-1',
          status: JarvisApprovalStatus.PENDING,
          OR: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: JarvisApprovalStatus.DENIED,
          decidedByUserId: 'owner-user',
        }),
      });
    });

    it('ADMIN -> can deny', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        role: 'ADMIN',
      });

      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      await service.deny(
        'merchant-1',
        'approval-1',
        'admin-user',
      );

      expect(
        prisma.jarvisApproval.updateMany,
      ).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'approval-1',
          merchantId: 'merchant-1',
          status: JarvisApprovalStatus.PENDING,
          OR: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: JarvisApprovalStatus.DENIED,
          decidedByUserId: 'admin-user',
        }),
      });
    });

    it('MEMBER -> cannot deny', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        role: 'MEMBER',
      });

      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      await expect(
        service.deny(
          'merchant-1',
          'approval-1',
          'member-user',
        ),
      ).rejects.toThrow(
        'Only merchant owners and admins can approve or deny JARVIS actions.',
      );

      expect(
        prisma.jarvisApproval.update,
      ).not.toHaveBeenCalled();
    });

    it('VIEWER -> cannot deny', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        role: 'VIEWER',
      });

      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      await expect(
        service.deny(
          'merchant-1',
          'approval-1',
          'viewer-user',
        ),
      ).rejects.toThrow(
        'Only merchant owners and admins can approve or deny JARVIS actions.',
      );

      expect(
        prisma.jarvisApproval.update,
      ).not.toHaveBeenCalled();
    });
  });


  describe('atomic decision transitions', () => {
    const pendingApproval = {
      id: 'approval-1',
      merchantId: 'merchant-1',
      userId: 'user-1',
      toolId: 'test.approval',
      intent: 'test-approval',
      arguments: {
        message: 'harmless test',
      },
      status: JarvisApprovalStatus.PENDING,
      executionId: null,
      expiresAt: null,
    };

    it('approve -> rejects when the conditional update loses the race', async () => {
      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      prisma.jarvisApproval.updateMany.mockResolvedValue({
        count: 0,
      });

      await expect(
        service.approve(
          'merchant-1',
          'approval-1',
          'owner-user',
        ),
      ).rejects.toThrow(
        'Approval could not be approved because it is no longer pending.',
      );
    });

    it('deny -> rejects when the conditional update loses the race', async () => {
      prisma.jarvisApproval.findFirst.mockResolvedValue(
        pendingApproval,
      );

      prisma.jarvisApproval.updateMany.mockResolvedValue({
        count: 0,
      });

      await expect(
        service.deny(
          'merchant-1',
          'approval-1',
          'owner-user',
        ),
      ).rejects.toThrow(
        'Approval could not be denied because it is no longer pending.',
      );
    });

    it('approve -> cannot transition an already-denied approval', async () => {
      prisma.jarvisApproval.findFirst.mockResolvedValue({
        ...pendingApproval,
        status: JarvisApprovalStatus.DENIED,
      });

      await expect(
        service.approve(
          'merchant-1',
          'approval-1',
          'owner-user',
        ),
      ).rejects.toThrow(
        'Approval is already DENIED.',
      );

      expect(
        prisma.jarvisApproval.updateMany,
      ).not.toHaveBeenCalled();
    });

    it('deny -> cannot transition an already-approved approval', async () => {
      prisma.jarvisApproval.findFirst.mockResolvedValue({
        ...pendingApproval,
        status: JarvisApprovalStatus.APPROVED,
      });

      await expect(
        service.deny(
          'merchant-1',
          'approval-1',
          'owner-user',
        ),
      ).rejects.toThrow(
        'Approval is already APPROVED.',
      );

      expect(
        prisma.jarvisApproval.updateMany,
      ).not.toHaveBeenCalled();
    });
  });

});
