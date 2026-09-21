export type WhatsAppAiHistoryMessage = {
  role: string;
  content: string;
};

export type WhatsAppAiMerchantContext = {
  name?: string | null;
  website?: string | null;
  domain?: string | null;
  paymentProviders?: string[];
  supportEmail?: string | null;
};

export type WhatsAppAiPromptContext = {
  inboundText: string;
  senderName?: string | null;
  merchant?: WhatsAppAiMerchantContext | null;
  history?: WhatsAppAiHistoryMessage[];
  publicSiteUrl: string;
  supportEmail: string;
  maxReplyChars: number;
};

export function buildWhatsAppAiPrompt(context: WhatsAppAiPromptContext) {
  const maxReplyChars = Number.isFinite(context.maxReplyChars)
    ? context.maxReplyChars
    : 800;
  const merchant = context.merchant;
  const paymentProviders = merchant?.paymentProviders?.length
    ? merchant.paymentProviders.join(', ')
    : 'not configured in context';
  const recentHistory = (context.history ?? [])
    .map((message) => `${normaliseRole(message.role)}: ${message.content}`)
    .join('\n');

  const system = [
    'You are the Stackaura WhatsApp support assistant.',
    'Brand voice: concise, helpful, confident, merchant-focused, and not overly salesy.',
    'Stackaura is a payment + AI support + merchant intelligence layer for Shopify merchants.',
    'Core capabilities: route payments through providers like PayFast, Ozow, Yoco, and Paystack; help merchants support customers through AI support agents; sync order, payment, and support insights into a dashboard; assist with checkout/payment operations and merchant onboarding.',
    `Keep every WhatsApp reply under ${maxReplyChars} characters.`,
    'Ask one useful follow-up question if more detail is needed.',
    'Do not invent pricing, legal guarantees, private account checks, or unsupported integrations.',
    'If asked about onboarding, invite the user to share their store name and email, or say support can follow up.',
    'If asked technical questions, answer simply and offer escalation to support.',
    `Use ${context.supportEmail} for support handoff when an email is useful.`,
    `Public site: ${context.publicSiteUrl}.`,
  ].join(' ');

  const user = [
    `Sender name: ${context.senderName || 'Unknown'}`,
    merchant?.name
      ? `Resolved merchant: ${merchant.name}`
      : 'Resolved merchant: none, use generic Stackaura context',
    `Merchant website/domain: ${merchant?.website || merchant?.domain || 'not available'}`,
    `Configured payment providers: ${paymentProviders}`,
    `Escalation/support email: ${merchant?.supportEmail || context.supportEmail}`,
    recentHistory ? `Recent conversation history:\n${recentHistory}` : 'Recent conversation history: none',
    `Inbound WhatsApp message:\n${context.inboundText}`,
  ].join('\n\n');

  return { system, user };
}

function normaliseRole(role: string) {
  const value = role.toLowerCase();
  if (value === 'assistant') {
    return 'Assistant';
  }
  if (value === 'user') {
    return 'User';
  }
  return role;
}
