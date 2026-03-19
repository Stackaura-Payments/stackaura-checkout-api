import { PaymentStatus } from '@prisma/client';
import {
  mapPaystackEventToPaymentStatus,
  mapPaystackTransactionStatusToGatewayStatus,
  mapPaystackTransactionStatusToPaymentStatus,
} from './paystack.lifecycle';

describe('Paystack lifecycle mapping', () => {
  it('maps success to PAID', () => {
    expect(mapPaystackTransactionStatusToPaymentStatus('success')).toBe(
      PaymentStatus.PAID,
    );
    expect(mapPaystackTransactionStatusToGatewayStatus('success')).toBe(
      'succeeded',
    );
  });

  it('maps failed to FAILED', () => {
    expect(mapPaystackTransactionStatusToPaymentStatus('failed')).toBe(
      PaymentStatus.FAILED,
    );
    expect(mapPaystackTransactionStatusToGatewayStatus('failed')).toBe(
      'failed',
    );
  });

  it('maps abandoned to CANCELLED', () => {
    expect(mapPaystackTransactionStatusToPaymentStatus('abandoned')).toBe(
      PaymentStatus.CANCELLED,
    );
  });

  it('maps pending-like states to PENDING', () => {
    expect(mapPaystackTransactionStatusToPaymentStatus('pending')).toBe(
      PaymentStatus.PENDING,
    );
    expect(mapPaystackTransactionStatusToPaymentStatus('processing')).toBe(
      PaymentStatus.PENDING,
    );
  });

  it('maps charge.success webhooks to PAID', () => {
    expect(
      mapPaystackEventToPaymentStatus({
        eventType: 'charge.success',
        transactionStatus: 'success',
      }),
    ).toBe(PaymentStatus.PAID);
  });
});
