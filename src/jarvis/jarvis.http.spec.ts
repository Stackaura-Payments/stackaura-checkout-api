import {
  INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { JarvisController } from './jarvis.controller';
import { JarvisService } from './jarvis.service';
import { AuditService } from './audit/audit.service';
import { ApprovalService } from './approvals/approval.service';
import { ToolExecutor } from './tools/tool.executor';
import { OwnerToolExecutor } from './owner/owner-tool.executor';
import { OwnerOperationService } from './owner/owner-operation.service';
import { AgentRegistry } from './agents/agent.registry';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AuthService } from '../auth/auth.service';

describe('JARVIS HTTP boundary', () => {
  const originalAdminEmails = process.env.STACKAURA_ADMIN_EMAILS;

  beforeAll(() => {
    process.env.STACKAURA_ADMIN_EMAILS = 'owner@example.com';
  });

  afterAll(() => {
    if (originalAdminEmails === undefined) {
      delete process.env.STACKAURA_ADMIN_EMAILS;
    } else {
      process.env.STACKAURA_ADMIN_EMAILS = originalAdminEmails;
    }
  });

  let app: INestApplication;

  const authService = {
    resolveSession: jest.fn(),
  };

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

  const ownerOperationService = {
    list: jest.fn().mockResolvedValue([]),
  };

  const agentRegistry = {
    list: jest.fn().mockReturnValue([]),
  };

  beforeAll(async () => {
    const module: TestingModule =
      await Test.createTestingModule({
        controllers: [JarvisController],
        providers: [
          {
            provide: AuthService,
            useValue: authService,
          },
          {
            provide: JarvisService,
            useValue: jarvisService,
          },
          {
            provide: AuditService,
            useValue: auditService,
          },
          {
            provide: ApprovalService,
            useValue: approvalService,
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
            provide: OwnerOperationService,
            useValue: ownerOperationService,
          },
          {
            provide: AgentRegistry,
            useValue: agentRegistry,
          },
        ],
      }).compile();

    app = module.createNestApplication();

    app.use(require('cookie-parser')());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authService.resolveSession.mockResolvedValue(null);
  });

  describe('authentication boundary', () => {
    it('returns 401 for an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .post('/jarvis/ask')
        .send({
          message: 'Check Stackaura',
        })
        .expect(401);

      expect(jarvisService.ask).not.toHaveBeenCalled();
    });

    it('returns 401 for an unauthenticated approval request', async () => {
      await request(app.getHttpServer())
        .post('/jarvis/approvals')
        .send({
          toolId: 'jarvis.approval-test',
          intent: 'approval-test',
        })
        .expect(401);

      expect(approvalService.create).not.toHaveBeenCalled();
    });

    it('returns 401 for an unauthenticated execution request', async () => {
      await request(app.getHttpServer())
        .post('/jarvis/execute')
        .send({
          toolId: 'jarvis.approval-test',
          intent: 'approval-test',
          approved: true,
        })
        .expect(401);

      expect(toolExecutor.execute).not.toHaveBeenCalled();
    });

    it('returns 401 for an unauthenticated owner execution request', async () => {
      await request(app.getHttpServer())
        .post('/jarvis/owner/execute')
        .send({
          toolId: 'jarvis.owner-operations.list',
          intent: 'list-owner-operations',
        })
        .expect(401);

      expect(ownerToolExecutor.execute).not.toHaveBeenCalled();
    });

    it('returns 401 for an unauthenticated approval decision', async () => {
      await request(app.getHttpServer())
        .post('/jarvis/approvals/approval-1/approve')
        .expect(401);

      expect(approvalService.approve).not.toHaveBeenCalled();
    });

    it('returns 401 for an unauthenticated execution audit request', async () => {
      await request(app.getHttpServer())
        .get('/jarvis/executions')
        .expect(401);

      expect(auditService.list).not.toHaveBeenCalled();
    });
  });

  describe('production route prefix', () => {
    it('serves JARVIS under the production /v1 prefix', async () => {
      const prefixedModule: TestingModule =
        await Test.createTestingModule({
          controllers: [JarvisController],
          providers: [
            {
              provide: AuthService,
              useValue: authService,
            },
            {
              provide: JarvisService,
              useValue: jarvisService,
            },
            {
              provide: AuditService,
              useValue: auditService,
            },
            {
              provide: ApprovalService,
              useValue: approvalService,
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
              provide: OwnerOperationService,
              useValue: ownerOperationService,
            },
            {
              provide: AgentRegistry,
              useValue: agentRegistry,
            },
          ],
        }).compile();

      const prefixedApp =
        prefixedModule.createNestApplication();

      prefixedApp.use(require('cookie-parser')());
      prefixedApp.setGlobalPrefix('v1');

      authService.resolveSession.mockResolvedValue({
        user: {
          id: 'real-user',
          email: 'owner@example.com',
        },
        memberships: [
          {
            id: 'membership-1',
            role: 'OWNER',
            merchant: {
              id: 'real-merchant',
              name: 'Real Merchant',
            },
          },
        ],
      });

      jarvisService.ask.mockResolvedValue({
        message: 'Stackaura is healthy.',
        agent: 'chief-of-staff',
        intent: 'status',
        actions: ['command-center.overview'],
        requiresApproval: false,
      });

      await prefixedApp.init();

      try {
        await request(prefixedApp.getHttpServer())
          .post('/v1/jarvis/ask')
          .send({
            message: 'Check Stackaura',
          })
          .expect(201);

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
      } finally {
        await prefixedApp.close();
      }
    });
  });

  describe('authenticated request boundary', () => {
    const authenticatedSession = {
      user: {
        id: 'real-user',
        email: 'owner@example.com',
      },
      memberships: [
        {
          id: 'membership-1',
          role: 'OWNER',
          merchant: {
            id: 'real-merchant',
            name: 'Real Merchant',
          },
        },
      ],
    };

    beforeEach(() => {
      authService.resolveSession.mockResolvedValue(
        authenticatedSession,
      );
    });

    it('passes the authenticated session into /jarvis/ask', async () => {
      jarvisService.ask.mockResolvedValue({
        message: 'Stackaura is healthy.',
      });

      await request(app.getHttpServer())
        .post('/jarvis/ask')
        .send({
          message: 'Check Stackaura',
          merchantId: 'attacker-merchant',
          userId: 'attacker-user',
        })
        .expect(201);

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

    it('completes the approval lifecycle across ask, approve, and execute', async () => {
      jarvisService.ask.mockResolvedValue({
        message:
          'Approval is required before I can execute "jarvis.approval-test".',
        agent: 'chief-of-staff',
        intent: 'approval-test',
        actions: ['jarvis.approval-test'],
        requiresApproval: true,
        data: [
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
            },
          },
        ],
      });

      approvalService.approve.mockResolvedValue({
        id: 'approval-123',
        status: 'APPROVED',
      });

      toolExecutor.execute.mockResolvedValue({
        ok: true,
        message: 'Approval-gated JARVIS tool executed successfully.',
      });

      const askResponse =
        await request(app.getHttpServer())
          .post('/jarvis/ask')
          .send({
            message: 'Run the approval workflow test',
          })
          .expect(201);

      expect(askResponse.body).toEqual(
        expect.objectContaining({
          requiresApproval: true,
        }),
      );

      expect(jarvisService.ask).toHaveBeenCalledWith({
        message: 'Run the approval workflow test',
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

      const approvalResponse =
        await request(app.getHttpServer())
          .post('/jarvis/approvals/approval-123/approve')
          .send({
            merchantId: 'attacker-merchant',
            userId: 'attacker-user',
          })
          .expect(201);

      expect(approvalResponse.body).toEqual({
        id: 'approval-123',
        status: 'APPROVED',
      });

      expect(approvalService.approve).toHaveBeenCalledWith(
        'real-merchant',
        'approval-123',
        'real-user',
      );

      const executeResponse =
        await request(app.getHttpServer())
          .post('/jarvis/execute')
          .send({
            toolId: 'jarvis.approval-test',
            intent: 'approval-test',
            arguments: {
              message: 'Run the approval workflow test',
            },
            approvalId: 'approval-123',
            approved: true,
            merchantId: 'attacker-merchant',
            userId: 'attacker-user',
          })
          .expect(201);

      expect(executeResponse.body).toEqual({
        ok: true,
        message:
          'Approval-gated JARVIS tool executed successfully.',
      });

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
            message: 'Run the approval workflow test',
          },
          approvalId: 'approval-123',
        },
      );
    });

    it('does not allow approved=true to bypass the executor boundary', async () => {
      toolExecutor.execute.mockResolvedValue({
        ok: true,
      });

      await request(app.getHttpServer())
        .post('/jarvis/execute')
        .send({
          toolId: 'jarvis.approval-test',
          intent: 'approval-test',
          arguments: {
            message: 'test',
          },
          approved: true,
          merchantId: 'attacker-merchant',
          userId: 'attacker-user',
        })
        .expect(201);

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
          approvalId: undefined,
        },
      );
    });

    it('routes an authenticated owner request to OwnerToolExecutor', async () => {
      ownerToolExecutor.execute.mockResolvedValue([]);

      await request(app.getHttpServer())
        .post('/jarvis/owner/execute')
        .send({
          toolId: 'jarvis.owner-operations.list',
          intent: 'list-owner-operations',
          arguments: { limit: 10 },
        })
        .expect(201);

      expect(ownerToolExecutor.execute).toHaveBeenCalledWith(
        'jarvis.owner-operations.list',
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
          intent: 'list-owner-operations',
          arguments: { limit: 10 },
        },
      );
      expect(toolExecutor.execute).not.toHaveBeenCalled();
    });

    it('uses authenticated merchant and user for approval decisions', async () => {
      approvalService.approve.mockResolvedValue({
        id: 'approval-1',
        status: 'APPROVED',
      });

      await request(app.getHttpServer())
        .post('/jarvis/approvals/approval-1/approve')
        .send({
          merchantId: 'attacker-merchant',
          userId: 'attacker-user',
        })
        .expect(201);

      expect(approvalService.approve).toHaveBeenCalledWith(
        'real-merchant',
        'approval-1',
        'real-user',
      );
    });

    it('uses authenticated merchant and user for denial', async () => {
      approvalService.deny.mockResolvedValue({
        id: 'approval-1',
        status: 'DENIED',
      });

      await request(app.getHttpServer())
        .post('/jarvis/approvals/approval-1/deny')
        .send({
          merchantId: 'attacker-merchant',
          userId: 'attacker-user',
        })
        .expect(201);

      expect(approvalService.deny).toHaveBeenCalledWith(
        'real-merchant',
        'approval-1',
        'real-user',
      );
    });

    it('scopes pending approvals to the authenticated merchant', async () => {
      approvalService.getPending.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get('/jarvis/approvals')
        .expect(200);

      expect(approvalService.getPending).toHaveBeenCalledWith(
        'real-merchant',
      );
    });

    it('scopes execution audit records to the authenticated merchant', async () => {
      auditService.list.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get('/jarvis/executions')
        .query({
          limit: '10',
        })
        .expect(200);

      expect(auditService.list).toHaveBeenCalledWith({
        merchantId: 'real-merchant',
        status: undefined,
        agent: undefined,
        toolId: undefined,
        limit: 10,
      });
    });
  });
});
