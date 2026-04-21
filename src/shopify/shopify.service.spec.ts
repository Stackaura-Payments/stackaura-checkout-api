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
  afterEach(() => {
    jest.restoreAllMocks();
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
        }),
      ],
    });
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
