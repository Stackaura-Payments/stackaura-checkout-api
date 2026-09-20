import { JarvisAskResponseContract } from './contracts/jarvis-response.types';

describe('JARVIS response contract', () => {
  it('supports a normal successful tool response', () => {
    const response: JarvisAskResponseContract = {
      message: 'Stackaura is operating normally.',
      agent: 'chief-of-staff',
      intent: 'status',
      actions: ['command-center.overview'],
      requiresApproval: false,
      data: [
        {
          toolId: 'command-center.overview',
          intent: 'status',
          succeeded: true,
          result: {
            ok: true,
          },
        },
      ],
    };

    expect(response.requiresApproval).toBe(false);
    expect(response.data[0]).toMatchObject({
      toolId: 'command-center.overview',
      intent: 'status',
      succeeded: true,
    });
  });

  it('supports the frontend approval payload', () => {
    const response: JarvisAskResponseContract = {
      message: 'Approval is required before I can execute this action.',
      agent: 'engineering',
      intent: 'production-deploy',
      actions: ['engineering.production-deploy'],
      requiresApproval: true,
      data: [
        {
          toolId: 'engineering.production-deploy',
          intent: 'deploy',
          succeeded: false,
          error: 'This action requires approval before execution.',
          approval: {
            approvalId: 'approval-123',
            status: 'PENDING',
            toolId: 'engineering.production-deploy',
            intent: 'deploy',
            arguments: {
              environment: 'production',
            },
            requestedAt: new Date('2026-09-16T00:00:00.000Z'),
            expiresAt: null,
          },
        },
      ],
    };

    expect(response.requiresApproval).toBe(true);

    const step = response.data[0];

    expect(step.approval).toBeDefined();
    expect(step.approval).toMatchObject({
      approvalId: 'approval-123',
      status: 'PENDING',
      toolId: 'engineering.production-deploy',
      intent: 'deploy',
      arguments: {
        environment: 'production',
      },
      expiresAt: null,
    });
  });

  it('requires an approvalId for an approval response', () => {
    const approval = {
      approvalId: 'approval-123',
      status: 'PENDING',
      toolId: 'jarvis.approval-test',
      intent: 'approval-test',
      arguments: {
        message: 'test',
      },
      requestedAt: new Date('2026-09-16T00:00:00.000Z'),
      expiresAt: null,
    };

    expect(approval.approvalId).toBeTruthy();
    expect(approval.status).toBe('PENDING');
  });

  it('keeps human-only actions separate from approval workflow', () => {
    const response: JarvisAskResponseContract = {
      message: 'Direct human authorization is required.',
      agent: 'chief-of-staff',
      intent: 'human-authorization-required',
      actions: ['critical.action'],
      requiresApproval: true,
      data: [
        {
          toolId: 'critical.action',
          intent: 'critical-action',
          succeeded: false,
          error: 'Direct human authorization is required.',
        },
      ],
    };

    expect(response.data[0].approval).toBeUndefined();
    expect(response.data[0].succeeded).toBe(false);
  });
});
