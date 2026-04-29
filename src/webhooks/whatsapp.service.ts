import { Injectable, Logger } from '@nestjs/common';
import { SupportConversationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupportService } from '../support/support.service';

type WhatsAppMessage = {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
};

type WhatsAppWebhookPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppMessage[];
      };
    }>;
  }>;
};

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly processedMessageIds = new Set<string>();
  private readonly fallbackReply =
    'Hi, this is Stackaura support. We received your message and will assist shortly.';

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
    this.logger.log(
      `WhatsApp webhook received: ${JSON.stringify(this.summarizePayload(payload))}`,
    );

    const messages = this.extractMessages(payload);
    if (!messages.length) {
      return { received: true, processed: 0 };
    }

    let processed = 0;
    for (const message of messages) {
      if (!message.from || !message.text) {
        continue;
      }

      if (message.messageId && this.hasProcessed(message.messageId)) {
        this.logger.log(
          `Duplicate WhatsApp message ignored (messageId=${message.messageId})`,
        );
        continue;
      }

      await this.handleIncomingMessage({
        from: message.from,
        text: message.text,
        messageId: message.messageId,
      });
      processed += 1;
    }

    return { received: true, processed };
  }

  private extractMessages(payload: WhatsAppWebhookPayload) {
    return (payload.entry ?? [])
      .flatMap((entry) => entry.changes ?? [])
      .flatMap((change) => change.value?.messages ?? [])
      .map((message) => ({
        from: message.from,
        messageId: message.id,
        text: message.text?.body?.trim() ?? null,
      }));
  }

  private async handleIncomingMessage(args: {
    from: string;
    text: string;
    messageId?: string;
  }) {
    let reply = this.fallbackReply;

    try {
      reply = (await this.generateSupportReply(args)) || this.fallbackReply;
    } catch (error) {
      this.logger.error(
        `WhatsApp support reply generation failed (messageId=${args.messageId ?? 'n/a'})`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    await this.sendTextMessage(args.from, reply);
  }

  private async generateSupportReply(args: {
    from: string;
    text: string;
    messageId?: string;
  }) {
    const identity = await this.resolveSupportIdentity();
    if (!identity) {
      this.logger.warn(
        `WhatsApp AI reply skipped because WHATSAPP_MERCHANT_ID/WHATSAPP_SUPPORT_USER_ID are not configured (messageId=${args.messageId ?? 'n/a'})`,
      );
      return null;
    }

    const conversationTitle = `WhatsApp ${args.from}`;
    const conversation = await this.prisma.supportConversation.findFirst({
      where: {
        merchantId: identity.merchantId,
        userId: identity.userId,
        title: conversationTitle,
        status: SupportConversationStatus.OPEN,
      },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true },
    });

    const result = await this.supportService.chat({
      merchantId: identity.merchantId,
      userId: identity.userId,
      message: args.text,
      conversationId: conversation?.id,
      conversationTitle,
    });

    return [...result.conversation.messages]
      .reverse()
      .find((message) => message.role === 'ASSISTANT')
      ?.content?.trim();
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

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        `WhatsApp send failed (${response.status}): ${errorBody}`,
      );
    }
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

  private summarizePayload(payload: WhatsAppWebhookPayload) {
    const messages = this.extractMessages(payload);
    return {
      entries: payload.entry?.length ?? 0,
      messages: messages.map((message) => ({
        from: this.maskPhoneNumber(message.from),
        messageId: message.messageId,
        hasText: Boolean(message.text),
      })),
    };
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
