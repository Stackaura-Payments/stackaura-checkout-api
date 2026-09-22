import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { JarvisExecutionStatus } from '@prisma/client';
import { JarvisController } from './jarvis.controller';

describe('JarvisController', () => {
  let controller: JarvisController;

  const jarvisService = {
    ask: jest.fn(),
  };

  const auditService = {
    list: jest.fn(),
  };

  const approvalService = {
    create: jest.fn(),
    getPending: jest.fn(),
    approve: jest.fn(),
    deny: jest.fn(),
  };

  const toolExecutor = {
    execute: jest.fn(),
  };

  const ownerToolExecutor = {
    execute: jest.fn(),
  };

  const session = {
    sessionAuth: {
      user: {
        id: 'real-user',
      },
      memberships: [
        {
          id: 'membership-1',
          role: 'OWNER',
          merchant: {
            id: 'real-merchant',
          },
        },
      ],
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    controller = new JarvisController(
      jarvisService as any,
      auditService as any,
      approvalService as any,
      toolExecutor as any,
      ownerToolExecutor as any,
    );
  });

  describe('ask', () => {
    it('uses authenticated user and merchant context', async () => {
      jarvisService.ask.mockResolvedValue({
        ok: true,
      });

      await controller.ask(
        {
          message: 'Check Stackaura',
          merchantId: 'attacker-merchant',
          userId: 'attacker-user',
        } as any,
        session as any,
      );

      expect(jarvisService.ask).toHaveBeenCalledWith({
        message: 'Check Stackaura',
        context: {
          identity: {
            ownerId: 'real-user',
            userId: 'real-user',
          },
          resource: {
            type: 'merchant',
            id: 'real-merchant',
          },
        },
      });
    });

    it('rejects when authenticated user is missing', async () => {
      await expect(
        controller.ask(
          {
            message: 'Check Stackaura',
          },
          {
            memberships: session.memberships,
          } as any,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(jarvisService.ask).not.toHaveBeenCalled();
    });

    it('rejects when authenticated merchant is missing', async () => {
      await expect(
        controller.ask(
          {
            message: 'Check Stackaura',
          },
          {
            user: session.user,
            memberships: [],
          } as any,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(jarvisService.ask).not.toHaveBeenCalled();
    });
  });

  describe('createApproval', () => {
    it('uses authenticated merchant and user instead of client-supplied identity', async () => {
      approvalService.create.mockResolvedValue({
        id: 'approval-1',
      });

      await controller.createApproval(
        {
          toolId: 'jarvis.approval-test',
          intent: 'approval-test',
          arguments: {
            message: 'test',
          },
          expiresAt: undefined,
          merchantId: 'attacker-merchant',
          userId: 'attacker-user',
        } as any,
        session as any,
      );

      expect(approvalService.create).toHaveBeenCalledWith({
        merchantId: 'real-merchant',
        userId: 'real-user',
        toolId: 'jarvis.approval-test',
        intent: 'approval-test',
        arguments: {
          message: 'test',
        },
        expiresAt: undefined,
      });
    });

    it('rejects invalid expiresAt before calling the service', async () => {
      await expect(
        controller.createApproval(
          {
            toolId: 'jarvis.approval-test',
            intent: 'approval-test',
            expiresAt: 'not-a-date',
          },
          session as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(approvalService.create).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('uses authenticated identity and does not pass client-approved=true', async () => {
      toolExecutor.execute.mockResolvedValue({
        ok: true,
      });

      await controller.execute(
        {
          toolId: 'jarvis.approval-test',
          intent: 'approval-test',
          arguments: {
            message: 'test',
          },
          approvalId: 'approval-1',
          approved: true,
          merchantId: 'attacker-merchant',
          userId: 'attacker-user',
        } as any,
        session as any,
      );

      expect(toolExecutor.execute).toHaveBeenCalledWith(
        'jarvis.approval-test',
        {
          identity: {
            ownerId: 'real-user',
            userId: 'real-user',
          },
          resource: {
            type: 'merchant',
            id: 'real-merchant',
          },
          agent: 'chief-of-staff',
          intent: 'approval-test',
          arguments: {
            message: 'test',
          },
          approvalId: 'approval-1',
        },
      );

      const context =
        toolExecutor.execute.mock.calls[0][1];

      expect(context.approved).toBeUndefined();
    });

    it('rejects when authenticated user is missing', async () => {
      await expect(
        controller.execute(
          {
            toolId: 'jarvis.approval-test',
            intent: 'approval-test',
          },
          {
            memberships: session.memberships,
          } as any,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(toolExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('owner/execute', () => {
    it('routes owner execution through OwnerToolExecutor without requiring merchant context', async () => {
      ownerToolExecutor.execute.mockResolvedValue({ ok: true });

      const ownerSession = {
        sessionAuth: {
          user: { id: 'real-user' },
          memberships: [],
        },
      };

      await controller.executeOwner(
        {
          toolId: 'jarvis.owner-operations.list',
          intent: 'list-owner-operations',
          arguments: { limit: 10 },
        },
        ownerSession as any,
      );

      expect(ownerToolExecutor.execute).toHaveBeenCalledWith(
        'jarvis.owner-operations.list',
        {
          identity: { ownerId: 'real-user', userId: 'real-user' },
          resource: undefined,
          agent: 'chief-of-staff',
          intent: 'list-owner-operations',
          arguments: { limit: 10 },
        },
      );
      expect(toolExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('approvals', () => {
    it('lists approvals only for the authenticated merchant', async () => {
      approvalService.getPending.mockResolvedValue([]);

      await controller.approvals(session as any);

      expect(approvalService.getPending).toHaveBeenCalledWith(
        'real-merchant',
      );
    });
  });

  describe('approve', () => {
    it('uses authenticated merchant and deciding user', async () => {
      approvalService.approve.mockResolvedValue({
        id: 'approval-1',
      });

      await controller.approve(
        session as any,
        'approval-1',
      );

      expect(approvalService.approve).toHaveBeenCalledWith(
        'real-merchant',
        'approval-1',
        'real-user',
      );
    });

    it('does not accept identity from request body', async () => {
      approvalService.approve.mockResolvedValue({
        id: 'approval-1',
      });

      await controller.approve(
        {
          ...session,
          body: {
            merchantId: 'attacker-merchant',
            userId: 'attacker-user',
          },
        } as any,
        'approval-1',
      );

      expect(approvalService.approve).toHaveBeenCalledWith(
        'real-merchant',
        'approval-1',
        'real-user',
      );
    });
  });

  describe('deny', () => {
    it('uses authenticated merchant and deciding user', async () => {
      approvalService.deny.mockResolvedValue({
        id: 'approval-1',
      });

      await controller.deny(
        session as any,
        'approval-1',
      );

      expect(approvalService.deny).toHaveBeenCalledWith(
        'real-merchant',
        'approval-1',
        'real-user',
      );
    });
  });

  describe('executions', () => {
    it('uses authenticated merchant scope', async () => {
      auditService.list.mockResolvedValue([]);

      await controller.executions(
        session as any,
        undefined,
        undefined,
        undefined,
        '10',
      );

      expect(auditService.list).toHaveBeenCalledWith({
        merchantId: 'real-merchant',
        status: undefined,
        agent: undefined,
        toolId: undefined,
        limit: 10,
      });
    });

    it('rejects a non-positive limit', async () => {
      await expect(
        controller.executions(
          session as any,
          undefined,
          undefined,
          undefined,
          '0',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(auditService.list).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric limit', async () => {
      await expect(
        controller.executions(
          session as any,
          undefined,
          undefined,
          undefined,
          'abc',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(auditService.list).not.toHaveBeenCalled();
    });

    it('rejects an invalid execution status', async () => {
      await expect(
        controller.executions(
          session as any,
          'NOT_A_STATUS',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(auditService.list).not.toHaveBeenCalled();
    });

    it('accepts a valid execution status', async () => {
      auditService.list.mockResolvedValue([]);

      await controller.executions(
        session as any,
        JarvisExecutionStatus.SUCCEEDED,
      );

      expect(auditService.list).toHaveBeenCalledWith({
        merchantId: 'real-merchant',
        status: JarvisExecutionStatus.SUCCEEDED,
        agent: undefined,
        toolId: undefined,
        limit: undefined,
      });
    });
  });
});
