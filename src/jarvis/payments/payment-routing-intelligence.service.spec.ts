import { PaymentStatus } from '@prisma/client';
import { PaymentRoutingIntelligenceService } from './payment-routing-intelligence.service';

describe('PaymentRoutingIntelligenceService', () => {
  const row = (gateway: string, status: string, createdAt: string, reference: string, paymentStatus: PaymentStatus) => ({
    gateway, status, createdAt: new Date(createdAt),
    payment: { status: paymentStatus, rawGateway: status === 'FAILED' ? { code: 'timeout' } : null, reference },
  });

  it('ranks gateways using recency-weighted historical outcomes', async () => {
    const prisma = {
      paymentAttempt: { findMany: jest.fn().mockResolvedValue([
        row('PAYSTACK', 'FAILED', '2026-09-23T10:00:00Z', 'INV-1', PaymentStatus.FAILED),
        row('PAYSTACK', 'PAID', '2026-09-23T11:00:00Z', 'INV-2', PaymentStatus.PAID),
        row('YOCO', 'PAID', '2026-09-23T12:00:00Z', 'INV-3', PaymentStatus.PAID),
        row('YOCO', 'PAID', '2026-09-23T13:00:00Z', 'INV-4', PaymentStatus.PAID),
      ]) },
    } as any;
    const result = await new PaymentRoutingIntelligenceService(prisma).analyze('merchant-1');
    expect(result.recommendedGateway).toBe('YOCO');
    expect(result.gateways.find((item) => item.gateway === 'PAYSTACK')).toEqual(expect.objectContaining({ attempts: 2, failures: 1, failureRate: 50 }));
    expect(result.learning.model).toBe('recency-weighted');
    expect(result.learning.halfLifeHours).toBe(72);
    expect(result.explanation).toContain('YOCO');
  });

  it('detects post-failover recovery signals from multi-gateway payment attempts', async () => {
    const prisma = {
      paymentAttempt: { findMany: jest.fn().mockResolvedValue([
        row('PAYSTACK', 'FAILED', '2026-09-23T10:00:00Z', 'INV-1', PaymentStatus.FAILED),
        row('YOCO', 'PAID', '2026-09-23T10:02:00Z', 'INV-1', PaymentStatus.PAID),
        row('PAYSTACK', 'FAILED', '2026-09-23T11:00:00Z', 'INV-2', PaymentStatus.FAILED),
        row('YOCO', 'FAILED', '2026-09-23T11:02:00Z', 'INV-2', PaymentStatus.FAILED),
      ]) },
    } as any;
    const result = await new PaymentRoutingIntelligenceService(prisma).analyze('merchant-1');
    expect(result.learning.postFailoverSignals).toBe(2);
    expect(result.learning.successfulRecoveries).toBe(1);
    expect(result.learning.failedRecoveries).toBe(1);
    expect(result.evidence.some((item) => item.includes('1 of 2'))).toBe(true);
  });

  it('returns low confidence for sparse history', async () => {
    const prisma = { paymentAttempt: { findMany: jest.fn().mockResolvedValue([
      row('YOCO', 'PAID', '2026-09-23T12:00:00Z', 'INV-1', PaymentStatus.PAID),
    ]) } } as any;
    const result = await new PaymentRoutingIntelligenceService(prisma).analyze('merchant-1');
    expect(result.gateways[0].confidence).toBe('low');
  });

  it('does not invent a preference when there is no historical activity', async () => {
    const prisma = { paymentAttempt: { findMany: jest.fn().mockResolvedValue([]) } } as any;
    const result = await new PaymentRoutingIntelligenceService(prisma).analyze('merchant-1');
    expect(result.recommendedGateway).toBeNull();
    expect(result.rankedGateways).toEqual([]);
    expect(result.explanation).toContain('No historical');
  });
});
