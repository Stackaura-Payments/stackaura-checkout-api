import { NotFoundException } from '@nestjs/common';
import { GatewayProvider, PaymentStatus, WebhookDeliveryStatus } from '@prisma/client';
import { PaymentsAgentService } from './payments-agent.service';

describe('PaymentsAgentService', () => {
  const prisma = {
    merchant: { findUnique: jest.fn() },
    payment: { groupBy: jest.fn(), findMany: jest.fn() },
    paymentAttempt: { groupBy: jest.fn() },
    webhookDelivery: { groupBy: jest.fn() },
  };

  let service: PaymentsAgentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PaymentsAgentService(prisma as any);
  });

  it('returns real merchant payment, gateway and webhook metrics', async () => {
    prisma.merchant.findUnique.mockResolvedValue({ id: 'm1', name: 'Stackaura', isActive: true });
    prisma.payment.groupBy.mockResolvedValue([
      { status: PaymentStatus.PAID, _count: { _all: 8 }, _sum: { amountCents: 125000 } },
      { status: PaymentStatus.FAILED, _count: { _all: 2 }, _sum: { amountCents: 20000 } },
      { status: PaymentStatus.PENDING, _count: { _all: 1 }, _sum: { amountCents: 5000 } },
    ]);
    prisma.paymentAttempt.groupBy.mockResolvedValue([
      { gateway: GatewayProvider.PAYSTACK, status: 'PAID', _count: { _all: 6 } },
      { gateway: GatewayProvider.PAYSTACK, status: 'FAILED', _count: { _all: 1 } },
      { gateway: GatewayProvider.YOCO, status: 'SUCCESS', _count: { _all: 3 } },
    ]);
    prisma.webhookDelivery.groupBy.mockResolvedValue([
      { status: WebhookDeliveryStatus.SUCCESS, _count: { _all: 9 } },
      { status: WebhookDeliveryStatus.FAILED, _count: { _all: 1 } },
    ]);

    const result = await service.getStatus('m1', 60);

    expect(result.merchant.id).toBe('m1');
    expect(result.payments.PAID).toBe(8);
    expect(result.payments.FAILED).toBe(2);
    expect(result.payments.grossPaidCents).toBe(125000);
    expect(result.payments.successRate).toBe(80);
    expect(result.gateways).toEqual(expect.arrayContaining([
      expect.objectContaining({
        gateway: GatewayProvider.PAYSTACK,
        attempts: 7,
        successfulAttempts: 6,
        failedAttempts: 1,
        failureRate: 14.29,
        state: 'ACTIVE',
      }),
    ]));
    expect(result.webhooks.SUCCESS).toBe(9);
    expect(result.webhooks.FAILED).toBe(1);
  });

  it('returns recent payments directly from the payment source', async () => {
    const createdAt = new Date('2026-09-23T10:00:00.000Z');
    const updatedAt = new Date('2026-09-23T10:01:00.000Z');
    prisma.payment.findMany.mockResolvedValue([{
      id: 'p1', reference: 'INV-1', amountCents: 1000, currency: 'ZAR',
      status: PaymentStatus.PAID, gateway: GatewayProvider.YOCO, gatewayRef: 'y1',
      createdAt, updatedAt,
    }]);

    const result = await service.getRecentPayments('m1', 10);

    expect(prisma.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { merchantId: 'm1' },
      take: 10,
    }));
    expect(result.count).toBe(1);
    expect(result.payments[0].reference).toBe('INV-1');
    expect(result.payments[0].createdAt).toBe(createdAt.toISOString());
  });

  it('groups failed payments by gateway', async () => {
    const createdAt = new Date('2026-09-23T10:00:00.000Z');
    prisma.payment.findMany.mockResolvedValue([
      { id: 'p1', reference: 'A', amountCents: 1000, currency: 'ZAR', gateway: GatewayProvider.OZOW, gatewayRef: 'o1', rawGateway: { code: 'DECLINED' }, createdAt, updatedAt: createdAt },
      { id: 'p2', reference: 'B', amountCents: 2000, currency: 'ZAR', gateway: GatewayProvider.OZOW, gatewayRef: 'o2', rawGateway: { code: 'DECLINED' }, createdAt, updatedAt: createdAt },
      { id: 'p3', reference: 'C', amountCents: 3000, currency: 'ZAR', gateway: GatewayProvider.PAYSTACK, gatewayRef: 'p3', rawGateway: { code: 'TIMEOUT' }, createdAt, updatedAt: createdAt },
    ]);

    const result = await service.getFailures('m1', 60);

    expect(result.totalFailures).toBe(3);
    expect(result.byGateway[0]).toEqual({
      gateway: GatewayProvider.OZOW, count: 2, references: ['A', 'B'],
    });
    expect(result.byGateway[1].gateway).toBe(GatewayProvider.PAYSTACK);
  });

  it('rejects an unknown merchant', async () => {
    prisma.merchant.findUnique.mockResolvedValue(null);
    await expect(service.getStatus('missing')).rejects.toThrow(NotFoundException);
  });
});
