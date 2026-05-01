import { WhatsAppService } from './whatsapp.service';

describe('WhatsAppService', () => {
  const originalEnv = { ...process.env };
  let prisma: {
    supportConversation: { findFirst: jest.Mock };
    membership: { findFirst: jest.Mock };
    merchant: { findFirst: jest.Mock };
    user: { upsert: jest.Mock };
  };
  let supportService: { chat: jest.Mock };
  let service: WhatsAppService;
  let sendTextMessageSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      WHATSAPP_MERCHANT_ID: 'merchant_123',
      WHATSAPP_SUPPORT_USER_ID: 'user_123',
    };
    prisma = {
      supportConversation: { findFirst: jest.fn().mockResolvedValue(null) },
      membership: { findFirst: jest.fn().mockResolvedValue(null) },
      merchant: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { upsert: jest.fn().mockResolvedValue({ id: 'support_user_123' }) },
    };
    supportService = {
      chat: jest.fn().mockResolvedValue({
        conversation: {
          id: 'conversation_123',
          messages: [
            { role: 'USER', content: 'My payment failed' },
            { role: 'ASSISTANT', content: 'I can help with that payment.' },
          ],
        },
      }),
    };
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

  it('handles inbound text messages and sends the support reply', async () => {
    await service.handleIncomingWebhook(buildTextPayload());

    expect(supportService.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'merchant_123',
        userId: 'user_123',
        channel: 'whatsapp',
        customerWaId: '27689030889',
        customerName: 'Kga',
        message: 'My payment failed',
        conversationTitle: 'WhatsApp - Kga',
        metadata: expect.objectContaining({
          phoneNumberId: '1147441758442937',
          messageId: 'wamid.1',
          rawPayloadSummary: expect.objectContaining({
            field: 'messages',
            messageType: 'text',
          }),
        }),
      }),
    );
    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'I can help with that payment.',
    );
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

    expect(supportService.chat).not.toHaveBeenCalled();
    expect(sendTextMessageSpy).not.toHaveBeenCalled();
  });

  it('ignores duplicate inbound message IDs', async () => {
    const payload = buildTextPayload();

    await service.handleIncomingWebhook(payload);
    await service.handleIncomingWebhook(payload);

    expect(supportService.chat).toHaveBeenCalledTimes(1);
    expect(sendTextMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('sends the fallback reply when SupportService.chat fails', async () => {
    supportService.chat.mockRejectedValueOnce(new Error('AI unavailable'));

    await service.handleIncomingWebhook(buildTextPayload());

    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Hi, thanks for contacting Stackaura. We received your message and our support agent will assist you shortly.',
    );
  });

  it('uses direct OpenAI reply when merchant and support user IDs are missing', async () => {
    delete process.env.WHATSAPP_MERCHANT_ID;
    delete process.env.WHATSAPP_SUPPORT_USER_ID;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    prisma.merchant.findFirst.mockResolvedValueOnce(null);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output_text: 'Thanks for contacting Stackaura. I can help with that.',
      }),
    } as Response);

    await service.handleIncomingWebhook(buildTextPayload());

    expect(supportService.chat).not.toHaveBeenCalled();
    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Thanks for contacting Stackaura. I can help with that.',
    );
  });

  it('uses merchant-aware support when merchant resolves from WhatsApp Meta IDs', async () => {
    delete process.env.WHATSAPP_MERCHANT_ID;
    delete process.env.WHATSAPP_SUPPORT_USER_ID;
    prisma.merchant.findFirst.mockResolvedValueOnce({ id: 'merchant_auto' });
    prisma.user.upsert.mockResolvedValueOnce({ id: 'support_auto' });

    await service.handleIncomingWebhook(buildTextPayload());

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
    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'support@stackaura.co.za' },
      }),
    );
    expect(supportService.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'merchant_auto',
        userId: 'support_auto',
      }),
    );
  });

  it('sends the fallback reply when direct OpenAI fails', async () => {
    delete process.env.WHATSAPP_MERCHANT_ID;
    delete process.env.WHATSAPP_SUPPORT_USER_ID;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    prisma.merchant.findFirst.mockResolvedValueOnce(null);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'provider unavailable',
    } as Response);

    await service.handleIncomingWebhook(buildTextPayload());

    expect(supportService.chat).not.toHaveBeenCalled();
    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Hi, thanks for contacting Stackaura. We received your message and our support agent will assist you shortly.',
    );
  });

  it('sends the fallback reply when SupportService.chat times out', async () => {
    process.env.WHATSAPP_SUPPORT_REPLY_TIMEOUT_MS = '1';
    supportService.chat.mockReturnValueOnce(new Promise(() => undefined));
    sendTextMessageSpy.mockRestore();
    service = new WhatsAppService(prisma as never, supportService as never);
    sendTextMessageSpy = jest
      .spyOn(service, 'sendTextMessage')
      .mockResolvedValue(undefined);

    await service.handleIncomingWebhook(buildTextPayload());

    expect(sendTextMessageSpy).toHaveBeenCalledWith(
      '27689030889',
      'Hi, thanks for contacting Stackaura. We received your message and our support agent will assist you shortly.',
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

    expect(supportService.chat).not.toHaveBeenCalled();
    expect(sendTextMessageSpy).not.toHaveBeenCalled();
  });
});

function buildTextPayload() {
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
                  id: 'wamid.1',
                  timestamp: '1714480000',
                  type: 'text',
                  text: { body: 'My payment failed' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
