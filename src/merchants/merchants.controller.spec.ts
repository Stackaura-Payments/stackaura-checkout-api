import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';
import type { ApiKeyRequest } from '../payouts/api-key.guard';

describe('MerchantsController', () => {
  let controller: MerchantsController;
  let merchantsService: {
    getOzowGatewayConnection: jest.Mock;
    configureOzowGateway: jest.Mock;
    getYocoGatewayConnection: jest.Mock;
    configureYocoGateway: jest.Mock;
  };

  beforeEach(async () => {
    merchantsService = {
      getOzowGatewayConnection: jest.fn(),
      configureOzowGateway: jest.fn(),
      getYocoGatewayConnection: jest.fn(),
      configureYocoGateway: jest.fn(),
    };

    const moduleBuilder = Test.createTestingModule({
      controllers: [MerchantsController],
      providers: [{ provide: MerchantsService, useValue: merchantsService }],
    });
    moduleBuilder
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: jest.fn(() => true) });

    const module: TestingModule = await moduleBuilder.compile();

    controller = module.get<MerchantsController>(MerchantsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns Ozow connection state for the authenticated merchant scope', async () => {
    merchantsService.getOzowGatewayConnection.mockResolvedValue({
      connected: true,
      siteCodeMasked: 'K20-K20-164',
      hasApiKey: true,
      hasPrivateKey: true,
      testMode: true,
      updatedAt: '2026-03-18T10:30:00.000Z',
    });

    const req = {
      apiKeyAuth: { merchantId: 'm-1' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.getOzowGatewayConnection(req, 'm-1'),
    ).resolves.toEqual({
      connected: true,
      siteCodeMasked: 'K20-K20-164',
      hasApiKey: true,
      hasPrivateKey: true,
      testMode: true,
      updatedAt: '2026-03-18T10:30:00.000Z',
    });

    expect(merchantsService.getOzowGatewayConnection).toHaveBeenCalledWith(
      'm-1',
    );
  });

  it('configures Ozow including per-merchant test mode', async () => {
    merchantsService.configureOzowGateway.mockResolvedValue({
      connected: true,
      siteCodeMasked: 'SC-1',
      hasApiKey: true,
      hasPrivateKey: true,
      testMode: false,
      updatedAt: '2026-03-18T10:31:00.000Z',
    });

    const req = {
      apiKeyAuth: { merchantId: 'm-1' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.configureOzowGateway(req, 'm-1', {
        siteCode: 'SC-1',
        privateKey: 'private-key',
        apiKey: 'api-key',
        testMode: false,
      }),
    ).resolves.toEqual({
      connected: true,
      siteCodeMasked: 'SC-1',
      hasApiKey: true,
      hasPrivateKey: true,
      testMode: false,
      updatedAt: '2026-03-18T10:31:00.000Z',
    });

    expect(merchantsService.configureOzowGateway).toHaveBeenCalledWith('m-1', {
      siteCode: 'SC-1',
      privateKey: 'private-key',
      apiKey: 'api-key',
      testMode: false,
    });
  });

  it('rejects Ozow GET when API key merchant scope mismatches path merchant', async () => {
    const req = {
      apiKeyAuth: { merchantId: 'm-2' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.getOzowGatewayConnection(req, 'm-1'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects Ozow POST when API key merchant scope mismatches path merchant', async () => {
    const req = {
      apiKeyAuth: { merchantId: 'm-2' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.configureOzowGateway(req, 'm-1', {
        siteCode: 'SC-1',
        privateKey: 'private-key',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns Yoco connection state for the authenticated merchant scope', async () => {
    merchantsService.getYocoGatewayConnection.mockResolvedValue({
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: true,
      updatedAt: '2026-03-18T10:35:00.000Z',
    });

    const req = {
      apiKeyAuth: { merchantId: 'm-1' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.getYocoGatewayConnection(req, 'm-1'),
    ).resolves.toEqual({
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: true,
      updatedAt: '2026-03-18T10:35:00.000Z',
    });

    expect(merchantsService.getYocoGatewayConnection).toHaveBeenCalledWith(
      'm-1',
    );
  });

  it('configures Yoco credentials including per-merchant test mode', async () => {
    merchantsService.configureYocoGateway.mockResolvedValue({
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: false,
      updatedAt: '2026-03-18T10:36:00.000Z',
    });

    const req = {
      apiKeyAuth: { merchantId: 'm-1' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.configureYocoGateway(req, 'm-1', {
        publicKey: 'pk_live_public',
        secretKey: 'sk_live_secret',
        testMode: false,
      }),
    ).resolves.toEqual({
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: false,
      updatedAt: '2026-03-18T10:36:00.000Z',
    });

    expect(merchantsService.configureYocoGateway).toHaveBeenCalledWith('m-1', {
      publicKey: 'pk_live_public',
      secretKey: 'sk_live_secret',
      testMode: false,
    });
  });

  it('rejects Yoco GET when API key merchant scope mismatches path merchant', async () => {
    const req = {
      apiKeyAuth: { merchantId: 'm-2' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.getYocoGatewayConnection(req, 'm-1'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects Yoco POST when API key merchant scope mismatches path merchant', async () => {
    const req = {
      apiKeyAuth: { merchantId: 'm-2' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.configureYocoGateway(req, 'm-1', {
        publicKey: 'pk_test_public',
        secretKey: 'sk_test_secret',
        testMode: true,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
