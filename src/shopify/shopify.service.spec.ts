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
