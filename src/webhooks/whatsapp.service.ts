import { Injectable, Logger } from '@nestjs/common';
import { SupportConversationStatus } from '@prisma/client';
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
  messageId: string;
  timestamp?: string;
  messageType: string;
  textBody: string;
  rawPayloadSummary: Record<string, unknown>;
};

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly processedMessageIds = new Set<string>();
  private readonly conversationIdsByWaId = new Map<string, string>();
  private readonly fallbackReply =
    'Hi, thanks for contacting Stackaura. We received your message and our support agent will assist you shortly.';
  private readonly supportReplyTimeoutMs = this.readSupportReplyTimeoutMs();

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
            messageId,
            timestamp: message.timestamp,
            messageType,
            textBody,
            rawPayloadSummary: {
              object: payload.object,
              entryId: entry.id,
              field: change.field,
              phoneNumberId,
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

    let reply: string | null | undefined = null;

    try {
      reply = await this.withSupportReplyTimeout(
        this.generateSupportReply(message),
      );
    } catch (error) {
      this.logger.error(
        `WhatsApp support reply generation failed (messageId=${message.messageId})`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    if (!reply) {
      await this.sendFallbackReply(message);
      return;
    }

    await this.sendTextMessage(message.waId, reply);
  }

  private async generateSupportReply(message: InboundWhatsAppMessage) {
    const identity = await this.resolveSupportIdentity();
    if (!identity) {
      this.logger.warn(
        `WhatsApp AI reply skipped because WHATSAPP_MERCHANT_ID/WHATSAPP_SUPPORT_USER_ID are not configured (messageId=${message.messageId})`,
      );
      return null;
    }

    const conversationTitle = `WhatsApp - ${message.senderName || message.waId}`;
    const conversationId =
      this.conversationIdsByWaId.get(message.waId) ??
      (await this.findExistingConversationId({
        merchantId: identity.merchantId,
        userId: identity.userId,
        conversationTitle,
      }));

    const result = await this.supportService.chat({
      merchantId: identity.merchantId,
      userId: identity.userId,
      message: message.textBody,
      conversationId,
      conversationTitle,
      channel: 'whatsapp',
      customerWaId: message.waId,
      customerName: message.senderName ?? null,
      metadata: {
        phoneNumberId: message.phoneNumberId,
        messageId: message.messageId,
        timestamp: message.timestamp,
        rawPayloadSummary: message.rawPayloadSummary,
      },
    });

    if (result.conversation?.id) {
      this.conversationIdsByWaId.set(message.waId, result.conversation.id);
    }

    return [...(result.conversation?.messages ?? [])]
      .reverse()
      .find((item) => item.role === 'ASSISTANT')
      ?.content?.trim();
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

  private async resolveSupportIdentity() {
    const merchantId = process.env.WHATSAPP_MERCHANT_ID?.trim();
    if (!merchantId) {
      return null;
    }

    const configuredUserId = process.env.WHATSAPP_SUPPORT_USER_ID?.trim();
    if (configuredUserId) {
      return { merchantId, userId: configuredUserId };
    }

    const membership = await this.prisma.membership.findFirst({
      where: { merchantId },
      orderBy: { createdAt: 'asc' },
      select: { userId: true },
    });

    return membership ? { merchantId, userId: membership.userId } : null;
  }

  private async withSupportReplyTimeout(
    replyPromise: Promise<string | null | undefined>,
  ) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        replyPromise,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => {
            this.logger.warn(
              `WhatsApp support reply timed out after ${this.supportReplyTimeoutMs}ms; sending fallback`,
            );
            resolve(null);
          }, this.supportReplyTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async sendFallbackReply(message: InboundWhatsAppMessage) {
    this.logger.log(
      `WhatsApp fallback reply send starting: ${JSON.stringify({
        waId: this.maskPhoneNumber(message.waId),
        messageId: message.messageId,
      })}`,
    );

    await this.sendTextMessage(message.waId, this.fallbackReply);

    this.logger.log(
      `WhatsApp fallback reply send completed: ${JSON.stringify({
        waId: this.maskPhoneNumber(message.waId),
        messageId: message.messageId,
      })}`,
    );
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

  private readSupportReplyTimeoutMs() {
    const configured = Number(process.env.WHATSAPP_SUPPORT_REPLY_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : 3000;
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
