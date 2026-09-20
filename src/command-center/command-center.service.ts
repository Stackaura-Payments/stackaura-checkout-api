import { Injectable, NotFoundException } from '@nestjs/common';
import {
  GatewayProvider,
  PaymentStatus,
  WebhookDeliveryStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const GATEWAYS: GatewayProvider[] = [
  GatewayProvider.PAYFAST,
  GatewayProvider.OZOW,
  GatewayProvider.YOCO,
  GatewayProvider.PAYSTACK,
  GatewayProvider.PEACH,
];

@Injectable()
export class CommandCenterService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(merchantId: string) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      merchant,
      paymentStatusRows,
      paidTotals,
      gatewayStatusRows,
      webhookStatusRows,
      recentPayments,
    ] = await Promise.all([
      this.prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true, name: true, isActive: true },
      }),
      this.prisma.payment.groupBy({
        by: ['status'],
        where: {
          merchantId,
          createdAt: { gte: startOfToday },
        },
        _count: { _all: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          merchantId,
          status: PaymentStatus.PAID,
          createdAt: { gte: startOfToday },
        },
        _sum: {
          amountCents: true,
          platformFeeCents: true,
          providerFeeCents: true,
          merchantNetCents: true,
        },
      }),
      this.prisma.payment.groupBy({
        by: ['gateway', 'status'],
        where: {
          merchantId,
          createdAt: { gte: startOfToday },
          gateway: { not: null },
        },
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      this.prisma.webhookDelivery.groupBy({
        by: ['status'],
        where: {
          webhookEndpoint: {
            merchantId,
            isActive: true,
          },
        },
        _count: { _all: true },
      }),
      this.prisma.payment.findMany({
        where: { merchantId },
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
      }),
    ]);

    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }

    const statusCounts = this.buildPaymentStatusCounts(paymentStatusRows);
    const webhookCounts = this.buildWebhookStatusCounts(webhookStatusRows);

    return {
      merchant: {
        id: merchant.id,
        name: merchant.name,
      },
      today: {
        totalTransactions: this.totalPaymentCount(statusCounts),
        paidTransactions: statusCounts[PaymentStatus.PAID],
        pendingTransactions: statusCounts[PaymentStatus.PENDING],
        failedTransactions: statusCounts[PaymentStatus.FAILED],
        cancelledTransactions: statusCounts[PaymentStatus.CANCELLED],
        refundedTransactions: statusCounts[PaymentStatus.REFUNDED],
        grossRevenueCents: paidTotals._sum.amountCents ?? 0,
        platformFeesCents: paidTotals._sum.platformFeeCents ?? 0,
        providerFeesCents: paidTotals._sum.providerFeeCents ?? 0,
        merchantNetCents: paidTotals._sum.merchantNetCents ?? 0,
        successRate: this.paymentSuccessRate(statusCounts),
      },
      gateways: this.buildGatewayActivity(gatewayStatusRows),
      webhooks: {
        totalSampledDeliveries: this.totalWebhookCount(webhookCounts),
        successful: webhookCounts[WebhookDeliveryStatus.SUCCESS],
        failed: webhookCounts[WebhookDeliveryStatus.FAILED],
        pending: webhookCounts[WebhookDeliveryStatus.PENDING],
        skipped: webhookCounts[WebhookDeliveryStatus.SKIPPED],
        successRate: this.webhookSuccessRate(webhookCounts),
      },
      recentPayments: recentPayments.map((payment) => ({
        ...payment,
        createdAt: payment.createdAt.toISOString(),
        updatedAt: payment.updatedAt.toISOString(),
      })),
      updatedAt: new Date().toISOString(),
    };
  }

  private buildPaymentStatusCounts(
    rows: Array<{ status: PaymentStatus; _count: { _all: number } }>,
  ) {
    const counts = {
      [PaymentStatus.CREATED]: 0,
      [PaymentStatus.PENDING]: 0,
      [PaymentStatus.PAID]: 0,
      [PaymentStatus.FAILED]: 0,
      [PaymentStatus.CANCELLED]: 0,
      [PaymentStatus.REFUNDED]: 0,
    };

    for (const row of rows) {
      counts[row.status] = row._count._all;
    }

    return counts;
  }

  private buildWebhookStatusCounts(
    rows: Array<{
      status: WebhookDeliveryStatus;
      _count: { _all: number };
    }>,
  ) {
    const counts = {
      [WebhookDeliveryStatus.PENDING]: 0,
      [WebhookDeliveryStatus.SUCCESS]: 0,
      [WebhookDeliveryStatus.FAILED]: 0,
      [WebhookDeliveryStatus.SKIPPED]: 0,
    };

    for (const row of rows) {
      counts[row.status] = row._count._all;
    }

    return counts;
  }

  private buildGatewayActivity(
    rows: Array<{
      gateway: GatewayProvider | null;
      status: PaymentStatus;
      _count: { _all: number };
      _sum: { amountCents: number | null };
    }>,
  ) {
    return GATEWAYS.map((gateway) => {
      const gatewayRows = rows.filter((row) => row.gateway === gateway);
      const paidRows = gatewayRows.filter(
        (row) => row.status === PaymentStatus.PAID,
      );

      return {
        gateway,
        transactionCount: gatewayRows.reduce(
          (sum, row) => sum + row._count._all,
          0,
        ),
        paidTransactionCount: paidRows.reduce(
          (sum, row) => sum + row._count._all,
          0,
        ),
        paidRevenueCents: paidRows.reduce(
          (sum, row) => sum + (row._sum.amountCents ?? 0),
          0,
        ),
      };
    });
  }

  private totalPaymentCount(counts: Record<PaymentStatus, number>) {
    return Object.values(counts).reduce((sum, count) => sum + count, 0);
  }

  private totalWebhookCount(counts: Record<WebhookDeliveryStatus, number>) {
    return Object.values(counts).reduce((sum, count) => sum + count, 0);
  }

  private paymentSuccessRate(counts: Record<PaymentStatus, number>) {
    const terminal =
      counts[PaymentStatus.PAID] +
      counts[PaymentStatus.FAILED] +
      counts[PaymentStatus.CANCELLED];
    if (terminal === 0) return 0;

    return Number(((counts[PaymentStatus.PAID] / terminal) * 100).toFixed(2));
  }

  private webhookSuccessRate(counts: Record<WebhookDeliveryStatus, number>) {
    const total = this.totalWebhookCount(counts);
    if (total === 0) return 0;

    return Number(
      ((counts[WebhookDeliveryStatus.SUCCESS] / total) * 100).toFixed(2),
    );
  }
}
