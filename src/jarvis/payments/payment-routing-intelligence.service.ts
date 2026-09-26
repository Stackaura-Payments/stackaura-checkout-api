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

export type LearningConfidence = 'high' | 'medium' | 'low';

export interface GatewayRoutingMemory {
  gateway: GatewayProvider;
  attempts: number;
  failures: number;
  successes: number;
  failureRate: number;
  weightedFailureRate: number;
  weightedSuccessRate: number;
  confidence: LearningConfidence;
  sampleWeight: number;
  recentFailures: number;
  dominantFailure: { signature: string; count: number; share: number } | null;
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
  learning: {
    model: 'recency-weighted';
    halfLifeHours: number;
    confidence: LearningConfidence;
    postFailoverSignals: number;
    successfulRecoveries: number;
    failedRecoveries: number;
  };
  generatedAt: string;
}

@Injectable()
export class PaymentRoutingIntelligenceService {
  private readonly halfLifeHours = 72;

  constructor(private readonly prisma: PrismaService) {}

  async analyze(merchantId: string, windowMinutes = 24 * 60 * 30): Promise<PaymentRoutingIntelligence> {
    const minutes = this.normalizeWindow(windowMinutes);
    const since = new Date(Date.now() - minutes * 60_000);
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: { payment: { merchantId }, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      take: 5000,
      select: {
        gateway: true, status: true, createdAt: true,
        payment: { select: { status: true, rawGateway: true, reference: true } },
      },
    });

    const recoveryGroups = new Map<string, Array<typeof attempts[number]>>();
    for (const row of attempts) {
      const group = recoveryGroups.get(row.payment.reference) ?? [];
      group.push(row);
      recoveryGroups.set(row.payment.reference, group);
    }

    let postFailoverSignals = 0;
    let successfulRecoveries = 0;
    let failedRecoveries = 0;
    for (const rows of recoveryGroups.values()) {
      if (rows.length < 2) continue;
      const hasFailure = rows.some((row) => this.isFailure(row.status, row.payment.status));
      const hasSuccess = rows.some((row) => this.isSuccess(row.status, row.payment.status));
      if (!hasFailure) continue;
      postFailoverSignals += 1;
      if (hasSuccess) successfulRecoveries += 1;
      else failedRecoveries += 1;
    }

    const now = Date.now();
    const memories = GATEWAYS.map((gateway) => {
      const rows = attempts.filter((row) => row.gateway === gateway);
      const failures = rows.filter((row) => this.isFailure(row.status, row.payment.status));
      const successes = rows.filter((row) => this.isSuccess(row.status, row.payment.status));
      let failureWeight = 0;
      let successWeight = 0;
      let sampleWeight = 0;
      const signatureCounts = new Map<string, number>();

      for (const row of rows) {
        const ageHours = Math.max(0, (now - row.createdAt.getTime()) / 3_600_000);
        const weight = Math.pow(0.5, ageHours / this.halfLifeHours);
        sampleWeight += weight;
        if (this.isFailure(row.status, row.payment.status)) {
          failureWeight += weight;
          const signature = this.failureSignature(row.payment.rawGateway);
          signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
        }
        if (this.isSuccess(row.status, row.payment.status)) successWeight += weight;
      }

      const dominantEntry = [...signatureCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const totalObserved = failures.length + successes.length;
      const confidence = this.confidence(totalObserved, sampleWeight);
      const recentCutoff = new Date(now - Math.min(minutes, 24 * 60) * 60_000);
      const recentFailures = failures.filter((row) => row.createdAt >= recentCutoff).length;
      const lastFailure = failures.at(-1);
      const lastSuccess = successes.at(-1);
      const weightedTotal = failureWeight + successWeight;

      return {
        gateway,
        attempts: rows.length,
        failures: failures.length,
        successes: successes.length,
        failureRate: rows.length ? Number(((failures.length / rows.length) * 100).toFixed(2)) : 0,
        weightedFailureRate: weightedTotal ? Number(((failureWeight / weightedTotal) * 100).toFixed(2)) : 0,
        weightedSuccessRate: weightedTotal ? Number(((successWeight / weightedTotal) * 100).toFixed(2)) : 0,
        confidence,
        sampleWeight: Number(sampleWeight.toFixed(3)),
        recentFailures,
        dominantFailure: dominantEntry ? {
          signature: dominantEntry[0],
          count: dominantEntry[1],
          share: Number(((dominantEntry[1] / failures.length) * 100).toFixed(2)),
        } : null,
        lastFailureAt: lastFailure?.createdAt.toISOString() ?? null,
        lastSuccessAt: lastSuccess?.createdAt.toISOString() ?? null,
      };
    });

    const active = memories.filter((item) => item.attempts > 0);
    const ranked = [...active].sort((a, b) => {
      const confidenceRank = { high: 0, medium: 1, low: 2 };
      if (confidenceRank[a.confidence] !== confidenceRank[b.confidence] && (a.sampleWeight >= 5 || b.sampleWeight >= 5)) {
        return confidenceRank[a.confidence] - confidenceRank[b.confidence];
      }
      return a.weightedFailureRate - b.weightedFailureRate || b.weightedSuccessRate - a.weightedSuccessRate || b.sampleWeight - a.sampleWeight;
    });
    const recommendedGateway = ranked[0]?.gateway ?? null;
    const best = ranked[0];

    const evidence: string[] = [];
    for (const gateway of ranked.slice(0, 3)) {
      evidence.push(
        gateway.gateway + ': ' + gateway.successes + ' successes / ' + gateway.failures +
        ' failures across ' + gateway.attempts + ' attempts; recency-weighted failure rate ' +
        gateway.weightedFailureRate + '% (' + gateway.confidence + ' confidence).',
      );
      if (gateway.dominantFailure) evidence.push(
        gateway.gateway + ' most commonly failed with "' + gateway.dominantFailure.signature +
        '" (' + gateway.dominantFailure.share + '% of its failures).',
      );
    }
    if (postFailoverSignals) evidence.push(
      successfulRecoveries + ' of ' + postFailoverSignals +
      ' multi-gateway payment outcomes show successful recovery after an earlier failure.',
    );

    const overallConfidence = best?.confidence ?? 'low';
    const explanation = best
      ? 'Routing memory prefers ' + best.gateway + ' using recency-weighted gateway outcomes. ' +
        best.gateway + ' has a ' + best.weightedFailureRate + '% weighted failure rate with ' +
        best.confidence + ' confidence from ' + best.attempts + ' observed attempts.'
      : 'No historical gateway attempts are available, so routing falls back to configured priority.';

    return {
      merchantId,
      window: { minutes, since: since.toISOString() },
      gateways: memories,
      recommendedGateway,
      rankedGateways: ranked.map((item) => item.gateway),
      explanation,
      evidence,
      learning: {
        model: 'recency-weighted',
        halfLifeHours: this.halfLifeHours,
        confidence: overallConfidence,
        postFailoverSignals,
        successfulRecoveries,
        failedRecoveries,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private isFailure(status: string, paymentStatus: PaymentStatus) {
    return status.toUpperCase() === 'FAILED' || paymentStatus === PaymentStatus.FAILED;
  }

  private isSuccess(status: string, paymentStatus: PaymentStatus) {
    return ['PAID', 'SUCCESS', 'SUCCEEDED'].includes(status.toUpperCase()) || paymentStatus === PaymentStatus.PAID;
  }

  private confidence(observations: number, weight: number): LearningConfidence {
    if (observations >= 20 && weight >= 8) return 'high';
    if (observations >= 5 && weight >= 2) return 'medium';
    return observations > 0 ? 'low' : 'low';
  }

  private failureSignature(rawGateway: unknown): string {
    if (!rawGateway || typeof rawGateway !== 'object' || Array.isArray(rawGateway)) return 'unspecified-failure';
    const record = rawGateway as Record<string, unknown>;
    const preferred = ['code', 'errorCode', 'responseCode', 'status', 'reason', 'error', 'message'];
    for (const key of preferred) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
    }
    const nested = Object.values(record).find((value) => value && typeof value === 'object' && !Array.isArray(value));
    return nested ? this.failureSignature(nested) : 'unspecified-failure';
  }

  private normalizeWindow(value: number) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('windowMinutes must be positive');
    return Math.min(Math.floor(value), 24 * 60 * 30);
  }
}
