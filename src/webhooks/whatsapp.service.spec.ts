import { WhatsAppService } from './whatsapp.service';

describe('WhatsAppService', () => {
  const originalEnv = { ...process.env };
  let prisma: {
    supportConversation: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    supportMessage: { create: jest.Mock };
    membership: { findFirst: jest.Mock };
    merchant: { findFirst: jest.Mock };
    user: { upsert: jest.Mock };
  };
  let supportService: { chat: jest.Mock };
  let service: WhatsAppService;
  let sendTextMessageSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'test-openai-key',
      WHATSAPP_ASYNC_PERSISTENCE_ENABLED: 'false',
      WHATSAPP_AI_MAX_HISTORY_MESSAGES: '5',
      WHATSAPP_AI_MAX_REPLY_CHARS: '800',
    };
    prisma = {
      supportConversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conversation_123' }),
        update: jest.fn().mockResolvedValue({ id: 'conversation_123' }),
      },
      supportMessage: { create: jest.fn().mockResolvedValue({ id: 'msg_123' }) },
      membership: { findFirst: jest.fn().mockResolvedValue(null) },
      merchant: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { upsert: jest.fn().mockResolvedValue({ id: 'support_user_123' }) },
    };
    supportService = {
      chat: jest.fn().mockResolvedValue({}),
    };
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: 'Thanks for contacting Stackaura. I can help with that.',
      }),
    } as Response);
    service = new WhatsAppService(prisma as never, supportService as never);
    sendTextMessageSpy = jest
      .spyOn(service, 'sendTextMessage')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    sendTextMessageSpy.mockRestore();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('sends an AI reply even when Prisma and SupportService hang', async () => {
    process.env.WHATSAPP_ASYNC_PERSISTENCE_ENABLED = 'true';
    prisma.merchant.findFirst.mockReturnValueOnce(new Promise(() => undefined));
    supportService.chat.mockReturnValueOnce(new Promise(() => undefined));

    await service.handleIncomingWebhook(buildTextPayload());

    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Thanks for contacting Stackaura. I can help with that.',
    );
    expect(supportService.chat).not.toHaveBeenCalled();
  });

  it('sends the fallback reply when OpenAI fails', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'provider unavailable',
    } as Response);

    await service.handleIncomingWebhook(buildTextPayload());

    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Stackaura helps you accept payments via PayFast, Ozow, Paystack, Yoco, and more - all in one unified system.',
    );
  });

  it.each([
    [
      'about',
      'What is Stackaura?',
      'Stackaura is a payment orchestration and AI support platform that helps merchants manage payments, automate support, and gain insights from their business.',
    ],
    [
      'payments',
      'Can I accept PayFast and Ozow payments?',
      'Stackaura helps you accept payments via PayFast, Ozow, Paystack, Yoco, and more - all in one unified system.',
    ],
    [
      'shopify',
      'Does this work with Shopify?',
      'Stackaura integrates with Shopify to enhance checkout, route payments, and provide AI-powered customer support.',
    ],
    [
      'support',
      'I need support with my account',
      'Our support agent is here to help. Can you describe your issue in more detail?',
    ],
    [
      'default',
      'Hello there',
      "Hey, I'm Stackaura support. I can help with payments, Shopify, or your account. What would you like to know?",
    ],
  ])('sends a smart %s fallback reply when AI is unavailable', async (_, text, reply) => {
    delete process.env.OPENAI_API_KEY;

    await service.handleIncomingWebhook(
      buildTextPayload({ messageId: `wamid.${text}`, text }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendTextMessageSpy).toHaveBeenCalledWith('27689030889', reply);
  });

  it('uses the smart fallback engine when fallback mode is configured', async () => {
    process.env.WHATSAPP_REPLY_MODE = 'fallback';

    await service.handleIncomingWebhook(
      buildTextPayload({
        messageId: 'wamid.fallback-mode',
        text: 'Can Shopify route payments?',
      }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Stackaura helps you accept payments via PayFast, Ozow, Paystack, Yoco, and more - all in one unified system.',
    );
  });

  it('uses the generic Stackaura prompt when no merchant is matched', async () => {
    await service.handleIncomingWebhook(buildTextPayload());

    const prompt = getOpenAiPrompt(fetchSpy);
    expect(prompt.system).toContain(
      'Stackaura is a payment + AI support + merchant intelligence layer for Shopify merchants',
    );
    expect(prompt.user).toContain(
      'Resolved merchant: none, use generic Stackaura context',
    );
    expect(prompt.user).toContain('Inbound WhatsApp message:');
    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Thanks for contacting Stackaura. I can help with that.',
    );
  });

  it('includes merchant context when a merchant is matched', async () => {
    prisma.merchant.findFirst.mockResolvedValueOnce({
      id: 'merchant_123',
      name: 'Demo Shopify Store',
      email: 'owner@demo.co.za',
      gatewayOrder: ['PAYFAST', 'OZOW'],
      payfastMerchantId: 'pf_123',
      ozowSiteCode: 'ozow_123',
      yocoSecretKey: null,
      paystackSecretKey: null,
    });

    await service.handleIncomingWebhook(buildTextPayload());

    const prompt = getOpenAiPrompt(fetchSpy);
    expect(prompt.user).toContain('Resolved merchant: Demo Shopify Store');
    expect(prompt.user).toContain('Merchant website/domain: demo.co.za');
    expect(prompt.user).toContain('PAYFAST');
    expect(prompt.user).toContain('OZOW');
  });

  it('sends an AI reply when DB context lookup fails', async () => {
    prisma.merchant.findFirst.mockRejectedValueOnce(new Error('EAUTHTIMEOUT'));

    await service.handleIncomingWebhook(buildTextPayload());

    const prompt = getOpenAiPrompt(fetchSpy);
    expect(prompt.user).toContain(
      'Resolved merchant: none, use generic Stackaura context',
    );
    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Thanks for contacting Stackaura. I can help with that.',
    );
  });

  it('caps recent conversation history in the AI prompt', async () => {
    prisma.merchant.findFirst.mockResolvedValueOnce({
      id: 'merchant_123',
      name: 'Demo Shopify Store',
      email: 'owner@demo.co.za',
      gatewayOrder: ['PAYFAST'],
      payfastMerchantId: 'pf_123',
      ozowSiteCode: null,
      yocoSecretKey: null,
      paystackSecretKey: null,
    });
    prisma.supportConversation.findFirst.mockResolvedValueOnce({
      messages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
        content: `history-${index + 1}`,
      })),
    });

    await service.handleIncomingWebhook(buildTextPayload());

    const prompt = getOpenAiPrompt(fetchSpy);
    expect(
      prisma.supportConversation.findFirst.mock.calls[0][0].select.messages
        .take,
    ).toBe(5);
    expect((prompt.user.match(/history-/g) ?? []).length).toBe(5);
  });

  it('trims AI replies to the configured max character limit', async () => {
    process.env.WHATSAPP_AI_MAX_REPLY_CHARS = '40';
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output_text:
          'This is a deliberately long Stackaura WhatsApp response that must be trimmed before sending.',
      }),
    } as Response);

    await service.handleIncomingWebhook(buildTextPayload());

    expect(sendTextMessageSpy.mock.calls[0][1]).toHaveLength(39);
    expect(sendTextMessageSpy.mock.calls[0][1].length).toBeLessThanOrEqual(40);
  });

  it('instructs the AI not to invent pricing or unsupported integrations', async () => {
    await service.handleIncomingWebhook(
      buildTextPayload({
        messageId: 'wamid.pricing',
        text: 'What is pricing and do you support Stripe?',
      }),
    );

    const prompt = getOpenAiPrompt(fetchSpy);
    expect(prompt.system).toContain('Do not invent pricing');
    expect(prompt.system).toContain('unsupported integrations');
    expect(prompt.user).toContain('What is pricing and do you support Stripe?');
  });

  it('does not let async persistence failure affect the WhatsApp reply', async () => {
    process.env.WHATSAPP_ASYNC_PERSISTENCE_ENABLED = 'true';
    prisma.merchant.findFirst.mockRejectedValueOnce(new Error('EAUTHTIMEOUT'));

    await service.handleIncomingWebhook(buildTextPayload());
    await flushAsyncWork();

    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Thanks for contacting Stackaura. I can help with that.',
    );
  });

  it('ignores duplicate inbound message IDs', async () => {
    const payload = buildTextPayload();

    await service.handleIncomingWebhook(payload);
    await service.handleIncomingWebhook(payload);

    expect(sendTextMessageSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-reply to status-only payloads', async () => {
    await service.handleIncomingWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba_123',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1147441758442937' },
                statuses: [
                  {
                    id: 'wamid.reply.1',
                    status: 'delivered',
                    recipient_id: '27689030889',
                    timestamp: '1714480000',
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMessageSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stores the resolved merchant in the async persistence path after sending', async () => {
    process.env.WHATSAPP_ASYNC_PERSISTENCE_ENABLED = 'true';
    prisma.merchant.findFirst.mockResolvedValue({
      id: 'merchant_auto',
      name: 'Demo Shopify Store',
      email: 'owner@demo.co.za',
      gatewayOrder: ['PAYFAST'],
      payfastMerchantId: 'pf_123',
      ozowSiteCode: null,
      yocoSecretKey: null,
      paystackSecretKey: null,
    });
    prisma.user.upsert.mockResolvedValueOnce({ id: 'support_auto' });

    await service.handleIncomingWebhook(buildTextPayload());
    await flushAsyncWork();

    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Thanks for contacting Stackaura. I can help with that.',
    );
    expect(prisma.merchant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          OR: expect.arrayContaining([
            { whatsappPhoneNumberId: '1147441758442937' },
            { whatsappWabaId: 'waba_123' },
          ]),
        }),
      }),
    );
    expect(
      sendTextMessageSpy.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.supportMessage.create.mock.invocationCallOrder[0]);
    expect(prisma.supportMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: 'USER',
          content: 'My payment failed',
        }),
      }),
    );
    expect(prisma.supportMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: 'ASSISTANT',
          content: 'Thanks for contacting Stackaura. I can help with that.',
        }),
      }),
    );
  });

  it('ignores changes outside the messages field', async () => {
    await service.handleIncomingWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'account_update',
              value: {
                messages: [
                  {
                    from: '27689030889',
                    id: 'wamid.unhandled',
                    type: 'text',
                    text: { body: 'Hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMessageSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function buildTextPayload(overrides?: { messageId?: string; text?: string }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba_123',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '1147441758442937' },
              contacts: [
                {
                  wa_id: '27689030889',
                  profile: { name: 'Kga' },
                },
              ],
              messages: [
                {
                  from: '27689030889',
                  id: overrides?.messageId ?? 'wamid.1',
                  timestamp: '1714480000',
                  type: 'text',
                  text: { body: overrides?.text ?? 'My payment failed' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function getOpenAiPrompt(fetchSpy: jest.SpyInstance) {
  const request = fetchSpy.mock.calls[0][1] as RequestInit;
  const body = JSON.parse(String(request.body)) as {
    input: Array<{ content: Array<{ text: string }> }>;
  };

  return {
    system: body.input[0].content[0].text,
    user: body.input[1].content[0].text,
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}
