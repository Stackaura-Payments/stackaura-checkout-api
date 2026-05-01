import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  SupportConversationStatus,
  SupportMessageRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupportService } from '../support/support.service';

type WhatsAppContact = {
  wa_id?: string;
  profile?: { name?: string };
};

type WhatsAppMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
};

type WhatsAppStatus = {
  id?: string;
  recipient_id?: string;
  status?: string;
  timestamp?: string;
};

type WhatsAppChangeValue = {
  metadata?: { phone_number_id?: string };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
};

type WhatsAppWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: WhatsAppChangeValue;
    }>;
  }>;
};

type InboundWhatsAppMessage = {
  waId: string;
  senderName?: string;
  phoneNumberId?: string;
  wabaId?: string;
  messageId: string;
  timestamp?: string;
  messageType: string;
  textBody: string;
  rawPayloadSummary: Record<string, unknown>;
};

type WhatsAppReplySource = 'direct_ai' | 'fallback';

type WhatsAppReplyResult = {
  body: string;
  source: WhatsAppReplySource;
  fallbackReason?: string;
};

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly processedMessageIds = new Set<string>();
  private readonly conversationIdsByWaId = new Map<string, string>();
  private readonly fallbackReply =
    'Hi, thanks for contacting Stackaura. We received your message and our support agent will assist you shortly.';
  private readonly aiReplyTimeoutMs = this.readAiReplyTimeoutMs();

  constructor(
    private readonly prisma: PrismaService,
    private readonly supportService: SupportService,
  ) {}

  verifyWebhook(args: {
    mode?: string;
    token?: string;
    challenge?: string;
  }): string | null {
    const expectedToken =
      process.env.WHATSAPP_VERIFY_TOKEN?.trim() || 'stackaura_whatsapp';
    if (
      args.mode === 'subscribe' &&
      expectedToken &&
      args.token === expectedToken
    ) {
      return args.challenge ?? '';
    }

    return null;
  }

  async handleIncomingWebhook(payload: WhatsAppWebhookPayload) {
    if (this.isDebugLoggingEnabled()) {
      this.logger.debug(
        `WhatsApp webhook debug payload: ${JSON.stringify(payload)}`,
      );
    }

    const parsed = this.parseWebhookPayload(payload);
    this.logger.log(
      `WhatsApp webhook received: ${JSON.stringify({
        object: payload.object,
        messages: parsed.messages.length,
        statuses: parsed.statuses.length,
      })}`,
    );

    for (const status of parsed.statuses) {
      this.logStatusUpdate(status);
    }

    let processed = 0;
    for (const message of parsed.messages) {
      if (this.hasProcessed(message.messageId)) {
        this.logger.log(
          `Duplicate WhatsApp message ignored (messageId=${message.messageId})`,
        );
        continue;
      }

      await this.handleInboundMessage(message);
      processed += 1;
    }

    return {
      received: true,
      processed,
      statuses: parsed.statuses.length,
    };
  }

  private parseWebhookPayload(payload: WhatsAppWebhookPayload) {
    const messages: InboundWhatsAppMessage[] = [];
    const statuses: Array<
      WhatsAppStatus & { phoneNumberId?: string; entryId?: string }
    > = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') {
          continue;
        }

        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;

        for (const status of value?.statuses ?? []) {
          statuses.push({ ...status, phoneNumberId, entryId: entry.id });
        }

        for (const message of value?.messages ?? []) {
          const contact = this.findContactForMessage(
            value?.contacts,
            message.from,
          );
          const waId = contact?.wa_id ?? message.from;
          const textBody = message.text?.body?.trim();
          const messageId = message.id?.trim();
          const messageType = message.type?.trim() || 'unknown';

          if (!waId || !messageId || !textBody) {
            this.logger.warn(
              `WhatsApp message ignored: ${JSON.stringify({
                hasWaId: Boolean(waId),
                hasMessageId: Boolean(messageId),
                messageType,
              })}`,
            );
            continue;
          }

          messages.push({
            waId,
            senderName: contact?.profile?.name?.trim() || undefined,
            phoneNumberId,
            wabaId: entry.id,
            messageId,
            timestamp: message.timestamp,
            messageType,
            textBody,
            rawPayloadSummary: {
              object: payload.object,
              entryId: entry.id,
              field: change.field,
              phoneNumberId,
              wabaId: entry.id,
              messageId,
              messageType,
            },
          });
        }
      }
    }

    return { messages, statuses };
  }

  private findContactForMessage(
    contacts: WhatsAppContact[] | undefined,
    from: string | undefined,
  ) {
    if (!contacts?.length) {
      return null;
    }

    return contacts.find((contact) => contact.wa_id === from) ?? contacts[0];
  }

  private logStatusUpdate(
    status: WhatsAppStatus & { phoneNumberId?: string; entryId?: string },
  ) {
    this.logger.log(
      `WhatsApp status update: ${JSON.stringify({
        status: status.status,
        messageId: status.id,
        recipientId: this.maskPhoneNumber(status.recipient_id),
        timestamp: status.timestamp,
        phoneNumberId: status.phoneNumberId,
      })}`,
    );
  }

  private async handleInboundMessage(message: InboundWhatsAppMessage) {
    this.logger.log(
      `WhatsApp inbound message: ${JSON.stringify({
        waId: this.maskPhoneNumber(message.waId),
        messageId: message.messageId,
        type: message.messageType,
        preview: this.preview(message.textBody),
      })}`,
    );

    const reply = await this.generateSynchronousReply(message);
    await this.sendTextMessage(message.waId, reply.body);

    this.logger.log(
      `WhatsApp AI reply sent: ${JSON.stringify({
        waId: this.maskPhoneNumber(message.waId),
        messageId: message.messageId,
        replySource: reply.source,
      })}`,
    );

    if (this.isAsyncPersistenceEnabled()) {
      void this.persistWhatsAppExchange(message, reply);
    }
  }

  private async findExistingConversationId(args: {
    merchantId: string;
    userId: string;
    conversationTitle: string;
  }) {
    const conversation = await this.prisma.supportConversation.findFirst({
      where: {
        merchantId: args.merchantId,
        userId: args.userId,
        title: args.conversationTitle,
        status: SupportConversationStatus.OPEN,
      },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true },
    });

    return conversation?.id;
  }

  private async resolveSupportIdentity(message: InboundWhatsAppMessage) {
    const merchantId = process.env.WHATSAPP_MERCHANT_ID?.trim();
    const resolvedMerchantId =
      merchantId || (await this.resolveMerchantIdFromMetaIds(message));

    if (!resolvedMerchantId) {
      return null;
    }

    const configuredUserId = process.env.WHATSAPP_SUPPORT_USER_ID?.trim();
    if (configuredUserId) {
      return { merchantId: resolvedMerchantId, userId: configuredUserId };
    }

    try {
      const membership = await this.prisma.membership.findFirst({
        where: { merchantId: resolvedMerchantId },
        orderBy: { createdAt: 'asc' },
        select: { userId: true },
      });

      if (membership) {
        return { merchantId: resolvedMerchantId, userId: membership.userId };
      }

      const userId = await this.resolveSystemSupportUserId();
      return userId ? { merchantId: resolvedMerchantId, userId } : null;
    } catch (error) {
      this.logger.warn(
        `WhatsApp support user resolution failed; falling back to direct AI: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async resolveMerchantIdFromMetaIds(message: InboundWhatsAppMessage) {
    this.logger.log(
      `WhatsApp merchant resolution starting: ${JSON.stringify({
        phoneNumberId: message.phoneNumberId ?? null,
        wabaId: message.wabaId ?? null,
      })}`,
    );

    const filters = [
      message.phoneNumberId
        ? { whatsappPhoneNumberId: message.phoneNumberId }
        : null,
      message.wabaId ? { whatsappWabaId: message.wabaId } : null,
    ].filter(Boolean);

    if (!filters.length) {
      this.logger.warn(
        'WhatsApp merchant resolution skipped: no phone_number_id or WABA ID present in payload',
      );
      return null;
    }

    try {
      const prisma = this.prisma as unknown as {
        merchant: {
          findFirst(args: unknown): Promise<{ id: string } | null>;
        };
      };
      const merchant = await prisma.merchant.findFirst({
        where: {
          isActive: true,
          OR: filters,
        },
        select: { id: true },
      });

      this.logger.log(
        `WhatsApp merchant resolution completed: ${JSON.stringify({
          phoneNumberId: message.phoneNumberId ?? null,
          wabaId: message.wabaId ?? null,
          merchantId: merchant?.id ?? null,
          matched: Boolean(merchant),
          dbColumns: ['whatsappPhoneNumberId', 'whatsappWabaId'],
        })}`,
      );

      return merchant?.id ?? null;
    } catch (error) {
      this.logger.warn(
        `WhatsApp merchant resolution failed: ${JSON.stringify({
          phoneNumberId: message.phoneNumberId ?? null,
          wabaId: message.wabaId ?? null,
          dbColumns: ['whatsappPhoneNumberId', 'whatsappWabaId'],
          error: error instanceof Error ? error.message : String(error),
        })}`,
      );
      return null;
    }
  }

  private async resolveSystemSupportUserId() {
    const email =
      process.env.WHATSAPP_SYSTEM_SUPPORT_EMAIL?.trim() ||
      'wesupport@stackaura.co.za';

    const prisma = this.prisma as unknown as {
      user: {
        upsert(args: unknown): Promise<{ id: string }>;
      };
    };
    const user = await prisma.user.upsert({
      where: { email },
      update: { isActive: true },
      create: {
        email,
        passwordHash: 'system-whatsapp-support-user',
        isActive: true,
      },
      select: { id: true },
    });

    return user.id;
  }

  private async generateDirectAiReply(userMessage: string) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      this.logger.warn(
        'WhatsApp direct AI reply failed: OPENAI_API_KEY is not configured',
      );
      return null;
    }

    this.logger.log('WhatsApp AI reply starting');

    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.WHATSAPP_DIRECT_AI_MODEL?.trim() || 'gpt-4.1-mini',
          input: [
            {
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: [
                    'You are Stackaura support on WhatsApp.',
                    'Stackaura is a payment, AI support, and merchant intelligence layer for Shopify merchants.',
                    'Keep replies concise, useful, conversational, safe, friendly, and Stackaura-branded.',
                    'Do not claim to have checked private account data or payment records.',
                    'If asked about pricing or technical onboarding, answer generally and offer to connect them to support.',
                    'If the user asks for account-specific help, acknowledge and say a support agent can assist shortly.',
                  ].join(' '),
                },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: userMessage }],
            },
          ],
        }),
        signal: AbortSignal.timeout(this.aiReplyTimeoutMs),
      });

      if (!response.ok) {
        throw new Error(
          `OpenAI direct WhatsApp reply failed (${response.status}): ${await response.text()}`,
        );
      }

      const data = (await response.json()) as {
        output_text?: string;
        output?: Array<{
          content?: Array<{ text?: string }>;
        }>;
      };
      const reply =
        data.output_text?.trim() ||
        data.output
          ?.flatMap((item) => item.content ?? [])
          .map((item) => item.text?.trim() ?? '')
          .filter(Boolean)
          .join('\n\n')
          .trim();

      if (!reply) {
        throw new Error('OpenAI direct WhatsApp reply returned no text');
      }

      this.logger.log('WhatsApp AI reply completed');
      return reply;
    } catch (error) {
      this.logger.error(
        'WhatsApp AI reply failed',
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  private async generateSynchronousReply(
    message: InboundWhatsAppMessage,
  ): Promise<WhatsAppReplyResult> {
    const mode = this.readReplyMode();
    if (mode === 'fallback') {
      return {
        body: this.fallbackReply,
        source: 'fallback',
        fallbackReason: 'WHATSAPP_REPLY_MODE=fallback',
      };
    }

    const reply = await this.withAiReplyTimeout(
      this.generateDirectAiReply(message.textBody),
    );

    if (reply) {
      return { body: reply, source: 'direct_ai' };
    }

    return {
      body: this.fallbackReply,
      source: 'fallback',
      fallbackReason: 'openai_failed_or_timed_out',
    };
  }

  private async withAiReplyTimeout(
    replyPromise: Promise<string | null | undefined>,
  ) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        replyPromise,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => {
            this.logger.warn(
              `WhatsApp AI reply timed out after ${this.aiReplyTimeoutMs}ms; sending fallback`,
            );
            resolve(null);
          }, this.aiReplyTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async persistWhatsAppExchange(
    message: InboundWhatsAppMessage,
    reply: WhatsAppReplyResult,
  ) {
    this.logger.log(
      `WhatsApp async persistence starting: ${JSON.stringify({
        waId: this.maskPhoneNumber(message.waId),
        messageId: message.messageId,
        replySource: reply.source,
      })}`,
    );

    try {
      const identity = await this.resolveSupportIdentity(message);
      if (!identity) {
        this.logger.log(
          `WhatsApp async persistence completed: ${JSON.stringify({
            waId: this.maskPhoneNumber(message.waId),
            messageId: message.messageId,
            persisted: false,
            reason: 'merchant_or_support_user_unresolved',
          })}`,
        );
        return;
      }

      const conversationTitle = `WhatsApp - ${message.senderName || message.waId}`;
      const conversationId =
        this.conversationIdsByWaId.get(message.waId) ??
        (await this.findExistingConversationId({
          merchantId: identity.merchantId,
          userId: identity.userId,
          conversationTitle,
        })) ??
        (await this.createSupportConversation({
          merchantId: identity.merchantId,
          userId: identity.userId,
          conversationTitle,
        }));

      this.conversationIdsByWaId.set(message.waId, conversationId);

      const metadata = {
        channel: 'whatsapp',
        waId: message.waId,
        senderName: message.senderName ?? null,
        phoneNumberId: message.phoneNumberId ?? null,
        wabaId: message.wabaId ?? null,
        messageId: message.messageId,
        timestamp: message.timestamp ?? null,
        replySource: reply.source,
        confidence: reply.source === 'direct_ai' ? 'medium' : 'low',
        fallbackReason: reply.fallbackReason ?? null,
        rawPayloadSummary: message.rawPayloadSummary,
      };

      await this.prisma.supportMessage.create({
        data: {
          conversationId,
          role: SupportMessageRole.USER,
          content: message.textBody,
          contextSnapshot: metadata as unknown as Prisma.InputJsonValue,
        },
      });

      await this.prisma.supportMessage.create({
        data: {
          conversationId,
          role: SupportMessageRole.ASSISTANT,
          content: reply.body,
          contextSnapshot: metadata as unknown as Prisma.InputJsonValue,
        },
      });

      await this.prisma.supportConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      });

      this.logger.log(
        `WhatsApp async persistence completed: ${JSON.stringify({
          waId: this.maskPhoneNumber(message.waId),
          messageId: message.messageId,
          merchantId: identity.merchantId,
          conversationId,
          persisted: true,
        })}`,
      );
    } catch (error) {
      this.logger.error(
        'WhatsApp async persistence failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async createSupportConversation(args: {
    merchantId: string;
    userId: string;
    conversationTitle: string;
  }) {
    const conversation = await this.prisma.supportConversation.create({
      data: {
        merchantId: args.merchantId,
        userId: args.userId,
        title: args.conversationTitle,
      },
      select: { id: true },
    });

    return conversation.id;
  }

  async sendTextMessage(to: string, body: string) {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    if (!accessToken || !phoneNumberId) {
      this.logger.warn(
        'WhatsApp reply skipped because WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is missing',
      );
      return;
    }

    const apiVersion = process.env.WHATSAPP_GRAPH_VERSION?.trim() || 'v19.0';
    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );

    const responseBody = (await response.json().catch(() => null)) as {
      messages?: Array<{ id?: string }>;
    } | null;

    if (!response.ok) {
      this.logger.error(
        `WhatsApp send failed (${response.status}): ${JSON.stringify(responseBody)}`,
      );
      return;
    }

    this.logger.log(
      `WhatsApp reply sent: ${JSON.stringify({
        to: this.maskPhoneNumber(to),
        messageId: responseBody?.messages?.[0]?.id,
      })}`,
    );
  }

  private hasProcessed(messageId: string) {
    if (this.processedMessageIds.has(messageId)) {
      return true;
    }

    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > 1000) {
      const oldest = this.processedMessageIds.values().next().value as
        | string
        | undefined;
      if (oldest) {
        this.processedMessageIds.delete(oldest);
      }
    }

    return false;
  }

  private isDebugLoggingEnabled() {
    return process.env.WHATSAPP_DEBUG_LOGS?.trim().toLowerCase() === 'true';
  }

  private readAiReplyTimeoutMs() {
    const configured = Number(process.env.WHATSAPP_AI_REPLY_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : 10000;
  }

  private readReplyMode() {
    const configured = process.env.WHATSAPP_REPLY_MODE?.trim();
    return configured === 'support_agent' || configured === 'fallback'
      ? configured
      : 'direct_ai';
  }

  private isAsyncPersistenceEnabled() {
    return process.env.WHATSAPP_ASYNC_PERSISTENCE_ENABLED?.trim() !== 'false';
  }

  private preview(value: string) {
    return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
  }

  private maskPhoneNumber(value?: string) {
    if (!value) {
      return undefined;
    }

    return value.length <= 4
      ? '****'
      : `${'*'.repeat(Math.max(value.length - 4, 0))}${value.slice(-4)}`;
  }
}
