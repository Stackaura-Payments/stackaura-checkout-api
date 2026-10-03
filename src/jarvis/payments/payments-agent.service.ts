import { Injectable, NotFoundException } from '@nestjs/common';
import { GatewayProvider, PaymentStatus, WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const GATEWAYS: GatewayProvider[] = [
  GatewayProvider.PAYFAST, GatewayProvider.OZOW, GatewayProvider.YOCO,
  GatewayProvider.PAYSTACK, GatewayProvider.PEACH,
];

@Injectable()
export class PaymentsAgentService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(merchantId: string, windowMinutes = 60) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId }, select: { id: true, name: true, isActive: true },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');

    const minutes = this.normalizeWindow(windowMinutes);
    const since = new Date(Date.now() - minutes * 60_000);

    const [payments, attempts, webhooks] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['status'], where: { merchantId, createdAt: { gte: since } },
        _count: { _all: true }, _sum: { amountCents: true },
      }),
      this.prisma.paymentAttempt.groupBy({
        by: ['gateway', 'status'],
        where: { payment: { merchantId }, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.webhookDelivery.groupBy({
        by: ['status'],
        where: { webhookEndpoint: { merchantId }, createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    const paymentCounts = this.emptyPaymentCounts();
    let grossPaidCents = 0;
    for (const row of payments) {
      paymentCounts[row.status] = row._count._all;
      if (row.status === PaymentStatus.PAID) grossPaidCents = row._sum.amountCents ?? 0;
    }

    const terminal = paymentCounts.PAID + paymentCounts.FAILED + paymentCounts.CANCELLED;
    const successRate = terminal === 0 ? 0 : Number(((paymentCounts.PAID / terminal) * 100).toFixed(2));

    const gateways = GATEWAYS.map((gateway) => {
      const rows = attempts.filter((row) => row.gateway === gateway);
      const total = rows.reduce((sum, row) => sum + row._count._all, 0);
      const failed = rows.filter((row) => row.status.toUpperCase() === 'FAILED')
        .reduce((sum, row) => sum + row._count._all, 0);
      const successful = rows.filter((row) => ['PAID', 'SUCCESS', 'SUCCEEDED'].includes(row.status.toUpperCase()))
        .reduce((sum, row) => sum + row._count._all, 0);
      return {
        gateway, attempts: total, successfulAttempts: successful, failedAttempts: failed,
        failureRate: total === 0 ? 0 : Number(((failed / total) * 100).toFixed(2)),
        state: total === 0 ? 'NO_ACTIVITY' : failed / total >= 0.5 ? 'DEGRADED' : 'ACTIVE',
      };
    });

    const webhookCounts = {
      [WebhookDeliveryStatus.PENDING]: 0, [WebhookDeliveryStatus.SUCCESS]: 0,
      [WebhookDeliveryStatus.FAILED]: 0, [WebhookDeliveryStatus.SKIPPED]: 0,
    };
    for (const row of webhooks) webhookCounts[row.status] = row._count._all;

    return {
      merchant: { id: merchant.id, name: merchant.name, isActive: merchant.isActive },
      window: { minutes, since: since.toISOString() },
      payments: { ...paymentCounts, grossPaidCents, successRate },
      gateways,
      webhooks: {
        ...webhookCounts,
        total: Object.values(webhookCounts).reduce((sum, count) => sum + count, 0),
        failureRate: webhookCounts.SUCCESS + webhookCounts.FAILED === 0 ? 0 :
          Number(((webhookCounts.FAILED / (webhookCounts.SUCCESS + webhookCounts.FAILED)) * 100).toFixed(2)),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  async getRecentPayments(merchantId: string, limit = 10) {
    const take = Math.min(Math.max(Math.floor(limit), 1), 50);
    const rows = await this.prisma.payment.findMany({
      where: { merchantId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take,
      select: { id: true, reference: true, amountCents: true, currency: true, status: true,
        gateway: true, gatewayRef: true, createdAt: true, updatedAt: true },
    });
    return {
      payments: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
      count: rows.length, generatedAt: new Date().toISOString(),
    };
  }

  async getFailures(merchantId: string, windowMinutes = 60) {
    const minutes = this.normalizeWindow(windowMinutes);
    const since = new Date(Date.now() - minutes * 60_000);
    const rows = await this.prisma.payment.findMany({
      where: { merchantId, status: PaymentStatus.FAILED, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, reference: true, amountCents: true, currency: true, gateway: true,
        gatewayRef: true, rawGateway: true, createdAt: true, updatedAt: true },
    });

    const grouped = new Map<string, { gateway: GatewayProvider | null; count: number; references: string[] }>();
    for (const row of rows) {
      const key = row.gateway ?? 'UNKNOWN';
      const current = grouped.get(key) ?? { gateway: row.gateway, count: 0, references: [] };
      current.count += 1;
      if (current.references.length < 10) current.references.push(row.reference);
      grouped.set(key, current);
    }

    return {
      window: { minutes, since: since.toISOString() }, totalFailures: rows.length,
      byGateway: [...grouped.values()].sort((a, b) => b.count - a.count),
      recentFailures: rows.slice(0, 20).map((row) => ({
        id: row.id, reference: row.reference, amountCents: row.amountCents, currency: row.currency,
        gateway: row.gateway, gatewayRef: row.gatewayRef, rawGateway: row.rawGateway,
        createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  private normalizeWindow(value: number) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('windowMinutes must be positive');
    return Math.min(Math.floor(value), 24 * 60 * 30);
  }

  private emptyPaymentCounts() {
    return {
      [PaymentStatus.CREATED]: 0, [PaymentStatus.PENDING]: 0, [PaymentStatus.PAID]: 0,
      [PaymentStatus.FAILED]: 0, [PaymentStatus.CANCELLED]: 0, [PaymentStatus.REFUNDED]: 0,
    };
  }
}
