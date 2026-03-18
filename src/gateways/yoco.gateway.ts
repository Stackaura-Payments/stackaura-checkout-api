import { Injectable, NotImplementedException } from '@nestjs/common';
import {
  GatewayAdapter,
  GatewayCreatePaymentInput,
  GatewayCreatePaymentResult,
  GatewayRefundInput,
  GatewayRefundResult,
  GatewayStatusResult,
} from './gateway.types';
import {
  assertYocoConfigConsistency,
  resolveYocoConfig,
} from './yoco.config';

@Injectable()
export class YocoGateway implements GatewayAdapter {
  async createPayment(
    input: GatewayCreatePaymentInput,
  ): Promise<GatewayCreatePaymentResult> {
    const config = resolveYocoConfig(this.configOverrides(input.config));
    assertYocoConfigConsistency(config);

    if (!config.publicKey || !config.secretKey) {
      throw new Error('Yoco publicKey and secretKey are required');
    }

    const currency = input.currency.trim().toUpperCase();
    if (currency !== 'ZAR') {
      throw new Error('Yoco currently supports ZAR only');
    }

    const response = await fetch(config.checkoutApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': input.paymentId,
      },
      body: JSON.stringify({
        amount: input.amountCents,
        currency,
        successUrl:
          input.metadata?.returnUrl?.trim() ?? this.defaultRedirectUrl('success'),
        cancelUrl:
          input.metadata?.cancelUrl?.trim() ?? this.defaultRedirectUrl('cancel'),
        failureUrl:
          input.metadata?.errorUrl?.trim() ?? this.defaultRedirectUrl('error'),
        clientReferenceId: input.paymentId,
        externalId: input.reference,
        metadata: {
          merchantId: input.merchantId,
          paymentId: input.paymentId,
          reference: input.reference,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Yoco checkout creation failed with status ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const redirectUrl =
      typeof payload.redirectUrl === 'string' ? payload.redirectUrl.trim() : '';
    if (!redirectUrl) {
      throw new Error('Yoco checkout did not return a redirectUrl');
    }

    return {
      redirectUrl,
      externalReference:
        typeof payload.id === 'string' ? payload.id.trim() : input.reference,
    };
  }

  async getPaymentStatus(
    externalReference: string,
  ): Promise<GatewayStatusResult> {
    return {
      status: 'pending',
      externalReference,
      raw: {
        provider: 'YOCO',
        note: 'Status polling not implemented yet in Stackaura',
      },
    };
  }

  async refund(_input: GatewayRefundInput): Promise<GatewayRefundResult> {
    throw new NotImplementedException('Yoco refunds not implemented yet');
  }

  private configOverrides(
    config: Record<string, string | boolean | null | undefined> | undefined,
  ) {
    return {
      yocoPublicKey:
        typeof config?.yocoPublicKey === 'string' ? config.yocoPublicKey : null,
      yocoSecretKey:
        typeof config?.yocoSecretKey === 'string' ? config.yocoSecretKey : null,
      yocoTestMode:
        typeof config?.yocoTestMode === 'boolean' ? config.yocoTestMode : null,
    };
  }

  private defaultRedirectUrl(
    route: 'success' | 'cancel' | 'error',
  ) {
    const baseUrl =
      process.env.APP_URL?.trim() ||
      process.env.PUBLIC_APP_URL?.trim() ||
      'http://127.0.0.1:3001';

    return `${baseUrl}/v1/checkout/${route}`;
  }
}
