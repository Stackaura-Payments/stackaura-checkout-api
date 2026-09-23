import { GatewayProvider, PaymentStatus } from '@prisma/client';
import { PaymentFailureDiagnosisService } from './payment-failure-diagnosis.service';

describe('PaymentFailureDiagnosisService', () => {
  const prisma = {
    payment: { findMany: jest.fn() },
    paymentAttempt: { groupBy: jest.fn() },
  };
  let service: PaymentFailureDiagnosisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PaymentFailureDiagnosisService(prisma as any);
  });

  it('correlates a dominant provider signature with timing and gateway concentration', async () => {
    const t1 = new Date('2026-09-23T14:12:00.000Z');
    const t2 = new Date('2026-09-23T14:20:00.000Z');
    prisma.payment.findMany.mockResolvedValue([
      { reference: 'A', gateway: GatewayProvider.PAYSTACK, rawGateway: { code: 'TIMEOUT', message: 'provider timeout' }, createdAt: t1 },
      { reference: 'B', gateway: GatewayProvider.PAYSTACK, rawGateway: { code: 'TIMEOUT', message: 'provider timeout' }, createdAt: t2 },
      { reference: 'C', gateway: GatewayProvider.PAYSTACK, rawGateway: { code: 'TIMEOUT', message: 'provider timeout' }, createdAt: t2 },
      { reference: 'D', gateway: GatewayProvider.YOCO, rawGateway: { code: 'DECLINED' }, createdAt: t2 },
    ]);
    prisma.paymentAttempt.groupBy.mockResolvedValue([
      { gateway: GatewayProvider.PAYSTACK, status: 'FAILED', _count: { _all: 3 } },
      { gateway: GatewayProvider.PAYSTACK, status: 'PAID', _count: { _all: 7 } },
      { gateway: GatewayProvider.YOCO, status: 'FAILED', _count: { _all: 1 } },
      { gateway: GatewayProvider.YOCO, status: 'SUCCESS', _count: { _all: 9 } },
    ]);

    const result = await service.diagnose('m1', 60);

    expect(result.totalFailures).toBe(4);
    expect(result.diagnosis.confidence).toBe('high');
    expect(result.diagnosis.category).toBe('provider');
    expect(result.dominantFailure).toEqual(expect.objectContaining({
      gateway: GatewayProvider.PAYSTACK,
      signature: 'timeout',
      count: 3,
      shareOfFailures: 75,
      firstSeenAt: t1.toISOString(),
      lastSeenAt: t2.toISOString(),
    }));
    expect(result.gatewayComparison[0]).toEqual(expect.objectContaining({
      gateway: GatewayProvider.PAYSTACK,
      failures: 3,
      shareOfFailures: 75,
      attempts: 10,
      failureRate: 30,
    }));
    expect(result.evidence).toEqual(expect.arrayContaining([
      '3 of 4 failures (75%) share signature "timeout".',
      'The dominant signature was first seen at ' + t1.toISOString() + ' and last seen at ' + t2.toISOString() + '.',
      'The dominant failure is concentrated on PAYSTACK.',
    ]));
  });
  it('reports a clean window without inventing a failure diagnosis', async () => {
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.paymentAttempt.groupBy.mockResolvedValue([
      { gateway: GatewayProvider.YOCO, status: 'SUCCESS', _count: { _all: 5 } },
    ]);

    const result = await service.diagnose('m1', 30);

    expect(result.totalFailures).toBe(0);
    expect(result.diagnosis.confidence).toBe('low');
    expect(result.diagnosis.category).toBe('unknown');
    expect(result.dominantFailure).toBeNull();
    expect(result.evidence).toContain('No failed payments were observed in the selected window.');
  });

  it('normalizes multiple provider error fields into a stable signature', async () => {
    const createdAt = new Date('2026-09-23T14:30:00.000Z');
    prisma.payment.findMany.mockResolvedValue([
      { reference: 'A', gateway: GatewayProvider.OZOW, rawGateway: { errorCode: 'DECLINED' }, createdAt },
      { reference: 'B', gateway: GatewayProvider.OZOW, rawGateway: { code: 'declined' }, createdAt },
    ]);
    prisma.paymentAttempt.groupBy.mockResolvedValue([
      { gateway: GatewayProvider.OZOW, status: 'FAILED', _count: { _all: 2 } },
    ]);

    const result = await service.diagnose('m1', 60);

    expect(result.dominantFailure?.signature).toBe('declined');
    expect(result.dominantFailure?.count).toBe(2);
    expect(result.recentFailures.map((item) => item.signature)).toEqual(['declined', 'declined']);
  });
});
