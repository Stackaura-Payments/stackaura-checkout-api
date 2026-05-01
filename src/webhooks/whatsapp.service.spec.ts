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
      'Hi, thanks for contacting Stackaura. We received your message and our support agent will assist you shortly.',
    );
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

  it('runs merchant resolution only in the async persistence path after sending', async () => {
    process.env.WHATSAPP_ASYNC_PERSISTENCE_ENABLED = 'true';
    prisma.merchant.findFirst.mockResolvedValueOnce({ id: 'merchant_auto' });
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
    ).toBeLessThan(prisma.merchant.findFirst.mock.invocationCallOrder[0]);
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

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}
