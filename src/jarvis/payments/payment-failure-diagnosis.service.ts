import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentRoutingIntelligenceService } from './payment-routing-intelligence.service';

export interface PaymentFailureDiagnosis {
  merchantId: string;
  window: { minutes: number; since: string };
  totalFailures: number;
  diagnosis: {
    confidence: 'high' | 'medium' | 'low';
    category: 'provider' | 'gateway' | 'webhook' | 'customer' | 'unknown';
    summary: string;
  };
  dominantFailure: {
    gateway: string | null;
    signature: string;
    count: number;
    shareOfFailures: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  } | null;
  gatewayComparison: Array<{
    gateway: string;
    failures: number;
    shareOfFailures: number;
    attempts: number;
    failureRate: number;
  }>;
  evidence: string[];
  recentFailures: Array<{
    reference: string;
    gateway: string | null;
    signature: string;
    createdAt: string;
  }>;
  proposedActions: Array<{
    toolId: 'jarvis.owner.payments.failover';
    intent: string;
    riskLevel: 'HIGH';
    arguments: { merchantId: string; reference: string };
    reason: string;
  }>;
  routingIntelligence: {
    recommendedGateway: string | null;
    rankedGateways: string[];
    explanation: string;
    evidence: string[];
    learning: {
      model: string;
      halfLifeHours: number;
      confidence: 'high' | 'medium' | 'low';
      postFailoverSignals: number;
      successfulRecoveries: number;
      failedRecoveries: number;
    };
  };
  generatedAt: string;
}

@Injectable()
export class PaymentFailureDiagnosisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routingIntelligence: PaymentRoutingIntelligenceService,
  ) {}

  async diagnose(merchantId: string, windowMinutes = 60): Promise<PaymentFailureDiagnosis> {
    const minutes = this.normalizeWindow(windowMinutes);
    const since = new Date(Date.now() - minutes * 60_000);

    const [failures, attempts, routingIntelligence] = await Promise.all([
      this.prisma.payment.findMany({
        where: { merchantId, status: PaymentStatus.FAILED, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        take: 500,
        select: { reference: true, gateway: true, rawGateway: true, createdAt: true },
      }),
      this.prisma.paymentAttempt.groupBy({
        by: ['gateway', 'status'],
        where: { payment: { merchantId }, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.routingIntelligence.analyze(merchantId),
    ]);

    const signatures = new Map<string, { gateway: string | null; count: number; first: Date; last: Date }>();
    for (const row of failures) {
      const signature = this.failureSignature(row.rawGateway);
      const current = signatures.get(signature);
      if (current) {
        current.count += 1;
        current.last = row.createdAt;
      } else {
        signatures.set(signature, { gateway: row.gateway, count: 1, first: row.createdAt, last: row.createdAt });
      }
    }

    const dominant = [...signatures.entries()].sort((a, b) => b[1].count - a[1].count)[0];
    const totalFailures = failures.length;
    const dominantShare = dominant && totalFailures > 0 ? Number(((dominant[1].count / totalFailures) * 100).toFixed(2)) : 0;

    const gatewayAttempts = new Map<string, number>();
    for (const row of attempts) gatewayAttempts.set(row.gateway, (gatewayAttempts.get(row.gateway) ?? 0) + row._count._all);
    const gatewayFailures = new Map<string, number>();
    for (const row of failures) {
      const gateway = row.gateway ?? 'UNKNOWN';
      gatewayFailures.set(gateway, (gatewayFailures.get(gateway) ?? 0) + 1);
    }

    const gatewayComparison = [...gatewayFailures.entries()]
      .map(([gateway, failed]) => {
        const total = gatewayAttempts.get(gateway) ?? failed;
        return {
          gateway,
          failures: failed,
          shareOfFailures: totalFailures === 0 ? 0 : Number(((failed / totalFailures) * 100).toFixed(2)),
          attempts: total,
          failureRate: total === 0 ? 0 : Number(((failed / total) * 100).toFixed(2)),
        };
      })
      .sort((a, b) => b.failures - a.failures);

    const evidence: string[] = [];
    if (dominant) {
      evidence.push(
        dominant[1].count + ' of ' + totalFailures + ' failures (' + dominantShare + '%) share signature "' + dominant[0] + '".',
      );
      evidence.push(
        'The dominant signature was first seen at ' + dominant[1].first.toISOString() + ' and last seen at ' + dominant[1].last.toISOString() + '.',
      );
      if (dominant[1].gateway) evidence.push('The dominant failure is concentrated on ' + dominant[1].gateway + '.');
    }
    if (totalFailures === 0) evidence.push('No failed payments were observed in the selected window.');

    const category = this.category(dominant?.[0]);
    const confidence: PaymentFailureDiagnosis['diagnosis']['confidence'] =
      !dominant ? 'low' : dominantShare >= 70 ? 'high' : dominantShare >= 30 ? 'medium' : 'low';
    const summary = !dominant
      ? 'No payment failures were observed in the last ' + minutes + ' minutes.'
      : dominant[1].count + ' ' + (dominant[1].gateway ?? 'gateway') + ' failures share the same signature, representing ' + dominantShare + '% of observed failures.';

    const proposedActions: PaymentFailureDiagnosis['proposedActions'] =
      dominant && totalFailures > 0 && failures.length > 0
        ? [{
            toolId: 'jarvis.owner.payments.failover',
            intent: 'failover-diagnosed-payment-' + failures[failures.length - 1].reference,
            riskLevel: 'HIGH',
            arguments: { merchantId, reference: failures[failures.length - 1].reference },
            reason: 'Attempt a governed gateway failover for a failed payment represented by the dominant failure pattern.',
          }]
        : [];

    return {
      merchantId,
      window: { minutes, since: since.toISOString() },
      totalFailures,
      diagnosis: { confidence, category, summary },
      dominantFailure: dominant ? {
        gateway: dominant[1].gateway,
        signature: dominant[0],
        count: dominant[1].count,
        shareOfFailures: dominantShare,
        firstSeenAt: dominant[1].first.toISOString(),
        lastSeenAt: dominant[1].last.toISOString(),
      } : null,
      gatewayComparison,
      evidence,
      proposedActions,
      routingIntelligence: {
        recommendedGateway: routingIntelligence.recommendedGateway,
        rankedGateways: routingIntelligence.rankedGateways,
        explanation: routingIntelligence.explanation,
        evidence: routingIntelligence.evidence,
        learning: routingIntelligence.learning,
      },
      recentFailures: failures.slice(-20).reverse().map((row) => ({
        reference: row.reference,
        gateway: row.gateway,
        signature: this.failureSignature(row.rawGateway),
        createdAt: row.createdAt.toISOString(),
      })),
      generatedAt: new Date().toISOString(),
    };
  }
  private failureSignature(rawGateway: unknown): string {
    const values: string[] = [];
    const collect = (value: unknown, depth = 0): void => {
      if (depth > 2 || value === null || value === undefined) return;
      if (typeof value === 'string') {
        const clean = value.trim().replace(/\s+/g, ' ');
        if (clean && clean.length <= 160) values.push(clean);
        return;
      }
      if (typeof value !== 'object' || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      const preferred = ['code', 'errorCode', 'responseCode', 'status', 'reason', 'error', 'message', 'error_description'];
      for (const key of preferred) if (key in record) collect(record[key], depth + 1);
    };
    collect(rawGateway);
    const unique = [...new Set(values.map((value) => value.toLowerCase()))];
    return unique[0] ?? 'unspecified-failure';
  }

  private category(signature?: string): PaymentFailureDiagnosis['diagnosis']['category'] {
    if (!signature) return 'unknown';
    const value = signature.toLowerCase();
    if (/timeout|unavailable|rate.?limit|5\d\d|provider|gateway/.test(value)) return 'provider';
    if (/webhook|callback/.test(value)) return 'webhook';
    if (/declin|insufficient|expired|invalid|cancel/.test(value)) return 'customer';
    return 'gateway';
  }

  private normalizeWindow(value: number) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('windowMinutes must be positive');
    return Math.min(Math.floor(value), 24 * 60 * 30);
  }
}
