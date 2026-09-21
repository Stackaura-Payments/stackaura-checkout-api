import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { ShopifyService } from './shopify.service';

describe('ShopifyService webhook handling', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SHOPIFY_API_SECRET: 'test-shopify-secret',
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  function buildSignature(payload: string) {
    return createHmac('sha256', process.env.SHOPIFY_API_SECRET!)
      .update(payload)
      .digest('base64');
  }

  it('deletes an existing install on app/uninstalled and logs cleanup details', async () => {
    const prisma = {
      shopifyInstall: {
        findUnique: jest.fn().mockResolvedValue({ id: 'install-1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;

    const service = new ShopifyService(prisma);
    const logger = (service as any).logger;
    const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);

    const payload = JSON.stringify({ app_id: 123 });
    const result = await service.handleWebhook(
      { app_id: 123 },
      {
        rawBody: payload,
        headers: {
          'x-shopify-hmac-sha256': buildSignature(payload),
          'x-shopify-topic': 'app/uninstalled',
          'x-shopify-shop-domain': 'stackaura-dev.myshopify.com',
          'x-shopify-webhook-id': 'webhook-1',
        },
      },
    );

    expect(result).toEqual({
      ok: true,
      topic: 'app/uninstalled',
      shopDomain: 'stackaura-dev.myshopify.com',
    });
    expect(prisma.shopifyInstall.findUnique).toHaveBeenCalledWith({
      where: { shopDomain: 'stackaura-dev.myshopify.com' },
      select: { id: true },
    });
    expect(prisma.shopifyInstall.deleteMany).toHaveBeenCalledWith({
      where: { shopDomain: 'stackaura-dev.myshopify.com' },
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"cleanupActionTaken":"delete_install_record"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"recordDeleted":true'),
    );
  });

  it('rejects invalid HMAC and logs the failed verification result', async () => {
    const prisma = {
      shopifyInstall: {
        findUnique: jest.fn(),
        deleteMany: jest.fn(),
      },
    } as any;

    const service = new ShopifyService(prisma);
    const logger = (service as any).logger;
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(
      service.handleWebhook(
        { app_id: 123 },
        {
          rawBody: JSON.stringify({ app_id: 123 }),
          headers: {
            'x-shopify-hmac-sha256': 'invalid-signature',
            'x-shopify-topic': 'app/uninstalled',
            'x-shopify-shop-domain': 'stackaura-dev.myshopify.com',
          },
        },
      ),
    ).rejects.toThrow(new UnauthorizedException('Invalid Shopify webhook signature'));

    expect(prisma.shopifyInstall.findUnique).not.toHaveBeenCalled();
    expect(prisma.shopifyInstall.deleteMany).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"hmacVerified":false'),
    );
  });
});

describe('ShopifyService storefront support chat', () => {
  const originalShopifyAiKey = process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY;
  const originalSupportAiKey = process.env.SUPPORT_AI_OPENAI_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY;
    delete process.env.SUPPORT_AI_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalShopifyAiKey === undefined) {
      delete process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY;
    } else {
      process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY = originalShopifyAiKey;
    }
    if (originalSupportAiKey === undefined) {
      delete process.env.SUPPORT_AI_OPENAI_API_KEY;
    } else {
      process.env.SUPPORT_AI_OPENAI_API_KEY = originalSupportAiKey;
    }
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  function createPrismaMock() {
    const conversation = { id: 'conversation-1' };

    return {
      shopifyInstall: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'install-1',
          shopDomain: 'stackaura-dev.myshopify.com',
          supportAgentConfig: {
            id: 'config-1',
            shopDomain: 'stackaura-dev.myshopify.com',
            enabled: true,
            greetingMessage: 'Hi there, how can we help you today?',
            supportEmail: 'support@stackaura.test',
            escalationEnabled: true,
            escalationLabel: 'Escalate to human',
            themePreference: 'auto',
            positionPreference: 'bottom-right',
            shippingInfo: 'Delivery usually takes 2-4 business days.',
            returnsPolicy: 'Returns are accepted within 14 days.',
            paymentMethodsEnabled: 'Paystack, Ozow, Yoco',
            storeHelpSummary: 'Stackaura dev store for testing payments.',
            storefrontWidgetActivatedAt: null,
            storefrontWidgetLastSeenAt: null,
            storefrontWidgetActivationSource: null,
            storefrontWidgetLastPageUrl: null,
            createdAt: new Date('2026-04-21T20:00:00.000Z'),
            updatedAt: new Date('2026-04-21T20:00:00.000Z'),
          },
        }),
      },
      shopifySupportConversation: {
        upsert: jest.fn().mockResolvedValue(conversation),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      shopifySupportConversationMessage: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    } as any;
  }

  it('answers Paystack storefront questions with a concrete gateway response', async () => {
    const prisma = createPrismaMock();
    const service = new ShopifyService(prisma);

    const result = await service.chatWithSupportAgent({
      shop: 'stackaura-dev.myshopify.com',
      sessionId: 'ss_test',
      message: 'Do you support Paystack payments?',
      pageUrl:
        'https://stackaura-dev.myshopify.com/?oseid=abc123&preview_theme_id=456&utm_source=theme-editor',
    });

    expect(result.reply).toContain('Paystack is supported');
    expect(result.replySource).toBe('deterministic');
    expect(result.fallbackReason).toBe('missing_ai_api_key');
    expect(result.reply).toContain('enabled and configured Paystack');
    expect(result.reply).not.toContain('lightweight help and routing');
    expect(result.reply).not.toContain('oseid');
    expect(result.reply).not.toContain('preview_theme_id');
  });

  it('persists sanitized storefront URLs for both stored messages', async () => {
    const prisma = createPrismaMock();
    const service = new ShopifyService(prisma);

    await service.chatWithSupportAgent({
      shop: 'stackaura-dev.myshopify.com',
      sessionId: 'ss_url',
      message: 'Can I pay by card?',
      pageUrl:
        'https://stackaura-dev.myshopify.com/products/test-product?variant=123&color=black&oseid=abc123&preview_theme_id=456#editor',
    });

    expect(
      prisma.shopifySupportConversationMessage.createMany,
    ).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          role: 'USER',
          pageUrl:
            'https://stackaura-dev.myshopify.com/products/test-product?color=black',
        }),
        expect.objectContaining({
          role: 'ASSISTANT',
          pageUrl:
            'https://stackaura-dev.myshopify.com/products/test-product?color=black',
          metadata: expect.objectContaining({
            source: 'deterministic',
            fallbackReason: 'missing_ai_api_key',
            escalationSuggested: false,
          }),
        }),
      ],
    });
  });

  it('uses AI replies when configured and confidence is acceptable', async () => {
    const originalApiKey = process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY;
    process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY = 'test-ai-key';
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        output_text: JSON.stringify({
          reply:
            'Yes, this store can answer from its saved support knowledge. Delivery usually takes 2-4 business days.',
          confidence: 0.82,
          escalationSuggested: false,
        }),
      }),
    } as any);
    const prisma = createPrismaMock();
    prisma.shopifySupportConversation.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'USER',
          message: 'Hi',
          pageUrl: 'https://stackaura-dev.myshopify.com/',
          createdAt: new Date('2026-04-21T20:01:00.000Z'),
        },
      ],
    });
    const service = new ShopifyService(prisma);

    try {
      const result = await service.chatWithSupportAgent({
        shop: 'stackaura-dev.myshopify.com',
        sessionId: 'ss_ai',
        message: 'How long does shipping take?',
        pageUrl: 'https://stackaura-dev.myshopify.com/products/test',
      });

      expect(result.replySource).toBe('ai');
      expect(result.replyConfidence).toBe(0.82);
      expect(result.reply).toContain('Delivery usually takes 2-4 business days');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/responses',
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer test-ai-key',
          }),
        }),
      );
      expect(
        prisma.shopifySupportConversationMessage.createMany,
      ).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            role: 'ASSISTANT',
            metadata: expect.objectContaining({
              source: 'ai',
              confidence: 0.82,
              fallbackReason: null,
              escalationSuggested: false,
            }),
          }),
        ]),
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY;
      } else {
        process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY = originalApiKey;
      }
    }
  });

  it('falls back to deterministic replies when AI confidence is low', async () => {
    const originalApiKey = process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY;
    process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY = 'test-ai-key';
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        output_text: JSON.stringify({
          reply: 'Maybe.',
          confidence: 0.2,
          escalationSuggested: false,
        }),
      }),
    } as any);
    const prisma = createPrismaMock();
    const service = new ShopifyService(prisma);

    try {
      const result = await service.chatWithSupportAgent({
        shop: 'stackaura-dev.myshopify.com',
        sessionId: 'ss_low_confidence',
        message: 'Can customers pay with Ozow?',
        pageUrl: 'https://stackaura-dev.myshopify.com/',
      });

      expect(result.replySource).toBe('deterministic');
      expect(result.replyConfidence).toBe(0.2);
      expect(result.fallbackReason).toBe('low_ai_confidence');
      expect(result.reply).toContain('Ozow is supported');
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY;
      } else {
        process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY = originalApiKey;
      }
    }
  });

  it('answers Ozow availability questions with an Ozow-specific gateway response', async () => {
    const prisma = createPrismaMock();
    const service = new ShopifyService(prisma);

    const result = await service.chatWithSupportAgent({
      shop: 'stackaura-dev.myshopify.com',
      sessionId: 'ss_ozow',
      message: 'Can customers pay with Ozow?',
      pageUrl: 'https://stackaura-dev.myshopify.com/',
    });

    expect(result.reply).toContain('Ozow is supported');
    expect(result.reply).toContain('instant EFT');
    expect(result.reply).toContain('enabled and configured Ozow');
    expect(result.reply).not.toContain('cannot inspect');
  });

  it('explains checkout flow without live transaction limitation wording', async () => {
    const prisma = createPrismaMock();
    const service = new ShopifyService(prisma);

    const result = await service.chatWithSupportAgent({
      shop: 'stackaura-dev.myshopify.com',
      sessionId: 'ss_checkout',
      message: 'How does checkout work?',
      pageUrl: 'https://stackaura-dev.myshopify.com/',
    });

    expect(result.reply).toContain(
      'connect supported payment providers, create a checkout or payment request',
    );
    expect(result.reply).toContain('webhook reconciliation');
    expect(result.reply).not.toContain('cannot inspect');
  });

  it('uses live transaction limitation text only for transaction-specific problems', async () => {
    const prisma = createPrismaMock();
    const service = new ShopifyService(prisma);

    const result = await service.chatWithSupportAgent({
      shop: 'stackaura-dev.myshopify.com',
      sessionId: 'ss_failed_payment',
      message: 'My payment failed, can you check it?',
      pageUrl: 'https://stackaura-dev.myshopify.com/',
    });

    expect(result.reply).toContain('failed, declined, pending, or missing');
    expect(result.reply).toContain('cannot inspect this specific live payment attempt');
  });
});
