import { Injectable } from '@nestjs/common';
import { GatewayProvider, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const GATEWAYS: GatewayProvider[] = [
  GatewayProvider.PAYSTACK,
  GatewayProvider.YOCO,
  GatewayProvider.OZOW,
  GatewayProvider.PAYFAST,
  GatewayProvider.PEACH,
];

export interface GatewayRoutingMemory {
  gateway: GatewayProvider;
  attempts: number;
  failures: number;
  successes: number;
  failureRate: number;
  recentFailures: number;
  dominantFailure: {
    signature: string;
    count: number;
    share: number;
  } | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}

export interface PaymentRoutingIntelligence {
  merchantId: string;
  window: { minutes: number; since: string };
  gateways: GatewayRoutingMemory[];
  recommendedGateway: GatewayProvider | null;
  rankedGateways: GatewayProvider[];
  explanation: string;
  evidence: string[];
  generatedAt: string;
}

@Injectable()
export class PaymentRoutingIntelligenceService {
  constructor(private readonly prisma: PrismaService) {}

  async analyze(
    merchantId: string,
    windowMinutes = 24 * 60 * 30,
  ): Promise<PaymentRoutingIntelligence> {
    const minutes = this.normalizeWindow(windowMinutes);
    const since = new Date(Date.now() - minutes * 60_000);

    const attempts = await this.prisma.paymentAttempt.findMany({
      where: { payment: { merchantId }, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      take: 5000,
      select: {
        gateway: true,
        status: true,
        createdAt: true,
        payment: { select: { status: true, rawGateway: true } },
      },
    });

    const memories = GATEWAYS.map((gateway) => {
      const rows = attempts.filter((row) => row.gateway === gateway);
      const failures = rows.filter((row) => this.isFailure(row.status, row.payment.status));
      const successes = rows.filter((row) => this.isSuccess(row.status, row.payment.status));
      const signatureCounts = new Map<string, number>();
      for (const row of failures) {
        const signature = this.failureSignature(row.payment.rawGateway);
        signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
      }
      const dominantEntry = [...signatureCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const failureCount = failures.length;
      const recentCutoff = new Date(Date.now() - Math.min(minutes, 24 * 60) * 60_000);
      const recentFailures = failures.filter((row) => row.createdAt >= recentCutoff).length;
      const lastFailure = failures.at(-1);
      const lastSuccess = successes.at(-1);

      return {
        gateway,
        attempts: rows.length,
        failures: failureCount,
        successes: successes.length,
        failureRate: rows.length === 0 ? 0 : Number(((failureCount / rows.length) * 100).toFixed(2)),
        recentFailures,
        dominantFailure: dominantEntry
          ? {
              signature: dominantEntry[0],
              count: dominantEntry[1],
              share: Number(((dominantEntry[1] / failureCount) * 100).toFixed(2)),
            }
          : null,
        lastFailureAt: lastFailure?.createdAt.toISOString() ?? null,
        lastSuccessAt: lastSuccess?.createdAt.toISOString() ?? null,
      };
    });

    const active = memories.filter((item) => item.attempts > 0);
    const ranked = [...active].sort((a, b) => {
      const rateDelta = a.failureRate - b.failureRate;
      if (Math.abs(rateDelta) > 0.01) return rateDelta;
      return b.successes - a.successes;
    });
    const recommendedGateway = ranked[0]?.gateway ?? null;

    const evidence: string[] = [];
    for (const gateway of ranked.slice(0, 3)) {
      evidence.push(
        gateway.gateway + ': ' + gateway.successes + ' successes / ' +
        gateway.failures + ' failures across ' + gateway.attempts +
        ' attempts (' + gateway.failureRate + '% failure rate).',
      );
      if (gateway.dominantFailure) {
        evidence.push(
          gateway.gateway + ' most commonly failed with "' +
          gateway.dominantFailure.signature + '" (' +
          gateway.dominantFailure.share + '% of its failures).',
        );
      }
    }

    let explanation = recommendedGateway
      ? 'Routing memory recommends ' + recommendedGateway + ' because it has the lowest observed failure rate in the selected history window.'
      : 'No historical gateway attempts were found, so routing memory has no evidence-based preference.';
    if (recommendedGateway) {
      const best = ranked[0];
      const previous = ranked.find((item) => item.failureRate > best.failureRate);
      if (previous) {
        explanation += ' ' + recommendedGateway + ' is at ' + best.failureRate +
          '% failure versus ' + previous.gateway + ' at ' + previous.failureRate + '%.';
      }
    }

    return {
      merchantId,
      window: { minutes, since: since.toISOString() },
      gateways: memories,
      recommendedGateway,
      rankedGateways: ranked.map((item) => item.gateway),
      explanation,
      evidence,
      generatedAt: new Date().toISOString(),
    };
  }

  private isFailure(status: string, paymentStatus: PaymentStatus) {
    return status.toUpperCase() === 'FAILED' || paymentStatus === PaymentStatus.FAILED;
  }
  private isSuccess(status: string, paymentStatus: PaymentStatus) {
    return ['PAID', 'SUCCESS', 'SUCCEEDED'].includes(status.toUpperCase()) ||
      paymentStatus === PaymentStatus.PAID;
  }

  private failureSignature(rawGateway: unknown): string {
    if (!rawGateway || typeof rawGateway !== 'object' || Array.isArray(rawGateway)) {
      return 'unspecified-failure';
    }
    const record = rawGateway as Record<string, unknown>;
    const preferred = ['code', 'errorCode', 'responseCode', 'status', 'reason', 'error', 'message'];
    for (const key of preferred) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
    }
    const nested = Object.values(record).find(
      (value) => value && typeof value === 'object' && !Array.isArray(value),
    );
    if (nested) return this.failureSignature(nested);
    return 'unspecified-failure';
  }

  private normalizeWindow(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('windowMinutes must be positive');
    }
    return Math.min(Math.floor(value), 24 * 60 * 30);
  }
}
