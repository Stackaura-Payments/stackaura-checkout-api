export type SupportCitation = {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  source: 'docs' | 'dashboard' | 'policy' | 'system';
};

export type SupportKnowledgeMatch = SupportCitation & {
  content: string;
  keywords: string[];
  score: number;
};

export type MerchantSupportEnvironment = 'test' | 'live' | 'mixed' | 'unknown';

export type MerchantSupportContext = {
  merchant: {
    id: string;
    name: string;
    email: string;
    isActive: boolean;
    accountStatus: 'ACTIVE' | 'PENDING_ACTIVATION';
    planCode: string;
    plan: {
      code: string;
      source: string;
      feeSource: string;
      manualGatewaySelection: boolean;
      autoRouting: boolean;
      fallback: boolean;
    };
    currentEnvironment: MerchantSupportEnvironment;
    createdAt: string;
    updatedAt: string;
  };
  gateways: {
    connectedCount: number;
    ozow: Record<string, unknown>;
    yoco: Record<string, unknown>;
    paystack: Record<string, unknown>;
  };
  apiKeys: {
    activeCount: number;
    testKeyCount: number;
    liveKeyCount: number;
    latestCreatedAt: string | null;
    latestLastUsedAt: string | null;
  };
  onboarding: {
    completed: boolean;
    status: 'COMPLETED' | 'PENDING_ACTIVATION';
    detail: string;
  };
  payments: {
    totalPayments: number;
    totalVolumeCents: number;
    successRate: number;
    recoveredPayments: number;
    activeGatewaysUsed: number;
    recentFailures: Array<{
      reference: string;
      status: string;
      gateway: string | null;
      updatedAt: string;
      lastAttemptGateway: string | null;
      lastAttemptStatus: string | null;
    }>;
    recentRoutingIssues: Array<{
      reference: string;
      status: string;
      routeSummary: string;
      fallbackCount: number;
      createdAt: string;
    }>;
  };
  payouts: {
    pendingCount: number;
    failedCount: number;
    recent: Array<{
      reference: string;
      status: string;
      amountCents: number;
      currency: string;
      provider: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  kyc: {
    tracked: boolean;
    status: 'UNAVAILABLE';
    detail: string;
  };
  supportInboxEmail: string;
  generatedAt: string;
};

export type SupportAssistantReply = {
  content: string;
  citations: SupportCitation[];
  escalationRecommended: boolean;
  escalationReason: string | null;
  provider: 'openai' | 'fallback';
};
