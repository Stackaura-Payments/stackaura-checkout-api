import {
  GatewayProvider,
  PaymentStatus,
  WebhookDeliveryStatus,
} from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CommandCenterService } from './command-center.service';

describe('CommandCenterService', () => {
  let service: CommandCenterService;
  let prisma: {
    merchant: { findUnique: jest.Mock };
    payment: {
      groupBy: jest.Mock;
      aggregate: jest.Mock;
      findMany: jest.Mock;
    };
    webhookDelivery: { groupBy: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      merchant: {
        findUnique: jest.fn(),
      },
      payment: {
        groupBy: jest.fn(),
        aggregate: jest.fn(),
        findMany: jest.fn(),
      },
      webhookDelivery: {
        groupBy: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommandCenterService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CommandCenterService>(CommandCenterService);
  });

  it('returns the correct merchant overview', async () => {
    mockOverviewData();

    const overview = await service.getOverview('m-1');

    expect(overview).toEqual(
      expect.objectContaining({
        merchant: {
          id: 'm-1',
          name: 'Merchant One',
        },
        updatedAt: expect.any(String),
      }),
    );
    expect(prisma.merchant.findUnique).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      select: { id: true, name: true, isActive: true },
    });
  });

  it('correctly calculates today paid revenue and financial metrics', async () => {
    mockOverviewData();

    const overview = await service.getOverview('m-1');

    expect(overview.today).toEqual(
      expect.objectContaining({
        grossRevenueCents: 15000,
        platformFeesCents: 750,
        providerFeesCents: 300,
        merchantNetCents: 13950,
      }),
    );
    expect(prisma.payment.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          merchantId: 'm-1',
          status: PaymentStatus.PAID,
          createdAt: { gte: expect.any(Date) },
        }),
        _sum: {
          amountCents: true,
          platformFeeCents: true,
          providerFeeCents: true,
          merchantNetCents: true,
        },
      }),
    );
  });

  it('correctly calculates transaction status counts', async () => {
    mockOverviewData();

    const overview = await service.getOverview('m-1');

    expect(overview.today).toEqual(
      expect.objectContaining({
        totalTransactions: 8,
        paidTransactions: 3,
        pendingTransactions: 2,
        failedTransactions: 1,
        cancelledTransactions: 1,
        refundedTransactions: 1,
      }),
    );
  });

  it('correctly calculates payment success rate', async () => {
    mockOverviewData();

    const overview = await service.getOverview('m-1');

    expect(overview.today.successRate).toBe(60);
  });

  it('correctly aggregates gateway activity for all providers', async () => {
    mockOverviewData();

    const overview = await service.getOverview('m-1');

    expect(overview.gateways).toEqual([
      {
        gateway: GatewayProvider.PAYFAST,
        transactionCount: 3,
        paidTransactionCount: 2,
        paidRevenueCents: 9000,
      },
      {
        gateway: GatewayProvider.OZOW,
        transactionCount: 1,
        paidTransactionCount: 1,
        paidRevenueCents: 6000,
      },
      {
        gateway: GatewayProvider.YOCO,
        transactionCount: 1,
        paidTransactionCount: 0,
        paidRevenueCents: 0,
      },
      {
        gateway: GatewayProvider.PAYSTACK,
        transactionCount: 1,
        paidTransactionCount: 0,
        paidRevenueCents: 0,
      },
      {
        gateway: GatewayProvider.PEACH,
        transactionCount: 0,
        paidTransactionCount: 0,
        paidRevenueCents: 0,
      },
    ]);
  });

  it('correctly aggregates webhook delivery health', async () => {
    mockOverviewData();

    const overview = await service.getOverview('m-1');

    expect(overview.webhooks).toEqual({
      totalSampledDeliveries: 8,
      successful: 4,
      failed: 2,
      pending: 1,
      skipped: 1,
      successRate: 50,
    });
    expect(prisma.webhookDelivery.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: {
        webhookEndpoint: {
          merchantId: 'm-1',
          isActive: true,
        },
      },
      _count: { _all: true },
    });
  });

  it('returns the latest 10 payments', async () => {
    mockOverviewData();

    const overview = await service.getOverview('m-1');

    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { merchantId: 'm-1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
      select: {
        id: true,
        reference: true,
        amountCents: true,
        currency: true,
        status: true,
        gateway: true,
        gatewayRef: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(overview.recentPayments).toHaveLength(10);
    expect(overview.recentPayments[0]).toEqual({
      id: 'p-1',
      reference: 'PAY-1',
      amountCents: 1000,
      currency: 'ZAR',
      status: PaymentStatus.PAID,
      gateway: GatewayProvider.PAYFAST,
      gatewayRef: 'gw-1',
      createdAt: '2026-08-31T09:59:00.000Z',
      updatedAt: '2026-08-31T10:00:00.000Z',
    });
  });

  it('does not expose sensitive merchant credentials', async () => {
    mockOverviewData();

    const overview = await service.getOverview('m-1');

    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('paystackSecretKey');
    expect(serialized).not.toContain('yocoSecretKey');
    expect(serialized).not.toContain('ozowPrivateKey');
    expect(serialized).not.toContain('ozowApiKey');
    expect(serialized).not.toContain('payfastMerchantKey');
    expect(serialized).not.toContain('payfastPassphrase');
    expect(serialized).not.toContain('webhook-secret');
  });

  function mockOverviewData() {
    prisma.merchant.findUnique.mockResolvedValue({
      id: 'm-1',
      name: 'Merchant One',
      isActive: true,
    });
    prisma.payment.groupBy.mockResolvedValueOnce([
      { status: PaymentStatus.PAID, _count: { _all: 3 } },
      { status: PaymentStatus.PENDING, _count: { _all: 2 } },
      { status: PaymentStatus.FAILED, _count: { _all: 1 } },
      { status: PaymentStatus.CANCELLED, _count: { _all: 1 } },
      { status: PaymentStatus.REFUNDED, _count: { _all: 1 } },
    ]);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: {
        amountCents: 15000,
        platformFeeCents: 750,
        providerFeeCents: 300,
        merchantNetCents: 13950,
      },
    });
    prisma.payment.groupBy.mockResolvedValueOnce([
      {
        gateway: GatewayProvider.PAYFAST,
        status: PaymentStatus.PAID,
        _count: { _all: 2 },
        _sum: { amountCents: 9000 },
      },
      {
        gateway: GatewayProvider.PAYFAST,
        status: PaymentStatus.FAILED,
        _count: { _all: 1 },
        _sum: { amountCents: 2000 },
      },
      {
        gateway: GatewayProvider.OZOW,
        status: PaymentStatus.PAID,
        _count: { _all: 1 },
        _sum: { amountCents: 6000 },
      },
      {
        gateway: GatewayProvider.YOCO,
        status: PaymentStatus.PENDING,
        _count: { _all: 1 },
        _sum: { amountCents: 4000 },
      },
      {
        gateway: GatewayProvider.PAYSTACK,
        status: PaymentStatus.CANCELLED,
        _count: { _all: 1 },
        _sum: { amountCents: 3000 },
      },
    ]);
    prisma.webhookDelivery.groupBy.mockResolvedValue([
      { status: WebhookDeliveryStatus.SUCCESS, _count: { _all: 4 } },
      { status: WebhookDeliveryStatus.FAILED, _count: { _all: 2 } },
      { status: WebhookDeliveryStatus.PENDING, _count: { _all: 1 } },
      { status: WebhookDeliveryStatus.SKIPPED, _count: { _all: 1 } },
    ]);
    prisma.payment.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `p-${index + 1}`,
        reference: `PAY-${index + 1}`,
        amountCents: (index + 1) * 1000,
        currency: 'ZAR',
        status: index === 0 ? PaymentStatus.PAID : PaymentStatus.PENDING,
        gateway: index === 0 ? GatewayProvider.PAYFAST : GatewayProvider.OZOW,
        gatewayRef: `gw-${index + 1}`,
        createdAt: new Date(`2026-08-31T09:${59 - index}:00.000Z`),
        updatedAt: new Date(`2026-08-31T10:${index
          .toString()
          .padStart(2, '0')}:00.000Z`),
      })),
    );
  }
});
