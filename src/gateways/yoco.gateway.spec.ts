import { YocoGateway } from './yoco.gateway';

describe('YocoGateway', () => {
  let gateway: YocoGateway;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    gateway = new YocoGateway();
    fetchMock = jest.fn();
    (global as { fetch?: jest.Mock }).fetch = fetchMock;
  });

  afterEach(() => {
    delete (global as { fetch?: jest.Mock }).fetch;
  });

  it('creates a Yoco checkout session with merchant-scoped keys', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'checkout_123',
        redirectUrl: 'https://c.yoco.com/checkout/abc123',
        processingMode: 'test',
      }),
    });

    await expect(
      gateway.createPayment({
        merchantId: 'm-1',
        paymentId: 'p-1',
        reference: 'INV-YOCO-1',
        amountCents: 9900,
        currency: 'ZAR',
        config: {
          yocoPublicKey: 'pk_test_public',
          yocoSecretKey: 'sk_test_secret',
          yocoTestMode: true,
        },
        metadata: {
          returnUrl: 'https://stackaura.co.za/payments/success',
          cancelUrl: 'https://stackaura.co.za/payments/cancel',
          errorUrl: 'https://stackaura.co.za/payments/error',
        },
      }),
    ).resolves.toEqual({
      redirectUrl: 'https://c.yoco.com/checkout/abc123',
      externalReference: 'checkout_123',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://payments.yoco.com/api/checkouts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_secret',
          'Idempotency-Key': 'p-1',
        }),
      }),
    );
  });
});
