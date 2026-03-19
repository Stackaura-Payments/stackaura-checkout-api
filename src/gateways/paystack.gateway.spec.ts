import { PaystackGateway } from './paystack.gateway';

describe('PaystackGateway', () => {
  let gateway: PaystackGateway;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    gateway = new PaystackGateway();
    fetchMock = jest.fn();
    (global as { fetch?: jest.Mock }).fetch = fetchMock;
  });

  afterEach(() => {
    delete (global as { fetch?: jest.Mock }).fetch;
  });

  it('initializes a Paystack transaction and returns the authorization url', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        message: 'Authorization URL created',
        data: {
          authorization_url: 'https://checkout.paystack.com/abc123',
          access_code: 'access_123',
          reference: 'INV-PAYSTACK-1',
        },
      }),
    });

    await expect(
      gateway.createPayment({
        merchantId: 'm-1',
        paymentId: 'p-1',
        reference: 'INV-PAYSTACK-1',
        amountCents: 9900,
        currency: 'ZAR',
        customerEmail: 'buyer@example.com',
        config: {
          paystackSecretKey: 'sk_test_secret',
          paystackTestMode: true,
        },
        metadata: {
          returnUrl: 'https://stackaura.co.za/payments/success',
          cancelUrl: 'https://stackaura.co.za/payments/cancel',
          errorUrl: 'https://stackaura.co.za/payments/error',
        },
      }),
    ).resolves.toEqual({
      redirectUrl: 'https://checkout.paystack.com/abc123',
      externalReference: 'access_123',
      raw: expect.objectContaining({
        reference: 'INV-PAYSTACK-1',
        accessCode: 'access_123',
        authorizationUrl: 'https://checkout.paystack.com/abc123',
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_secret',
        }),
      }),
    );

    const payload = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(payload).toEqual(
      expect.objectContaining({
        email: 'buyer@example.com',
        amount: 9900,
        currency: 'ZAR',
        reference: 'INV-PAYSTACK-1',
        callback_url:
          'https://stackaura.co.za/payments/success?reference=INV-PAYSTACK-1&paymentId=p-1&gateway=PAYSTACK',
        metadata: expect.objectContaining({
          cancel_action:
            'https://stackaura.co.za/payments/cancel?reference=INV-PAYSTACK-1&paymentId=p-1&gateway=PAYSTACK',
          error_action:
            'https://stackaura.co.za/payments/error?reference=INV-PAYSTACK-1&paymentId=p-1&gateway=PAYSTACK',
          paymentId: 'p-1',
        }),
      }),
    );
  });

  it('surfaces Paystack initialize failures cleanly', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        status: false,
        message: 'Invalid key',
      }),
    });

    await expect(
      gateway.createPayment({
        merchantId: 'm-1',
        paymentId: 'p-1',
        reference: 'INV-PAYSTACK-1',
        amountCents: 9900,
        currency: 'ZAR',
        customerEmail: 'buyer@example.com',
        config: {
          paystackSecretKey: 'sk_test_secret',
          paystackTestMode: true,
        },
      }),
    ).rejects.toThrow('Paystack initialize failed: Invalid key');
  });

  it('verifies a Paystack transaction by reference', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        message: 'Verification successful',
        data: {
          reference: 'INV-PAYSTACK-1',
          access_code: 'access_123',
          status: 'success',
          amount: 9900,
          currency: 'ZAR',
          paid_at: '2026-03-19T09:00:00.000Z',
          channel: 'card',
          customer: {
            email: 'buyer@example.com',
          },
        },
      }),
    });

    await expect(
      gateway.verifyTransaction({
        reference: 'INV-PAYSTACK-1',
        config: {
          paystackSecretKey: 'sk_test_secret',
          paystackTestMode: true,
        },
      }),
    ).resolves.toEqual({
      reference: 'INV-PAYSTACK-1',
      accessCode: 'access_123',
      providerStatus: 'success',
      gatewayStatus: 'succeeded',
      amount: '9900',
      currency: 'ZAR',
      paidAt: '2026-03-19T09:00:00.000Z',
      channel: 'card',
      customerEmail: 'buyer@example.com',
      raw: expect.objectContaining({
        status: true,
      }),
    });
  });
});
