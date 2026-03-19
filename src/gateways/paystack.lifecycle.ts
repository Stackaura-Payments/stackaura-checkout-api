import { PaymentStatus } from '@prisma/client';
import type { GatewayStatusResult } from './gateway.types';

const normalizePaystackState = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;

export function mapPaystackTransactionStatusToPaymentStatus(
  status: unknown,
): PaymentStatus {
  const normalized = normalizePaystackState(status);

  if (normalized === 'success') {
    return PaymentStatus.PAID;
  }

  if (normalized === 'failed') {
    return PaymentStatus.FAILED;
  }

  if (
    normalized === 'abandoned' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'reversed'
  ) {
    return PaymentStatus.CANCELLED;
  }

  if (
    normalized === 'pending' ||
    normalized === 'processing' ||
    normalized === 'ongoing' ||
    normalized === 'queued'
  ) {
    return PaymentStatus.PENDING;
  }

  return PaymentStatus.PENDING;
}

export function mapPaystackTransactionStatusToGatewayStatus(
  status: unknown,
): GatewayStatusResult['status'] {
  const mapped = mapPaystackTransactionStatusToPaymentStatus(status);
  if (mapped === PaymentStatus.PAID) return 'succeeded';
  if (mapped === PaymentStatus.FAILED || mapped === PaymentStatus.CANCELLED) {
    return 'failed';
  }
  return 'pending';
}

export function mapPaystackEventToPaymentStatus(args: {
  eventType?: unknown;
  transactionStatus?: unknown;
}) {
  const eventType = normalizePaystackState(args.eventType);
  if (eventType === 'charge.success') {
    return PaymentStatus.PAID;
  }
  if (eventType === 'charge.failed') {
    return PaymentStatus.FAILED;
  }

  return mapPaystackTransactionStatusToPaymentStatus(args.transactionStatus);
}
