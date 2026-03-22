import { SupportAiService } from './support-ai.service';
import type { MerchantSupportContext } from './support.types';

function buildContext(): MerchantSupportContext {
  return {
    merchant: {
      id: 'merchant-1',
      name: 'Stackaura Test Merchant',
      email: 'merchant@test.com',
      isActive: true,
      accountStatus: 'ACTIVE',
      planCode: 'growth',
      plan: {
        code: 'growth',
        source: 'merchant_plan',
        feeSource: 'merchant_plan',
        manualGatewaySelection: true,
        autoRouting: true,
        fallback: true,
      },
      currentEnvironment: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    gateways: {
      connectedCount: 1,
      ozow: { connected: true, testMode: true },
      yoco: { connected: false, testMode: true },
      paystack: { connected: false, testMode: true },
    },
    apiKeys: {
      activeCount: 1,
      testKeyCount: 1,
      liveKeyCount: 0,
      latestCreatedAt: new Date().toISOString(),
      latestLastUsedAt: null,
    },
    onboarding: {
      completed: true,
      status: 'COMPLETED',
      detail: 'Merchant is active.',
    },
    payments: {
      totalPayments: 4,
      totalVolumeCents: 9900,
      successRate: 75,
      recoveredPayments: 1,
      activeGatewaysUsed: 1,
      recentFailures: [],
      recentRoutingIssues: [],
    },
    payouts: {
      pendingCount: 0,
      failedCount: 0,
      recent: [],
    },
    kyc: {
      tracked: false,
      status: 'UNAVAILABLE',
      detail: 'KYC not tracked.',
    },
    supportInboxEmail: 'wesupport@stackaura.co.za',
    generatedAt: new Date().toISOString(),
  };
}

describe('SupportAiService', () => {
  it('recommends escalation for fraud-like issues in fallback mode', async () => {
    const service = new SupportAiService();
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousSupportAiKey = process.env.SUPPORT_AI_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SUPPORT_AI_OPENAI_API_KEY;

    try {
      const reply = await service.generateReply({
        merchantContext: buildContext(),
        userMessage:
          'I think there is fraud on my account and I need a human to review it',
        conversationHistory: [],
        knowledgeMatches: [],
      });

      expect(reply.provider).toBe('fallback');
      expect(reply.escalationRecommended).toBe(true);
      expect(reply.content).toContain('wesupport@stackaura.co.za');
    } finally {
      if (previousOpenAiKey) {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousSupportAiKey) {
        process.env.SUPPORT_AI_OPENAI_API_KEY = previousSupportAiKey;
      }
    }
  });
});
