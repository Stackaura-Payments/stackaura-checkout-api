import { PaymentStatus } from '@prisma/client';
import { PaymentRoutingIntelligenceService } from './payment-routing-intelligence.service';

describe('PaymentRoutingIntelligenceService', () => {
  it('ranks gateways using durable historical payment attempts', async () => {
    const prisma = {
      paymentAttempt: {
        findMany: jest.fn().mockResolvedValue([
          { gateway: 'PAYSTACK', status: 'FAILED', createdAt: new Date('2026-09-20T10:00:00Z'), payment: { status: PaymentStatus.FAILED, rawGateway: { code: 'timeout' } } },
          { gateway: 'PAYSTACK', status: 'PAID', createdAt: new Date('2026-09-20T11:00:00Z'), payment: { status: PaymentStatus.PAID, rawGateway: null } },
          { gateway: 'YOCO', status: 'PAID', createdAt: new Date('2026-09-20T12:00:00Z'), payment: { status: PaymentStatus.PAID, rawGateway: null } },
          { gateway: 'YOCO', status: 'PAID', createdAt: new Date('2026-09-20T13:00:00Z'), payment: { status: PaymentStatus.PAID, rawGateway: null } },
        ]),
      },
    } as any;
    const service = new PaymentRoutingIntelligenceService(prisma);

    const result = await service.analyze('merchant-1');

    expect(result.recommendedGateway).toBe('YOCO');
    expect(result.rankedGateways).toEqual(['YOCO', 'PAYSTACK']);
    expect(result.gateways.find((item) => item.gateway === 'PAYSTACK')).toEqual(
      expect.objectContaining({ attempts: 2, failures: 1, failureRate: 50 }),
    );
    expect(result.explanation).toContain('YOCO');
  });

  it('does not invent a preference when there is no historical activity', async () => {
    const prisma = { paymentAttempt: { findMany: jest.fn().mockResolvedValue([]) } } as any;
    const service = new PaymentRoutingIntelligenceService(prisma);

    const result = await service.analyze('merchant-1');

    expect(result.recommendedGateway).toBeNull();
    expect(result.rankedGateways).toEqual([]);
    expect(result.explanation).toContain('No historical');
  });
});
