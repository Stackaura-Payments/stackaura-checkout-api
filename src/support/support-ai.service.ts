import { Injectable, Logger } from '@nestjs/common';
import {
  MerchantSupportContext,
  SupportAssistantReply,
  SupportKnowledgeMatch,
} from './support.types';

type SupportAiRequest = {
  merchantContext: MerchantSupportContext;
  userMessage: string;
  conversationHistory: Array<{
    role: 'USER' | 'ASSISTANT' | 'SYSTEM';
    content: string;
  }>;
  knowledgeMatches: SupportKnowledgeMatch[];
};

@Injectable()
export class SupportAiService {
  private readonly logger = new Logger(SupportAiService.name);

  async generateReply(args: SupportAiRequest): Promise<SupportAssistantReply> {
    const escalationReason = this.detectEscalationNeed(args.userMessage);
    const fallbackReply = this.buildFallbackReply(args, escalationReason);
    const apiKey =
      process.env.SUPPORT_AI_OPENAI_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      '';

    if (!apiKey) {
      return fallbackReply;
    }

    try {
      const reply = await this.generateOpenAiReply(args, apiKey);
      return {
        content: reply,
        citations: fallbackReply.citations,
        escalationRecommended: fallbackReply.escalationRecommended,
        escalationReason: fallbackReply.escalationReason,
        provider: 'openai',
      };
    } catch (error) {
      this.logger.warn(
        `Support AI provider unavailable, falling back to local guidance: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return fallbackReply;
    }
  }

  private async generateOpenAiReply(
    args: SupportAiRequest,
    apiKey: string,
  ): Promise<string> {
    const model = process.env.SUPPORT_AI_MODEL?.trim() || 'gpt-4.1-mini';
    const payload = {
      model,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: this.buildSystemPrompt(args),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: this.buildUserPrompt(args),
            },
          ],
        },
      ],
    };

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI support response failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      output_text?: string;
      output?: Array<{
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      }>;
    };

    const directText = data.output_text?.trim();
    if (directText) {
      return directText;
    }

    const outputText = data.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => (typeof item.text === 'string' ? item.text.trim() : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();

    if (!outputText) {
      throw new Error('OpenAI support response did not include output text');
    }

    return outputText;
  }

  private buildSystemPrompt(args: SupportAiRequest) {
    return [
      'You are Stackaura Support AI inside the authenticated merchant dashboard.',
      'You are merchant-aware, read-only, and should use only the supplied merchant context and knowledge snippets.',
      'Never reveal raw secrets or claim to have taken actions you did not take.',
      'Explain what you know, what is missing, and the most practical next step.',
      `If the issue looks like billing, fraud, compliance, legal, manual review, or cannot be safely resolved, recommend escalation to ${
        args.merchantContext.supportInboxEmail
      }.`,
      'Keep the answer concise, specific, and operationally useful.',
    ].join(' ');
  }

  private buildUserPrompt(args: SupportAiRequest) {
    const history = args.conversationHistory
      .slice(-6)
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');

    const knowledge = args.knowledgeMatches
      .map((entry) => `- ${entry.title} (${entry.url}): ${entry.content}`)
      .join('\n');

    return [
      `Merchant context JSON: ${JSON.stringify(args.merchantContext)}`,
      `Relevant knowledge snippets:\n${knowledge || '- None found'}`,
      `Conversation history:\n${history || 'No previous messages'}`,
      `Merchant question: ${args.userMessage}`,
    ].join('\n\n');
  }

  private buildFallbackReply(
    args: SupportAiRequest,
    escalationReason: string | null,
  ): SupportAssistantReply {
    const topic = this.detectTopic(args.userMessage);
    const context = args.merchantContext;
    const lines: string[] = [];

    if (topic === 'gateway') {
      lines.push(
        `Here is the current gateway state for ${context.merchant.name}: ${context.gateways.connectedCount} connected rail(s).`,
      );
      lines.push(
        `Ozow: ${String(context.gateways.ozow.connected)}. Yoco: ${String(
          context.gateways.yoco.connected,
        )}. Paystack: ${String(context.gateways.paystack.connected)}.`,
      );
    } else if (topic === 'api_keys') {
      lines.push(
        `This merchant currently has ${context.apiKeys.activeCount} active API key(s): ${context.apiKeys.testKeyCount} test and ${context.apiKeys.liveKeyCount} live.`,
      );
      if (!context.apiKeys.activeCount) {
        lines.push(
          'No active API keys are available right now, so authenticated API calls would fail until a new key is created.',
        );
      }
    } else if (topic === 'onboarding') {
      lines.push(
        `The merchant account status is ${context.merchant.accountStatus.toLowerCase().replace(/_/g, ' ')}.`,
      );
      lines.push(context.onboarding.detail);
    } else if (topic === 'payments') {
      const latestFailure = context.payments.recentFailures[0];
      lines.push(
        `This merchant has ${context.payments.totalPayments} payment(s) recorded with a ${context.payments.successRate.toFixed(
          1,
        )}% success rate.`,
      );
      if (latestFailure) {
        lines.push(
          `The latest failed or cancelled payment is ${latestFailure.reference} on ${
            latestFailure.updatedAt
          }, with provider status ${latestFailure.status.toLowerCase()}.`,
        );
      } else {
        lines.push('There are no recent failed or cancelled payments in the current support snapshot.');
      }
    } else if (topic === 'payouts') {
      lines.push(
        `Payout visibility is available for this merchant. There are ${context.payouts.pendingCount} pending payout(s) and ${context.payouts.failedCount} failed payout(s) in the current snapshot.`,
      );
    } else if (topic === 'integration') {
      lines.push(
        'Stackaura supports one backend integration for multiple gateways, payment creation, hosted checkout, and webhook-driven reconciliation.',
      );
      lines.push(
        'If you are integrating a website or backend, the fastest next step is usually checking the docs flow for payment creation and the dashboard pages for keys and gateway setup.',
      );
    } else {
      lines.push(
        `I’m answering for ${context.merchant.name} in ${context.merchant.currentEnvironment} mode with ${context.gateways.connectedCount} connected gateway rail(s).`,
      );
      lines.push(
        'I can help with gateway setup, integration guidance, account status, payment troubleshooting, and payout visibility using the current merchant context.',
      );
    }

    const bestKnowledge = args.knowledgeMatches[0];
    if (bestKnowledge) {
      lines.push(`The most relevant Stackaura guidance right now is ${bestKnowledge.title}.`);
    }

    lines.push(
      escalationReason
        ? `This looks like it should be escalated to human support at ${context.supportInboxEmail} because it involves ${escalationReason}.`
        : 'If this still does not resolve the issue, I can escalate the conversation to human support at wesupport@stackaura.co.za.',
    );

    return {
      content: lines.join('\n\n'),
      citations: args.knowledgeMatches.map((entry) => ({
        id: entry.id,
        title: entry.title,
        url: entry.url,
        excerpt: entry.excerpt,
        source: entry.source,
      })),
      escalationRecommended: Boolean(escalationReason),
      escalationReason,
      provider: 'fallback',
    };
  }

  private detectTopic(messageRaw: string) {
    const message = messageRaw.trim().toLowerCase();

    if (/(ozow|yoco|paystack|gateway|checkout fail|connection)/.test(message)) {
      return 'gateway';
    }
    if (/(api key|secret key|developer key|token)/.test(message)) {
      return 'api_keys';
    }
    if (/(onboarding|pending|activation|account pending|kyc)/.test(message)) {
      return 'onboarding';
    }
    if (/(payment|transaction|checkout|fail|error|declined|routing)/.test(message)) {
      return 'payments';
    }
    if (/(payout|settlement|withdrawal|transfer)/.test(message)) {
      return 'payouts';
    }
    if (/(integrate|integration|docs|shopify|website|api)/.test(message)) {
      return 'integration';
    }
    return 'general';
  }

  private detectEscalationNeed(messageRaw: string) {
    const message = messageRaw.trim().toLowerCase();

    if (/(fraud|chargeback|dispute|billing issue|invoice|refund dispute)/.test(message)) {
      return 'billing, dispute, or fraud handling';
    }

    if (/(legal|lawyer|lawsuit|compliance|kyc review|manual review)/.test(message)) {
      return 'legal, compliance, or manual review handling';
    }

    if (/(complaint|unhappy|human|person|support team)/.test(message)) {
      return 'a direct human support request';
    }

    return null;
  }
}
