import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  SupportConversationStatus,
  SupportMessageRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupportService } from '../support/support.service';
import {
  buildWhatsAppAiPrompt,
  WhatsAppAiHistoryMessage,
} from './whatsapp-ai.prompt';

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
type WhatsAppFallbackIntent =
  | 'about'
  | 'payments'
  | 'shopify'
  | 'support'
  | 'default';

type WhatsAppReplyResult = {
  body: string;
  source: WhatsAppReplySource;
  fallbackReason?: string;
};

type WhatsAppAiRuntimeContext = {
  merchantId?: string | null;
  merchantName?: string | null;
  merchantDomain?: string | null;
  paymentProviders: string[];
  supportEmail?: string | null;
  history: WhatsAppAiHistoryMessage[];
  generic: boolean;
};

type MerchantAiContextRecord = {
  id: string;
  name: string;
  email?: string | null;
  gatewayOrder?: Prisma.JsonValue | null;
  payfastMerchantId?: string | null;
  ozowSiteCode?: string | null;
  yocoSecretKey?: string | null;
  paystackSecretKey?: string | null;
};

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly processedMessageIds = new Set<string>();
  private readonly conversationIdsByWaId = new Map<string, string>();
  private readonly aiReplyTimeoutMs = this.readAiReplyTimeoutMs();
  private readonly aiContextTimeoutMs = 1000;

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
      process.env.STACKAURA_SUPPORT_EMAIL?.trim() ||
      'support@stackaura.co.za';

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

  private async buildAiContext(
    message: InboundWhatsAppMessage,
  ): Promise<WhatsAppAiRuntimeContext> {
    this.logger.log(
      `WhatsApp AI context build starting: ${JSON.stringify({
        waId: this.maskPhoneNumber(message.waId),
        messageId: message.messageId,
        phoneNumberId: message.phoneNumberId ?? null,
        wabaId: message.wabaId ?? null,
      })}`,
    );

    try {
      const context = await this.withAiContextTimeout(
        this.loadAiContextFromDb(message),
      );

      if (!context || context.generic) {
        this.logger.log('WhatsApp AI generic context applied');
        this.logger.log('WhatsApp AI context build completed');
        return this.buildGenericAiContext();
      }

      this.logger.log(
        `WhatsApp AI merchant context applied: ${JSON.stringify({
          merchantId: context.merchantId,
          merchantName: context.merchantName,
          historyMessages: context.history.length,
          paymentProviders: context.paymentProviders,
        })}`,
      );
      this.logger.log('WhatsApp AI context build completed');
      return context;
    } catch (error) {
      this.logger.warn(
        `WhatsApp AI context build failed, using generic context: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.logger.log('WhatsApp AI generic context applied');
      return this.buildGenericAiContext();
    }
  }

  private async withAiContextTimeout(
    contextPromise: Promise<WhatsAppAiRuntimeContext | null>,
  ) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        contextPromise,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), this.aiContextTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async loadAiContextFromDb(message: InboundWhatsAppMessage) {
    const merchant = await this.resolveMerchantAiContextFromMetaIds(message);
    if (!merchant) {
      return this.buildGenericAiContext();
    }

    const history = await this.loadRecentConversationHistory(
      merchant.id,
      message,
    );

    return {
      merchantId: merchant.id,
      merchantName: merchant.name,
      merchantDomain: this.extractEmailDomain(merchant.email),
      paymentProviders: this.extractPaymentProviders(merchant),
      supportEmail: this.readSupportEmail(),
      history,
      generic: false,
    };
  }

  private async resolveMerchantAiContextFromMetaIds(
    message: InboundWhatsAppMessage,
  ): Promise<MerchantAiContextRecord | null> {
    const filters = [
      message.phoneNumberId
        ? { whatsappPhoneNumberId: message.phoneNumberId }
        : null,
      message.wabaId ? { whatsappWabaId: message.wabaId } : null,
    ].filter(Boolean);

    if (!filters.length) {
      return null;
    }

    const prisma = this.prisma as unknown as {
      merchant: {
        findFirst(args: unknown): Promise<MerchantAiContextRecord | null>;
      };
    };

    return prisma.merchant.findFirst({
      where: {
        isActive: true,
        OR: filters,
      },
      select: {
        id: true,
        name: true,
        email: true,
        gatewayOrder: true,
        payfastMerchantId: true,
        ozowSiteCode: true,
        yocoSecretKey: true,
        paystackSecretKey: true,
      },
    });
  }

  private async loadRecentConversationHistory(
    merchantId: string,
    message: InboundWhatsAppMessage,
  ): Promise<WhatsAppAiHistoryMessage[]> {
    const maxMessages = this.readAiMaxHistoryMessages();
    if (maxMessages <= 0) {
      return [];
    }

    const conversationTitle = `WhatsApp - ${message.senderName || message.waId}`;
    const prisma = this.prisma as unknown as {
      supportConversation: {
        findFirst(args: unknown): Promise<{
          messages?: Array<{ role: string; content: string }>;
        } | null>;
      };
    };
    const conversation = await prisma.supportConversation.findFirst({
      where: {
        merchantId,
        title: conversationTitle,
        status: SupportConversationStatus.OPEN,
      },
      orderBy: { lastMessageAt: 'desc' },
      select: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: maxMessages,
          select: { role: true, content: true },
        },
      },
    });

    return (conversation?.messages ?? [])
      .slice(0, maxMessages)
      .reverse()
      .map((item) => ({
        role: item.role,
        content: this.preview(item.content),
      }));
  }

  private buildGenericAiContext(): WhatsAppAiRuntimeContext {
    return {
      paymentProviders: [],
      supportEmail: this.readSupportEmail(),
      history: [],
      generic: true,
    };
  }

  private extractPaymentProviders(merchant: MerchantAiContextRecord) {
    const providers = new Set<string>();
    if (Array.isArray(merchant.gatewayOrder)) {
      for (const gateway of merchant.gatewayOrder) {
        if (typeof gateway === 'string' && gateway.trim()) {
          providers.add(gateway.trim().toUpperCase());
        }
      }
    }

    if (merchant.payfastMerchantId) {
      providers.add('PAYFAST');
    }
    if (merchant.ozowSiteCode) {
      providers.add('OZOW');
    }
    if (merchant.yocoSecretKey) {
      providers.add('YOCO');
    }
    if (merchant.paystackSecretKey) {
      providers.add('PAYSTACK');
    }

    return [...providers];
  }

  private extractEmailDomain(email?: string | null) {
    const domain = email?.split('@')[1]?.trim();
    return domain || null;
  }

  private async generateDirectAiReply(message: InboundWhatsAppMessage) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      this.logger.warn(
        'WhatsApp direct AI reply failed: OPENAI_API_KEY is not configured',
      );
      return null;
    }

    this.logger.log('WhatsApp AI reply starting');

    try {
      const aiContext = await this.buildAiContext(message);
      const prompt = buildWhatsAppAiPrompt({
        inboundText: message.textBody,
        senderName: message.senderName,
        merchant: aiContext.generic
          ? null
          : {
              name: aiContext.merchantName,
              domain: aiContext.merchantDomain,
              paymentProviders: aiContext.paymentProviders,
              supportEmail: aiContext.supportEmail,
            },
        history: aiContext.history,
        publicSiteUrl: this.readPublicSiteUrl(),
        supportEmail: this.readSupportEmail(),
        maxReplyChars: this.readAiMaxReplyChars(),
      });

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
                  text: prompt.system,
                },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: prompt.user }],
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
      return this.trimReply(reply);
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
        body: this.getSmartFallbackReply(message.textBody),
        source: 'fallback',
        fallbackReason: 'WHATSAPP_REPLY_MODE=fallback',
      };
    }

    const reply = await this.withAiReplyTimeout(
      this.generateDirectAiReply(message),
    );

    if (reply) {
      return { body: reply, source: 'direct_ai' };
    }

    return {
      body: this.getSmartFallbackReply(message.textBody),
      source: 'fallback',
      fallbackReason: 'openai_failed_or_timed_out',
    };
  }

  private detectIntent(message: string): WhatsAppFallbackIntent {
    const msg = message.toLowerCase();
    if (
      msg.includes('what is stackaura') ||
      msg.includes('about') ||
      msg.includes('who are you')
    ) {
      return 'about';
    }
    if (
      msg.includes('payment') ||
      msg.includes('payments') ||
      msg.includes('pay') ||
      msg.includes('checkout') ||
      msg.includes('payfast') ||
      msg.includes('ozow') ||
      msg.includes('paystack') ||
      msg.includes('yoco')
    ) {
      return 'payments';
    }
    if (msg.includes('shopify') || msg.includes('store')) {
      return 'shopify';
    }
    if (
      msg.includes('help') ||
      msg.includes('support') ||
      msg.includes('issue') ||
      msg.includes('problem') ||
      msg.includes('failed')
    ) {
      return 'support';
    }

    return 'default';
  }

  private getSmartFallbackReply(message: string) {
    const intent = this.detectIntent(message);
    switch (intent) {
      case 'about':
        return 'Stackaura is a payment orchestration and AI support platform that helps merchants manage payments, automate support, and gain insights from their business.';
      case 'payments':
        return 'Stackaura helps you accept payments via PayFast, Ozow, Paystack, Yoco, and more - all in one unified system.';
      case 'shopify':
        return 'Stackaura integrates with Shopify to enhance checkout, route payments, and provide AI-powered customer support.';
      case 'support':
        return 'Our support agent is here to help. Can you describe your issue in more detail?';
      default:
        return "Hey, I'm Stackaura support. I can help with payments, Shopify, or your account. What would you like to know?";
    }
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

  private readAiMaxHistoryMessages() {
    const configured = Number(process.env.WHATSAPP_AI_MAX_HISTORY_MESSAGES);
    return Number.isFinite(configured) && configured >= 0 ? configured : 5;
  }

  private readAiMaxReplyChars() {
    const configured = Number(process.env.WHATSAPP_AI_MAX_REPLY_CHARS);
    return Number.isFinite(configured) && configured > 0 ? configured : 800;
  }

  private readPublicSiteUrl() {
    return (
      process.env.STACKAURA_PUBLIC_SITE_URL?.trim() || 'https://stackaura.co.za'
    );
  }

  private readSupportEmail() {
    return (
      process.env.STACKAURA_SUPPORT_EMAIL?.trim() ||
      process.env.SUPPORT_INBOX_EMAIL?.trim() ||
      'support@stackaura.co.za'
    );
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

  private trimReply(value: string) {
    const maxChars = this.readAiMaxReplyChars();
    const trimmed = value.trim();
    if (trimmed.length <= maxChars) {
      return trimmed;
    }

    return trimmed.slice(0, Math.max(maxChars - 1, 0)).trimEnd();
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
