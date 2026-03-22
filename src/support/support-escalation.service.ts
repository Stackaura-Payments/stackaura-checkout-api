import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  SupportConversationStatus,
  SupportEscalationStatus,
  SupportMessageRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MerchantSupportContext } from './support.types';

type EscalationConversation = {
  id: string;
  merchantId: string;
  userId: string;
  title: string | null;
  status: string;
  messages: Array<{
    role: SupportMessageRole;
    content: string;
    createdAt: Date;
  }>;
  escalations: Array<{
    id: string;
    status: SupportEscalationStatus;
    emailTo: string;
    summary: string;
    sentAt: Date | null;
    createdAt: Date;
  }>;
};

@Injectable()
export class SupportEscalationService {
  private readonly logger = new Logger(SupportEscalationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async escalateConversation(args: {
    conversation: EscalationConversation;
    merchantContext: MerchantSupportContext;
    reason?: string | null;
  }) {
    const existing = args.conversation.escalations.find(
      (item) =>
        item.status === SupportEscalationStatus.PENDING ||
        item.status === SupportEscalationStatus.SENT,
    );

    if (existing) {
      return {
        escalationId: existing.id,
        status: existing.status,
        emailTo: existing.emailTo,
        summary: existing.summary,
        sentAt: existing.sentAt?.toISOString() ?? null,
        alreadyEscalated: true,
      };
    }

    const emailTo = this.getSupportInboxEmail();
    const summary = this.buildSummary(args);
    const payload = this.buildPayload(args, emailTo, summary);

    const created = await this.prisma.supportEscalation.create({
      data: {
        conversationId: args.conversation.id,
        merchantId: args.conversation.merchantId,
        userId: args.conversation.userId,
        reason: (args.reason?.trim() || 'Human support requested').slice(0, 240),
        summary,
        payload: payload as Prisma.InputJsonValue,
        emailTo,
        status: SupportEscalationStatus.PENDING,
      },
      select: {
        id: true,
        status: true,
        emailTo: true,
      },
    });

    try {
      await this.deliverEscalationEmail({
        emailTo,
        merchantContext: args.merchantContext,
        payload,
        summary,
      });

      const updated = await this.prisma.supportEscalation.update({
        where: { id: created.id },
        data: {
          status: SupportEscalationStatus.SENT,
          sentAt: new Date(),
        },
        select: {
          id: true,
          status: true,
          emailTo: true,
          summary: true,
          sentAt: true,
        },
      });

      await this.prisma.supportConversation.update({
        where: { id: args.conversation.id },
        data: {
          status: SupportConversationStatus.ESCALATED,
          escalatedAt: new Date(),
        },
      });

      return {
        escalationId: updated.id,
        status: updated.status,
        emailTo: updated.emailTo,
        summary: updated.summary,
        sentAt: updated.sentAt?.toISOString() ?? null,
        alreadyEscalated: false,
      };
    } catch (error) {
      await this.prisma.supportEscalation.update({
        where: { id: created.id },
        data: {
          status: SupportEscalationStatus.FAILED,
          failureMessage:
            error instanceof Error ? error.message.slice(0, 1000) : String(error),
        },
      });

      throw error;
    }
  }

  private getSupportInboxEmail() {
    return process.env.SUPPORT_INBOX_EMAIL?.trim() || 'wesupport@stackaura.co.za';
  }

  private buildSummary(args: {
    conversation: EscalationConversation;
    merchantContext: MerchantSupportContext;
    reason?: string | null;
  }) {
    const latestUserMessage = [...args.conversation.messages]
      .reverse()
      .find((message) => message.role === SupportMessageRole.USER);

    const reason = args.reason?.trim() || 'Human support requested';

    return [
      `Merchant ${args.merchantContext.merchant.name} requires human support.`,
      `Reason: ${reason}.`,
      latestUserMessage
        ? `Latest merchant message: ${latestUserMessage.content}`
        : 'No user message was available in the transcript.',
      `Environment: ${args.merchantContext.merchant.currentEnvironment}.`,
      `Connected gateways: ${args.merchantContext.gateways.connectedCount}.`,
    ].join(' ');
  }

  private buildPayload(
    args: {
      conversation: EscalationConversation;
      merchantContext: MerchantSupportContext;
      reason?: string | null;
    },
    emailTo: string,
    summary: string,
  ) {
    return {
      emailTo,
      supportInboxIdentity: this.getSupportInboxEmail(),
      conversationId: args.conversation.id,
      reason: args.reason?.trim() || 'Human support requested',
      summary,
      merchant: {
        id: args.merchantContext.merchant.id,
        name: args.merchantContext.merchant.name,
        email: args.merchantContext.merchant.email,
        planCode: args.merchantContext.merchant.planCode,
        accountStatus: args.merchantContext.merchant.accountStatus,
        currentEnvironment: args.merchantContext.merchant.currentEnvironment,
      },
      context: args.merchantContext,
      transcript: args.conversation.messages.slice(-12).map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
      createdAt: new Date().toISOString(),
    };
  }

  private async deliverEscalationEmail(args: {
    emailTo: string;
    merchantContext: MerchantSupportContext;
    payload: Record<string, unknown>;
    summary: string;
  }) {
    const provider = (process.env.SUPPORT_ESCALATION_PROVIDER?.trim() || 'resend').toLowerCase();

    if (provider === 'resend') {
      await this.sendViaResend(args);
      return;
    }

    if (provider === 'webhook') {
      await this.sendViaWebhook(args);
      return;
    }

    throw new ServiceUnavailableException(
      'Support escalation provider is not configured correctly',
    );
  }

  private async sendViaResend(args: {
    emailTo: string;
    merchantContext: MerchantSupportContext;
    payload: Record<string, unknown>;
    summary: string;
  }) {
    const apiKey = process.env.SUPPORT_RESEND_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'SUPPORT_RESEND_API_KEY is required for support escalations',
      );
    }

    const from =
      process.env.SUPPORT_ESCALATION_FROM_EMAIL?.trim() ||
      this.getSupportInboxEmail();

    const subject = `Stackaura support escalation: ${args.merchantContext.merchant.name}`;
    const text = this.buildEmailText(args.summary, args.payload);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [args.emailTo],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`Resend escalation failed: ${body}`);
      throw new ServiceUnavailableException(
        `Support escalation email failed with status ${res.status}`,
      );
    }
  }

  private async sendViaWebhook(args: {
    emailTo: string;
    merchantContext: MerchantSupportContext;
    payload: Record<string, unknown>;
    summary: string;
  }) {
    const webhookUrl = process.env.SUPPORT_ESCALATION_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      throw new ServiceUnavailableException(
        'SUPPORT_ESCALATION_WEBHOOK_URL is required for webhook-based support escalations',
      );
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        emailTo: args.emailTo,
        subject: `Stackaura support escalation: ${args.merchantContext.merchant.name}`,
        summary: args.summary,
        payload: args.payload,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`Support escalation webhook failed: ${body}`);
      throw new ServiceUnavailableException(
        `Support escalation webhook failed with status ${res.status}`,
      );
    }
  }

  private buildEmailText(summary: string, payload: Record<string, unknown>) {
    return [
      'Stackaura support escalation',
      '',
      summary,
      '',
      'Structured escalation payload:',
      JSON.stringify(payload, null, 2),
    ].join('\n');
  }
}
