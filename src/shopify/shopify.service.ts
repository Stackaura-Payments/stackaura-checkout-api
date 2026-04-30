import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { decryptStoredSecret, encryptStoredSecret } from '../security/secrets';
import { PrismaService } from '../prisma/prisma.service';

type ShopifySessionClaims = {
  aud?: string | string[];
  dest?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
};

type ShopifyRequestMeta = {
  rawBody?: string | Buffer;
  headers?: Record<string, string | string[] | undefined>;
};

type ShopifyTokenExchangeResponse = {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  associated_user_scope?: string;
};

type ShopifyWebhookRecord = {
  id: number;
  topic: string;
  address: string;
};

type ShopifyStatusResponse = {
  ok: boolean;
  connection: {
    connected: boolean;
    shopDomain: string;
    installedAt: string | null;
    updatedAt: string | null;
    scopes: string[];
    authMode: string;
    lastSuccessfulRefreshAt: string | null;
    appUrl: string | null;
  };
  store: {
    name: string | null;
    myshopifyDomain: string | null;
    planName: string | null;
  };
  products: {
    count: number;
    items: Array<{
      id: string;
      title: string;
      handle: string;
      status: string;
      updatedAt: string | null;
    }>;
  };
  webhooks: {
    topics: string[];
    callbackUrl: string | null;
    registrationStatus: string | null;
    healthy: boolean;
  };
  supportAgent: {
    enabled: boolean;
    configurationSaved: boolean;
    storefrontStatus:
      | 'not_deployed'
      | 'configured'
      | 'ready'
      | 'live_on_storefront';
    storefrontActivationObserved: boolean;
    storefrontActive: boolean;
    storefrontActivatedAt: string | null;
    storefrontLastSeenAt: string | null;
    storefrontActivationSource: string | null;
    storefrontLastPageUrl: string | null;
  };
  debug?: {
    stepReached?: string;
    upstreamEndpoint?: string | null;
    upstreamStatus?: number | null;
    upstreamErrorBody?: unknown;
  };
};

type ShopifySupportAgentResponse = {
  ok: boolean;
  supportAgent: {
    id: string | null;
    shopDomain: string;
    enabled: boolean;
    widgetStatus: 'not_deployed' | 'configured' | 'ready' | 'live_on_storefront';
    widgetStatusLabel: string;
    configurationSaved: boolean;
    greetingMessage: string;
    supportEmail: string;
    escalationEnabled: boolean;
    escalationLabel: string;
    themePreference: 'light' | 'dark' | 'auto';
    positionPreference: 'bottom-right' | 'bottom-left';
    shippingInfo: string | null;
    returnsPolicy: string | null;
    paymentMethodsEnabled: string | null;
    storeHelpSummary: string | null;
    storefrontActivationObserved: boolean;
    storefrontActive: boolean;
    storefrontActivatedAt: string | null;
    storefrontLastSeenAt: string | null;
    storefrontActivationSource: string | null;
    storefrontLastPageUrl: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    deploymentMessage: string;
  };
};

type ShopifySupportWidgetConfig = {
  shopDomain: string;
  enabled: boolean;
  greetingMessage: string;
  supportEmail: string | null;
  escalationEnabled: boolean;
  escalationLabel: string;
  themePreference: 'light' | 'dark' | 'auto';
  positionPreference: 'bottom-right' | 'bottom-left';
  deploymentStatus:
    | 'not_deployed'
    | 'ready'
    | 'theme_extension_pending'
    | 'live_on_storefront';
};

type ShopifySupportAgentDeploymentResponse = {
  ok: boolean;
  ready: boolean;
  missingRequirements: string[];
  widgetStatus:
    | 'not_configured'
    | 'configured'
    | 'ready_for_deployment'
    | 'live_on_storefront';
  shopDomain: string;
  activation: {
    storefrontActivationObserved: boolean;
    storefrontActive: boolean;
    storefrontActivatedAt: string | null;
    storefrontLastSeenAt: string | null;
    storefrontActivationSource: string | null;
    storefrontLastPageUrl: string | null;
  };
  widgetConfig: ShopifySupportWidgetConfig;
};

type ShopifySupportWidgetConfigResponse = {
  ok: boolean;
  deploymentMethod: 'theme_app_extension';
  extensionHandle: string;
  extensionScaffoldReady: boolean;
  widgetShellReady: boolean;
  conversationRuntimeReady: boolean;
  extensionConnected: boolean;
  storefrontChatUrl: string | null;
  storefrontActivationObserved: boolean;
  storefrontActivatedAt: string | null;
  storefrontLastSeenAt: string | null;
  storefrontActivationSource: string | null;
  storefrontLastPageUrl: string | null;
  storefrontInteractionPathStatus:
    | 'not_ready'
    | 'ready_pending_theme_activation'
    | 'live';
  currentDeploymentPhase:
    | 'configuration_incomplete'
    | 'theme_activation_required'
    | 'live_on_storefront';
  nextRequiredStep: string;
  themeEditorUrl: string | null;
  widgetConfig: ShopifySupportWidgetConfig;
};

type StorefrontSupportActivationRequest = {
  shop: string;
  source: 'theme_app_extension';
  pageUrl?: string;
  userAgent?: string;
};

type StorefrontSupportActivationResponse = {
  ok: boolean;
  activated: boolean;
  shopDomain: string;
  activatedAt: string;
};

type StorefrontSupportChatRequest = {
  shop: string;
  message: string;
  sessionId: string;
  pageUrl?: string;
};

type StorefrontSupportChatResponse = {
  ok: boolean;
  reply: string;
  sessionId: string;
  replySource: 'ai' | 'deterministic';
  replyConfidence?: number | null;
  fallbackReason?: string | null;
  escalationOffered?: boolean;
  supportEmail?: string | null;
};

type StorefrontSupportReplyResult = {
  reply: string;
  source: 'ai' | 'deterministic';
  confidence: number | null;
  fallbackReason: string | null;
  escalationSuggested: boolean;
};

type StorefrontSupportConversationHistoryEntry = {
  role: 'USER' | 'ASSISTANT';
  message: string;
  pageUrl: string | null;
  createdAt: Date;
};

type StorefrontAiReplyResponse = {
  reply?: string;
  confidence?: number;
  escalationSuggested?: boolean;
};

type StorefrontSupportReplyIntent =
  | 'payment_gateway'
  | 'payment_method'
  | 'checkout_payment'
  | 'transaction_issue'
  | 'order_flow'
  | 'greeting'
  | 'general';

type StorefrontPaymentProvider = 'paystack' | 'ozow' | 'yoco' | 'payfast';

type ShopifySupportConversationSummary = {
  sessionId: string;
  startedAt: string;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  escalationOffered: boolean;
  supportEmailShown: boolean;
  messageCount: number;
};

type ShopifySupportConversationsResponse = {
  ok: boolean;
  shopDomain: string;
  conversations: ShopifySupportConversationSummary[];
};

type ShopifySupportConversationDetailResponse = {
  ok: boolean;
  shopDomain: string;
  conversation: ShopifySupportConversationSummary & {
    messages: Array<{
      id: string;
      role: 'user' | 'assistant';
      message: string;
      pageUrl: string | null;
      metadata: unknown;
      createdAt: string;
    }>;
  };
};

type ShopifyRequestDebug = {
  stepReached: string;
  upstreamEndpoint: string | null;
  upstreamStatus: number | null;
  upstreamErrorBody: unknown;
  productsFetchSucceeded: boolean;
};

const DEFAULT_SCOPES = ['read_products', 'read_orders'];
const DEFAULT_API_VERSION = '2026-01';
const DEFAULT_WEBHOOK_PATH = '/api/shopify/webhooks';
const OFFLINE_ACCESS_TOKEN =
  'urn:shopify:params:oauth:token-type:offline-access-token';
const ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const DEFAULT_WEBHOOK_TOPICS = ['app/uninstalled'] as const;
const PROTECTED_CUSTOMER_DATA_WEBHOOK_TOPICS = ['orders/create'] as const;
const DEFAULT_SUPPORT_GREETING =
  'Hi there, how can we help you today?';
const DEFAULT_SUPPORT_ESCALATION_LABEL = 'Escalate to human';
const DEFAULT_SUPPORT_THEME = 'auto' as const;
const DEFAULT_SUPPORT_POSITION = 'bottom-right' as const;
const SUPPORT_THEME_PREFERENCES = ['light', 'dark', 'auto'] as const;
const SUPPORT_POSITION_PREFERENCES = ['bottom-right', 'bottom-left'] as const;
const SUPPORT_AGENT_THEME_EXTENSION_HANDLE = 'stackaura-support-agent-embed';
const MIN_STOREFRONT_AI_CONFIDENCE = 0.55;

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);

  constructor(private readonly prisma: PrismaService) {}

  health() {
    const appUrl = this.resolveAppUrl();

    return {
      ok: true,
      service: 'shopify',
      configured: this.hasRequiredConfig(),
      appUrl,
      scopes: this.resolveScopes(),
      apiVersion: this.resolveApiVersion(),
      webhookTarget: appUrl
        ? new URL(
            process.env.SHOPIFY_WEBHOOK_PATH?.trim() || DEFAULT_WEBHOOK_PATH,
            appUrl.endsWith('/') ? appUrl : `${appUrl}/`,
          ).toString()
        : null,
    };
  }

  readSessionTokenFromRequest(req: Request) {
    const authorization = req.header('authorization') ?? req.header('Authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Shopify session token');
    }

    const token = authorization.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('Missing Shopify session token');
    }

    return token;
  }

  async exchangeSessionToken(sessionToken: string) {
    const verified = this.verifySessionToken(sessionToken);
    const exchanged = await this.exchangeOfflineAccessToken(
      verified.shopDomain,
      sessionToken,
    );
    const encryptedAccessToken = encryptStoredSecret(exchanged.accessToken);
    if (!encryptedAccessToken) {
      throw new InternalServerErrorException(
        'Unable to encrypt Shopify access token',
      );
    }

    const install = await this.prisma.shopifyInstall.upsert({
      where: { shopDomain: verified.shopDomain },
      create: {
        shopDomain: verified.shopDomain,
        accessToken: encryptedAccessToken,
        scope: exchanged.scope,
      },
      update: {
        accessToken: encryptedAccessToken,
        scope: exchanged.scope,
      },
      select: {
        id: true,
        shopDomain: true,
        scope: true,
        installedAt: true,
        updatedAt: true,
      },
    });

    return {
      ok: true,
      authenticated: true,
      shopDomain: install.shopDomain,
      scope: install.scope,
      installedAt: install.installedAt.toISOString(),
      updatedAt: install.updatedAt.toISOString(),
      tokenType: 'offline',
      subject: verified.claims.sub ?? null,
    };
  }

  async getShopSnapshot(sessionToken: string) {
    const install = await this.ensureInstallForSession(sessionToken);
    const accessToken = decryptStoredSecret(install.accessToken);
    if (!accessToken) {
      throw new UnauthorizedException('Shopify installation is missing an access token');
    }
    const installWithConfig = await this.loadInstallWithSupportAgentConfig(
      install.shopDomain,
    );
    const supportAgent = this.serializeSupportAgentConfig(
      install.shopDomain,
      installWithConfig?.supportAgentConfig ?? null,
    );

    const callbackUrl = this.resolveWebhookCallbackUrl();
    const refreshedAt = new Date().toISOString();

    try {
      const [shopPayload, productsPayload, webhooksPayload] = await Promise.all([
        this.shopifyRestRequest<{ shop?: Record<string, unknown> }>(
          install.shopDomain,
          accessToken,
          '/shop.json',
          undefined,
          { stepReached: 'shop_fetch_started', productsFetchSucceeded: false },
        ),
        this.shopifyRestRequest<{ products?: Array<Record<string, unknown>> }>(
          install.shopDomain,
          accessToken,
          '/products.json?limit=3&fields=id,title,handle,status,updated_at',
          undefined,
          { stepReached: 'products_fetch_started', productsFetchSucceeded: false },
        ),
        this.shopifyRestRequest<{ webhooks?: ShopifyWebhookRecord[] }>(
          install.shopDomain,
          accessToken,
          '/webhooks.json?limit=250',
          undefined,
          { stepReached: 'webhooks_fetch_started', productsFetchSucceeded: false },
        ),
      ]);

      const store = this.serializeStore(shopPayload.shop, install.shopDomain);
      const productItems = this.serializeProducts(productsPayload.products);
      let totalProductCount = productItems.length;

      try {
        const countPayload = await this.shopifyRestRequest<{ count?: number }>(
          install.shopDomain,
          accessToken,
          '/products/count.json',
          undefined,
          { stepReached: 'products_count_started', productsFetchSucceeded: true },
        );
        if (typeof countPayload.count === 'number') {
          totalProductCount = countPayload.count;
        }
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'shopify.products.count.unavailable',
            shopDomain: install.shopDomain,
            error:
              error instanceof BadRequestException
                ? error.getResponse()
                : error instanceof Error
                  ? error.message
                  : 'unknown',
          }),
        );
      }

      const registeredTopics = this.serializeWebhookTopics(
        webhooksPayload.webhooks,
        callbackUrl,
      );

      return {
        ok: true,
        connection: {
          connected: true,
          shopDomain: install.shopDomain,
          installedAt: install.installedAt.toISOString(),
          updatedAt: install.updatedAt.toISOString(),
          scopes: this.parseScopes(install.scope),
          authMode: 'Shopify session token + offline token stored',
          lastSuccessfulRefreshAt: refreshedAt,
          appUrl: this.resolveAppUrl(),
        },
        store,
        products: {
          count: totalProductCount,
          items: productItems,
        },
        webhooks: {
          topics: registeredTopics,
          callbackUrl,
          registrationStatus:
            registeredTopics.length > 0
              ? `Active: ${registeredTopics.join(', ')}`
              : 'Not registered',
          healthy: registeredTopics.includes('app/uninstalled'),
        },
        supportAgent: {
          enabled: supportAgent.enabled,
          configurationSaved: supportAgent.configurationSaved,
          storefrontStatus: supportAgent.widgetStatus,
          storefrontActivationObserved:
            supportAgent.storefrontActivationObserved,
          storefrontActive: supportAgent.storefrontActive,
          storefrontActivatedAt: supportAgent.storefrontActivatedAt,
          storefrontLastSeenAt: supportAgent.storefrontLastSeenAt,
          storefrontActivationSource: supportAgent.storefrontActivationSource,
          storefrontLastPageUrl: supportAgent.storefrontLastPageUrl,
        },
        debug: {
          stepReached: 'snapshot_ready',
          upstreamEndpoint: '/products.json?limit=3&fields=id,title,handle,status,updated_at',
          upstreamStatus: 200,
          upstreamErrorBody: null,
        },
      } satisfies ShopifyStatusResponse;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException({
        message: 'Unable to load Shopify app status.',
        debug: {
          stepReached: 'snapshot_failed',
          upstreamEndpoint: null,
          upstreamStatus: null,
          upstreamErrorBody:
            error instanceof Error ? error.message : 'Unknown Shopify error',
        },
      });
    }
  }

  async registerWebhooks(sessionToken: string) {
    const install = await this.ensureInstallForSession(sessionToken);
    const accessToken = decryptStoredSecret(install.accessToken);
    if (!accessToken) {
      throw new UnauthorizedException('Shopify installation is missing an access token');
    }

    const callbackUrl = this.resolveWebhookCallbackUrl();
    const existing = await this.shopifyRestRequest<{
      webhooks?: ShopifyWebhookRecord[];
    }>(install.shopDomain, accessToken, '/webhooks.json?limit=250');

    const current = existing.webhooks ?? [];
    const topics = this.resolveWebhookTopics();
    const attemptedAt = new Date().toISOString();
    const registrations = [] as Array<{
      topic: string;
      address: string;
      id: number | null;
      created: boolean;
    }>;

    for (const topic of topics) {
      const match =
        current.find(
          (webhook) =>
            webhook.topic.toLowerCase() === topic && webhook.address === callbackUrl,
        ) ?? null;

      if (match) {
        registrations.push({
          topic,
          address: match.address,
          id: match.id,
          created: false,
        });
        continue;
      }

      const created = await this.shopifyRestRequest<{ webhook?: ShopifyWebhookRecord }>(
        install.shopDomain,
        accessToken,
        '/webhooks.json',
        {
          method: 'POST',
          body: JSON.stringify({
            webhook: {
              topic,
              address: callbackUrl,
              format: 'json',
            },
          }),
        },
      );

      registrations.push({
        topic,
        address: created.webhook?.address ?? callbackUrl,
        id: created.webhook?.id ?? null,
        created: true,
      });
    }

    const createdTopics = registrations.filter((entry) => entry.created).map((entry) => entry.topic);
    const result =
      createdTopics.length > 0
        ? `Registered webhook topic${createdTopics.length === 1 ? '' : 's'}: ${createdTopics.join(', ')}.`
        : `Webhook topic${registrations.length === 1 ? '' : 's'} already active: ${registrations
            .map((entry) => entry.topic)
            .join(', ')}.`;

    return {
      ok: true,
      shopDomain: install.shopDomain,
      callbackUrl,
      attemptedAt,
      result,
      healthy: registrations.some((entry) => entry.topic === 'app/uninstalled'),
      registrations,
    };
  }

  async getSupportAgentSettings(sessionToken: string) {
    const install = await this.ensureInstallForSession(sessionToken);
    const installWithConfig = await this.loadInstallWithSupportAgentConfig(
      install.shopDomain,
    );

    return {
      ok: true,
      supportAgent: this.serializeSupportAgentConfig(
        install.shopDomain,
        installWithConfig?.supportAgentConfig ?? null,
      ),
    } satisfies ShopifySupportAgentResponse;
  }

  async saveSupportAgentSettings(
    sessionToken: string,
    payload: Record<string, unknown>,
  ) {
    const install = await this.ensureInstallForSession(sessionToken);
    const normalized = this.normalizeSupportAgentInput(payload);

    await this.prisma.shopifyInstall.update({
      where: { shopDomain: install.shopDomain },
      data: {
        supportAgentConfig: {
          upsert: {
            create: {
              ...normalized,
            },
            update: normalized,
          },
        },
      },
    });

    const installWithConfig = await this.prisma.shopifyInstall.findUnique({
      where: { shopDomain: install.shopDomain },
      include: { supportAgentConfig: true },
    });

    return {
      ok: true,
      supportAgent: this.serializeSupportAgentConfig(
        install.shopDomain,
        installWithConfig?.supportAgentConfig ?? null,
      ),
    } satisfies ShopifySupportAgentResponse;
  }

  async getSupportAgentDeployment(sessionToken: string) {
    const install = await this.ensureInstallForSession(sessionToken);
    const installWithConfig = await this.loadInstallWithSupportAgentConfig(
      install.shopDomain,
    );

    return {
      ok: true,
      ...this.deriveSupportAgentDeployment(
        install.shopDomain,
        installWithConfig?.supportAgentConfig ?? null,
      ),
    } satisfies ShopifySupportAgentDeploymentResponse;
  }

  async getSupportAgentWidgetConfig(sessionToken: string) {
    const install = await this.ensureInstallForSession(sessionToken);
    const installWithConfig = await this.loadInstallWithSupportAgentConfig(
      install.shopDomain,
    );

    return {
      ok: true,
      ...this.deriveSupportAgentWidgetRuntime(
        install.shopDomain,
        installWithConfig?.supportAgentConfig ?? null,
      ),
    } satisfies ShopifySupportWidgetConfigResponse;
  }

  async getPublicSupportAgentWidgetConfig(shopDomain: string | undefined) {
    const normalizedShopDomain = this.normalizeShopDomain(shopDomain);
    if (!normalizedShopDomain) {
      throw new BadRequestException('Shop domain is required');
    }

    const installWithConfig = await this.loadInstallWithSupportAgentConfig(
      normalizedShopDomain,
    );
    if (!installWithConfig) {
      throw new NotFoundException('Shopify install not found for shop domain');
    }

    return {
      ok: true,
      ...this.deriveSupportAgentWidgetRuntime(
        normalizedShopDomain,
        installWithConfig.supportAgentConfig ?? null,
      ),
    } satisfies ShopifySupportWidgetConfigResponse;
  }

  async chatWithSupportAgent(payload: Record<string, unknown>) {
    const normalized = this.normalizeStorefrontSupportChatRequest(payload);
    const installWithConfig = await this.loadInstallWithSupportAgentConfig(
      normalized.shop,
    );

    if (!installWithConfig) {
      throw new NotFoundException('Shopify install not found for shop domain');
    }

    const supportAgent = this.serializeSupportAgentConfig(
      normalized.shop,
      installWithConfig.supportAgentConfig ?? null,
    );

    if (!supportAgent.enabled) {
      throw new BadRequestException(
        'Support Agent is not enabled for this Shopify shop',
      );
    }

    const conversationHistory =
      await this.loadStorefrontSupportConversationHistory({
        shopDomain: normalized.shop,
        sessionId: normalized.sessionId,
      });
    const replyResult = await this.generateStorefrontSupportReply({
      message: normalized.message,
      pageUrl: normalized.pageUrl ?? null,
      supportAgent,
      conversationHistory,
    });

    await this.persistStorefrontSupportConversation({
      shopDomain: normalized.shop,
      sessionId: normalized.sessionId,
      userMessage: normalized.message,
      assistantMessage: replyResult.reply,
      pageUrl: normalized.pageUrl ?? null,
      escalationOffered:
        replyResult.escalationSuggested ||
        (supportAgent.escalationEnabled && Boolean(supportAgent.supportEmail)),
      supportEmailShown: Boolean(supportAgent.supportEmail),
      assistantMetadata: {
        source: replyResult.source,
        confidence: replyResult.confidence,
        fallbackReason: replyResult.fallbackReason,
        escalationSuggested: replyResult.escalationSuggested,
      },
    });

    return {
      ok: true,
      reply: replyResult.reply,
      sessionId: normalized.sessionId,
      replySource: replyResult.source,
      replyConfidence: replyResult.confidence,
      fallbackReason: replyResult.fallbackReason,
      escalationOffered:
        replyResult.escalationSuggested ||
        (supportAgent.escalationEnabled && Boolean(supportAgent.supportEmail)),
      supportEmail: supportAgent.supportEmail || null,
    } satisfies StorefrontSupportChatResponse;
  }

  async getSupportAgentConversations(sessionToken: string) {
    const install = await this.ensureInstallForSession(sessionToken);
    const conversations = await this.prisma.shopifySupportConversation.findMany({
      where: { shopDomain: install.shopDomain },
      orderBy: { lastMessageAt: 'desc' },
      take: 25,
      include: {
        _count: {
          select: {
            messages: true,
          },
        },
      },
    });

    return {
      ok: true,
      shopDomain: install.shopDomain,
      conversations: conversations.map((conversation) =>
        this.serializeSupportConversationSummary(conversation),
      ),
    } satisfies ShopifySupportConversationsResponse;
  }

  async getSupportAgentConversation(sessionToken: string, sessionId: string) {
    const install = await this.ensureInstallForSession(sessionToken);
    const normalizedSessionId =
      this.normalizeOptionalString(sessionId, 255) ?? null;

    if (!normalizedSessionId) {
      throw new BadRequestException('Session ID is required');
    }

    const conversation =
      await this.prisma.shopifySupportConversation.findUnique({
        where: {
          shopDomain_sessionId: {
            shopDomain: install.shopDomain,
            sessionId: normalizedSessionId,
          },
        },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
          },
          _count: {
            select: {
              messages: true,
            },
          },
        },
      });

    if (!conversation) {
      throw new NotFoundException('Support conversation not found');
    }

    return {
      ok: true,
      shopDomain: install.shopDomain,
      conversation: {
        ...this.serializeSupportConversationSummary(conversation),
        messages: conversation.messages.map((message) => ({
          id: message.id,
          role: message.role === 'USER' ? 'user' : 'assistant',
          message: message.message,
          pageUrl: this.normalizeOptionalString(message.pageUrl, 2000) ?? null,
          metadata: message.metadata ?? null,
          createdAt: message.createdAt.toISOString(),
        })),
      },
    } satisfies ShopifySupportConversationDetailResponse;
  }

  async recordSupportAgentActivation(payload: Record<string, unknown>) {
    const normalized = this.normalizeStorefrontSupportActivationRequest(payload);
    const installWithConfig = await this.loadInstallWithSupportAgentConfig(
      normalized.shop,
    );

    if (!installWithConfig) {
      throw new NotFoundException('Shopify install not found for shop domain');
    }

    if (!installWithConfig.supportAgentConfig) {
      throw new BadRequestException(
        'Support Agent settings must be saved before storefront activation can be recorded',
      );
    }

    const deployment = this.deriveSupportAgentDeployment(
      normalized.shop,
      installWithConfig.supportAgentConfig,
    );

    if (!deployment.widgetConfig.enabled || !deployment.ready) {
      throw new BadRequestException(
        'Support Agent is not ready for storefront activation',
      );
    }

    const now = new Date();
    const activatedAt =
      installWithConfig.supportAgentConfig.storefrontWidgetActivatedAt ?? now;

    await this.prisma.shopifySupportAgentConfig.update({
      where: { shopDomain: normalized.shop },
      data: {
        storefrontWidgetActivatedAt: activatedAt,
        storefrontWidgetLastSeenAt: now,
        storefrontWidgetActivationSource: normalized.source,
        storefrontWidgetLastPageUrl:
          normalized.pageUrl ??
          installWithConfig.supportAgentConfig.storefrontWidgetLastPageUrl ??
          null,
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'shopify.support_agent.activation',
        shopDomain: normalized.shop,
        source: normalized.source,
        activatedAt: activatedAt.toISOString(),
        pageUrl: normalized.pageUrl ?? null,
      }),
    );

    return {
      ok: true,
      activated: true,
      shopDomain: normalized.shop,
      activatedAt: activatedAt.toISOString(),
    } satisfies StorefrontSupportActivationResponse;
  }

  async handleWebhook(body: Record<string, unknown>, meta: ShopifyRequestMeta) {
    const rawBody = this.stringifyBody(body, meta.rawBody);
    const headers = meta.headers ?? {};
    const hmacHeader = this.readHeader(headers, 'x-shopify-hmac-sha256');
    const topic = this.readHeader(headers, 'x-shopify-topic');
    const shopDomain = this.normalizeShopDomain(
      this.readHeader(headers, 'x-shopify-shop-domain'),
    );
    const webhookId = this.readHeader(headers, 'x-shopify-webhook-id');
    const hmacVerified = this.verifyWebhookSignature(rawBody, hmacHeader);
    const logContext = {
      event: 'shopify.webhook.processed',
      webhookId,
      topic: topic ?? 'unknown',
      shopDomain: shopDomain || null,
    };

    if (!hmacVerified) {
      this.logger.warn(
        JSON.stringify({
          ...logContext,
          hmacVerified: false,
          cleanupActionTaken: 'skipped_invalid_hmac',
          installRecordExisted: null,
          recordDeleted: false,
          recordDeactivated: false,
        }),
      );
      throw new UnauthorizedException('Invalid Shopify webhook signature');
    }

    let cleanupActionTaken = 'none';
    let installRecordExisted: boolean | null = null;
    let recordDeleted = false;
    const recordDeactivated = false;

    if (topic === 'app/uninstalled' && shopDomain) {
      const existingInstall = await this.prisma.shopifyInstall.findUnique({
        where: { shopDomain },
        select: { id: true },
      });

      installRecordExisted = Boolean(existingInstall);
      cleanupActionTaken = existingInstall
        ? 'delete_install_record'
        : 'install_record_missing';

      const deletion = await this.prisma.shopifyInstall.deleteMany({
        where: { shopDomain },
      });
      recordDeleted = deletion.count > 0;
    }

    if (topic === 'orders/create') {
      this.logger.log(
        JSON.stringify({
          event: 'shopify.webhook.received',
          topic,
          shopDomain,
          note: 'Protected customer data webhook received.',
        }),
      );
    }

    this.logger.log(
      JSON.stringify({
        ...logContext,
        hmacVerified: true,
        cleanupActionTaken,
        installRecordExisted,
        recordDeleted,
        recordDeactivated,
      }),
    );

    return {
      ok: true,
      topic: topic ?? 'unknown',
      shopDomain,
    };
  }

  private async ensureInstallForSession(sessionToken: string) {
    const verified = this.verifySessionToken(sessionToken);
    const existing = await this.prisma.shopifyInstall.findUnique({
      where: { shopDomain: verified.shopDomain },
      select: {
        id: true,
        shopDomain: true,
        accessToken: true,
        scope: true,
        installedAt: true,
        updatedAt: true,
      },
    });

    if (existing && decryptStoredSecret(existing.accessToken)) {
      return existing;
    }

    await this.exchangeSessionToken(sessionToken);
    const refreshed = await this.prisma.shopifyInstall.findUnique({
      where: { shopDomain: verified.shopDomain },
      select: {
        id: true,
        shopDomain: true,
        accessToken: true,
        scope: true,
        installedAt: true,
        updatedAt: true,
      },
    });

    if (!refreshed) {
      throw new InternalServerErrorException(
        'Unable to persist Shopify installation after token exchange',
      );
    }

    return refreshed;
  }

  private async loadInstallWithSupportAgentConfig(shopDomain: string) {
    try {
      return await this.prisma.shopifyInstall.findUnique({
        where: { shopDomain },
        include: { supportAgentConfig: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2021'
      ) {
        throw new ServiceUnavailableException(
          'Shopify support agent configuration is unavailable until the latest database migration is applied.',
        );
      }

      throw error;
    }
  }

  private async persistStorefrontSupportConversation(args: {
    shopDomain: string;
    sessionId: string;
    userMessage: string;
    assistantMessage: string;
    pageUrl: string | null;
    escalationOffered: boolean;
    supportEmailShown: boolean;
    assistantMetadata: Prisma.InputJsonValue;
  }) {
    const now = new Date();
    const conversation = await this.prisma.shopifySupportConversation.upsert({
      where: {
        shopDomain_sessionId: {
          shopDomain: args.shopDomain,
          sessionId: args.sessionId,
        },
      },
      create: {
        shopDomain: args.shopDomain,
        sessionId: args.sessionId,
        startedAt: now,
        lastMessageAt: now,
        lastUserMessage: args.userMessage,
        lastAssistantMessage: args.assistantMessage,
        escalationOffered: args.escalationOffered,
        supportEmailShown: args.supportEmailShown,
      },
      update: {
        lastMessageAt: now,
        lastUserMessage: args.userMessage,
        lastAssistantMessage: args.assistantMessage,
        escalationOffered: args.escalationOffered,
        supportEmailShown: args.supportEmailShown,
      },
      select: {
        id: true,
      },
    });

    await this.prisma.shopifySupportConversationMessage.createMany({
      data: [
        {
          conversationId: conversation.id,
          role: 'USER',
          message: args.userMessage,
          pageUrl: args.pageUrl,
        },
        {
          conversationId: conversation.id,
          role: 'ASSISTANT',
          message: args.assistantMessage,
          pageUrl: args.pageUrl,
          metadata: args.assistantMetadata,
        },
      ],
    });
  }

  private async loadStorefrontSupportConversationHistory(args: {
    shopDomain: string;
    sessionId: string;
  }): Promise<StorefrontSupportConversationHistoryEntry[]> {
    try {
      const conversation =
        await this.prisma.shopifySupportConversation.findUnique({
          where: {
            shopDomain_sessionId: {
              shopDomain: args.shopDomain,
              sessionId: args.sessionId,
            },
          },
          select: {
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 8,
              select: {
                role: true,
                message: true,
                pageUrl: true,
                createdAt: true,
              },
            },
          },
        });

      return (conversation?.messages ?? []).reverse();
    } catch (error) {
      this.logger.warn(
        `Unable to load storefront support history, continuing without history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  private serializeSupportConversationSummary(
    conversation: {
      sessionId: string;
      startedAt: Date;
      lastMessageAt: Date;
      lastUserMessage: string | null;
      lastAssistantMessage: string | null;
      escalationOffered: boolean;
      supportEmailShown: boolean;
      _count?: {
        messages: number;
      };
    },
  ): ShopifySupportConversationSummary {
    return {
      sessionId: conversation.sessionId,
      startedAt: conversation.startedAt.toISOString(),
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      lastMessagePreview:
        this.normalizeOptionalString(
          conversation.lastAssistantMessage ?? conversation.lastUserMessage,
          300,
        ) ?? null,
      lastUserMessage:
        this.normalizeOptionalString(conversation.lastUserMessage, 300) ?? null,
      lastAssistantMessage:
        this.normalizeOptionalString(conversation.lastAssistantMessage, 300) ??
        null,
      escalationOffered: conversation.escalationOffered,
      supportEmailShown: conversation.supportEmailShown,
      messageCount: conversation._count?.messages ?? 0,
    };
  }

  private verifySessionToken(sessionToken: string) {
    this.assertConfig();

    const parts = sessionToken.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Invalid Shopify session token');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const expectedSignature = createHmac('sha256', this.resolveApiSecret())
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    if (
      expectedSignature.length !== encodedSignature.length ||
      !timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(encodedSignature),
      )
    ) {
      throw new UnauthorizedException('Invalid Shopify session token');
    }

    const header = this.decodeJsonPart<Record<string, unknown>>(encodedHeader);
    const claims = this.decodeJsonPart<ShopifySessionClaims>(encodedPayload);
    if (header.alg !== 'HS256') {
      throw new UnauthorizedException('Unsupported Shopify session token');
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.nbf === 'number' && now < claims.nbf) {
      throw new UnauthorizedException('Shopify session token is not active yet');
    }
    if (typeof claims.exp === 'number' && now >= claims.exp) {
      throw new UnauthorizedException('Shopify session token expired');
    }

    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(this.resolveApiKey())) {
      throw new UnauthorizedException('Invalid Shopify session token audience');
    }

    const destination = claims.dest;
    if (!destination) {
      throw new UnauthorizedException('Shopify session token missing destination');
    }

    let shopDomain: string;
    try {
      shopDomain = this.normalizeShopDomain(new URL(destination).hostname);
    } catch {
      throw new UnauthorizedException('Shopify session token destination is invalid');
    }

    if (!shopDomain) {
      throw new UnauthorizedException('Shopify session token shop is invalid');
    }

    return { shopDomain, claims };
  }

  private async exchangeOfflineAccessToken(
    shopDomain: string,
    sessionToken: string,
  ) {
    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.resolveApiKey(),
        client_secret: this.resolveApiSecret(),
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: sessionToken,
        subject_token_type: ID_TOKEN,
        requested_token_type: OFFLINE_ACCESS_TOKEN,
      }),
    });

    const payload = (await this.safeParseJson(response)) as ShopifyTokenExchangeResponse &
      Record<string, unknown>;

    if (!response.ok || !payload.access_token) {
      const message =
        this.pickString(payload, ['error_description', 'error', 'message']) ??
        'Shopify token exchange failed';
      throw new UnauthorizedException(message);
    }

    return {
      accessToken: payload.access_token,
      scope: payload.scope ?? this.resolveScopes().join(','),
    };
  }

  private async shopifyRestRequest<T>(
    shopDomain: string,
    accessToken: string,
    path: string,
    init?: RequestInit,
    debug?: Partial<ShopifyRequestDebug>,
  ): Promise<T> {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${this.resolveApiVersion()}${path}`,
      {
        ...init,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-shopify-access-token': accessToken,
          ...(init?.headers ?? {}),
        },
      },
    );

    const payload = await this.safeParseJson(response);
    if (!response.ok) {
      const message =
        this.pickString(
          payload as Record<string, unknown>,
          ['message', 'error', 'errors'],
        ) ?? `Shopify Admin API request failed with status ${response.status}`;
      throw new BadRequestException({
        message,
        debug: {
          stepReached: debug?.stepReached ?? 'shopify_request_failed',
          upstreamEndpoint: path,
          upstreamStatus: response.status,
          upstreamErrorBody: payload,
          productsFetchSucceeded: debug?.productsFetchSucceeded ?? false,
        },
      });
    }

    return payload as T;
  }

  private verifyWebhookSignature(rawBody: string, signature: string | null) {
    if (!signature) return false;

    const expected = createHmac('sha256', this.resolveApiSecret())
      .update(rawBody)
      .digest('base64');

    if (expected.length !== signature.length) {
      return false;
    }

    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  private stringifyBody(
    body: Record<string, unknown>,
    rawBody?: string | Buffer,
  ) {
    if (typeof rawBody === 'string') return rawBody;
    if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');
    return JSON.stringify(body);
  }

  private decodeJsonPart<T>(value: string) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8')) as T;
  }

  private readHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ) {
    const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    if (Array.isArray(direct)) {
      return direct[0] ?? null;
    }
    return typeof direct === 'string' && direct.trim() ? direct.trim() : null;
  }

  private normalizeShopDomain(value: string | null | undefined) {
    if (!value) return '';
    return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }

  private serializeStore(
    shop: Record<string, unknown> | undefined,
    fallbackDomain: string,
  ) {
    return {
      name:
        this.pickString(shop ?? {}, ['name', 'shop_owner']) ??
        fallbackDomain.replace('.myshopify.com', ''),
      myshopifyDomain:
        this.pickString(shop ?? {}, ['myshopify_domain', 'domain']) ?? fallbackDomain,
      planName: this.pickString(shop ?? {}, ['plan_name', 'plan_display_name']) ?? null,
    };
  }

  private serializeProducts(products: Array<Record<string, unknown>> | undefined) {
    return (products ?? []).map((product) => ({
      id:
        typeof product.id === 'number' || typeof product.id === 'string'
          ? String(product.id)
          : 'unknown',
      title: this.pickString(product, ['title']) ?? 'Untitled product',
      handle: this.pickString(product, ['handle']) ?? 'No handle',
      status: this.pickString(product, ['status']) ?? 'unknown',
      updatedAt: this.pickString(product, ['updated_at']) ?? null,
    }));
  }

  private serializeSupportAgentConfig(
    shopDomain: string,
    config:
      | {
          id: string;
          enabled: boolean;
          greetingMessage: string | null;
          supportEmail: string | null;
          escalationEnabled: boolean;
          escalationLabel: string | null;
          themePreference: string;
          positionPreference: string;
          shippingInfo: string | null;
          returnsPolicy: string | null;
          paymentMethodsEnabled: string | null;
          storeHelpSummary: string | null;
          storefrontWidgetActivatedAt: Date | null;
          storefrontWidgetLastSeenAt: Date | null;
          storefrontWidgetActivationSource: string | null;
          storefrontWidgetLastPageUrl: string | null;
          createdAt: Date;
          updatedAt: Date;
        }
      | null,
  ) {
    const configurationSaved = Boolean(config);
    const enabled = config?.enabled ?? false;
    const supportEmail = this.normalizeOptionalString(config?.supportEmail, 255) ?? '';
    const storefrontActivationObserved = Boolean(
      config?.storefrontWidgetActivatedAt,
    );
    const storefrontActive =
      configurationSaved && enabled && Boolean(supportEmail) && storefrontActivationObserved;
    const widgetStatus:
      | 'not_deployed'
      | 'configured'
      | 'ready'
      | 'live_on_storefront' = !configurationSaved
      ? 'not_deployed'
      : storefrontActive
        ? 'live_on_storefront'
        : enabled && Boolean(supportEmail)
        ? 'ready'
        : 'configured';

    return {
      id: config?.id ?? null,
      shopDomain,
      enabled,
      widgetStatus,
      widgetStatusLabel:
        widgetStatus === 'live_on_storefront'
          ? 'Live on storefront'
          : widgetStatus === 'ready'
          ? 'Settings ready'
          : widgetStatus === 'configured'
            ? 'Configured'
            : 'Not deployed',
      configurationSaved,
      greetingMessage: config?.greetingMessage ?? DEFAULT_SUPPORT_GREETING,
      supportEmail,
      escalationEnabled: config?.escalationEnabled ?? true,
      escalationLabel: config?.escalationLabel ?? DEFAULT_SUPPORT_ESCALATION_LABEL,
      themePreference: this.normalizeSupportThemePreference(
        config?.themePreference,
      ),
      positionPreference: this.normalizeSupportPositionPreference(
        config?.positionPreference,
      ),
      shippingInfo:
        this.normalizeOptionalString(config?.shippingInfo, 2000) ?? null,
      returnsPolicy:
        this.normalizeOptionalString(config?.returnsPolicy, 2000) ?? null,
      paymentMethodsEnabled:
        this.normalizeOptionalString(config?.paymentMethodsEnabled, 1000) ?? null,
      storeHelpSummary:
        this.normalizeOptionalString(config?.storeHelpSummary, 2000) ?? null,
      storefrontActivationObserved,
      storefrontActive,
      storefrontActivatedAt:
        config?.storefrontWidgetActivatedAt?.toISOString() ?? null,
      storefrontLastSeenAt:
        config?.storefrontWidgetLastSeenAt?.toISOString() ?? null,
      storefrontActivationSource:
        this.normalizeOptionalString(
          config?.storefrontWidgetActivationSource,
          80,
        ) ?? null,
      storefrontLastPageUrl:
        this.normalizeOptionalString(config?.storefrontWidgetLastPageUrl, 2000) ??
        null,
      createdAt: config?.createdAt?.toISOString() ?? null,
      updatedAt: config?.updatedAt?.toISOString() ?? null,
      deploymentMessage:
        storefrontActive
          ? 'Activation has been observed from the live storefront widget.'
          : 'Theme app extension deployment is available through the Shopify app project.',
    };
  }

  private deriveSupportAgentDeployment(
    shopDomain: string,
    config:
      | {
          enabled: boolean;
          greetingMessage: string | null;
          supportEmail: string | null;
          escalationEnabled: boolean;
          escalationLabel: string | null;
          themePreference: string;
          positionPreference: string;
          storefrontWidgetActivatedAt: Date | null;
          storefrontWidgetLastSeenAt: Date | null;
          storefrontWidgetActivationSource: string | null;
          storefrontWidgetLastPageUrl: string | null;
        }
      | null,
  ) {
    const configurationSaved = Boolean(config);
    const enabled = config?.enabled ?? false;
    const greetingMessage =
      this.normalizeOptionalString(config?.greetingMessage, 500) ??
      DEFAULT_SUPPORT_GREETING;
    const supportEmail = this.normalizeOptionalString(config?.supportEmail, 255);
    const escalationEnabled = config?.escalationEnabled ?? true;
    const escalationLabel =
      this.normalizeOptionalString(config?.escalationLabel, 120) ??
      DEFAULT_SUPPORT_ESCALATION_LABEL;
    const themePreference = this.normalizeSupportThemePreference(
      config?.themePreference,
    );
    const positionPreference = this.normalizeSupportPositionPreference(
      config?.positionPreference,
    );

    const missingRequirements: string[] = [];
    if (!configurationSaved) {
      missingRequirements.push('Save Support Agent settings');
    }
    if (!enabled) {
      missingRequirements.push('Enable Support Agent');
    }
    if (!greetingMessage.trim()) {
      missingRequirements.push('Add greeting message');
    }
    if (!supportEmail) {
      missingRequirements.push('Add primary support email');
    }
    if (escalationEnabled && !escalationLabel.trim()) {
      missingRequirements.push('Add escalation label');
    }

    const ready = configurationSaved && missingRequirements.length === 0;
    const storefrontActivationObserved = Boolean(
      config?.storefrontWidgetActivatedAt,
    );
    const storefrontActive = ready && storefrontActivationObserved;
    const widgetStatus:
      | 'not_configured'
      | 'configured'
      | 'ready_for_deployment'
      | 'live_on_storefront' = !configurationSaved
      ? 'not_configured'
      : storefrontActive
        ? 'live_on_storefront'
        : ready
        ? 'ready_for_deployment'
        : 'configured';

    return {
      ready,
      missingRequirements,
      widgetStatus,
      shopDomain,
      activation: {
        storefrontActivationObserved,
        storefrontActive,
        storefrontActivatedAt:
          config?.storefrontWidgetActivatedAt?.toISOString() ?? null,
        storefrontLastSeenAt:
          config?.storefrontWidgetLastSeenAt?.toISOString() ?? null,
        storefrontActivationSource:
          this.normalizeOptionalString(
            config?.storefrontWidgetActivationSource,
            80,
          ) ?? null,
        storefrontLastPageUrl:
          this.normalizeOptionalString(config?.storefrontWidgetLastPageUrl, 2000) ??
          null,
      },
      widgetConfig: {
        shopDomain,
        enabled,
        greetingMessage,
        supportEmail,
        escalationEnabled,
        escalationLabel,
        themePreference,
        positionPreference,
        deploymentStatus: storefrontActive
          ? ('live_on_storefront' as const)
          : ready
            ? ('theme_extension_pending' as const)
            : ('not_deployed' as const),
      },
    };
  }

  private deriveSupportAgentWidgetRuntime(
    shopDomain: string,
    config:
      | {
          enabled: boolean;
          greetingMessage: string | null;
          supportEmail: string | null;
          escalationEnabled: boolean;
          escalationLabel: string | null;
          themePreference: string;
          positionPreference: string;
          storefrontWidgetActivatedAt: Date | null;
          storefrontWidgetLastSeenAt: Date | null;
          storefrontWidgetActivationSource: string | null;
          storefrontWidgetLastPageUrl: string | null;
        }
      | null,
  ) {
    const deployment = this.deriveSupportAgentDeployment(shopDomain, config);
    const extensionConnected = deployment.activation.storefrontActive;
    const extensionScaffoldReady = true;
    const widgetShellReady = true;
    const conversationRuntimeReady = true;
    const storefrontChatUrl = this.buildStorefrontSupportChatUrl();

    const widgetConfig: ShopifySupportWidgetConfig = {
      ...deployment.widgetConfig,
    };

    const currentDeploymentPhase:
      | 'configuration_incomplete'
      | 'theme_activation_required'
      | 'live_on_storefront' =
      widgetConfig.deploymentStatus === 'live_on_storefront'
        ? 'live_on_storefront'
        : deployment.ready
          ? 'theme_activation_required'
          : 'configuration_incomplete';

    const themeEditorUrl = this.buildThemeEditorUrl(shopDomain);
    const storefrontInteractionPathStatus:
      | 'not_ready'
      | 'ready_pending_theme_activation'
      | 'live' = widgetConfig.deploymentStatus === 'live_on_storefront'
      ? 'live'
      : deployment.ready
        ? 'ready_pending_theme_activation'
        : 'not_ready';
    const nextRequiredStep = deployment.ready
      ? deployment.activation.storefrontActive
        ? 'Storefront activation has been observed. Keep the Stackaura Support Agent app embed enabled in your live theme.'
        : 'Activate the Stackaura Support Agent app embed block in the Shopify theme editor and keep the Stackaura app URL field set to this app origin.'
      : 'Complete Support Agent settings so the widget can be prepared for storefront deployment.';

    return {
      deploymentMethod: 'theme_app_extension' as const,
      extensionHandle: SUPPORT_AGENT_THEME_EXTENSION_HANDLE,
      extensionScaffoldReady,
      widgetShellReady,
      conversationRuntimeReady,
      extensionConnected,
      storefrontChatUrl,
      storefrontActivationObserved:
        deployment.activation.storefrontActivationObserved,
      storefrontActivatedAt: deployment.activation.storefrontActivatedAt,
      storefrontLastSeenAt: deployment.activation.storefrontLastSeenAt,
      storefrontActivationSource:
        deployment.activation.storefrontActivationSource,
      storefrontLastPageUrl: deployment.activation.storefrontLastPageUrl,
      storefrontInteractionPathStatus,
      currentDeploymentPhase,
      nextRequiredStep,
      themeEditorUrl,
      widgetConfig,
    };
  }

  private buildStorefrontSupportChatUrl() {
    const appUrl = this.resolveAppUrl();
    if (!appUrl) {
      return null;
    }

    return new URL(
      '/shopify/support-agent/chat',
      appUrl.endsWith('/') ? appUrl : `${appUrl}/`,
    ).toString();
  }

  private buildThemeEditorUrl(shopDomain: string) {
    const apiKey = this.resolveApiKey();
    if (!apiKey || !shopDomain) {
      return null;
    }

    return `https://${shopDomain}/admin/themes/current/editor?context=apps&template=index&activateAppId=${apiKey}/${SUPPORT_AGENT_THEME_EXTENSION_HANDLE}`;
  }

  private normalizeSupportAgentInput(payload: Record<string, unknown>) {
    const supportEmail = this.normalizeOptionalString(payload.supportEmail, 255);
    if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) {
      throw new BadRequestException('Support email must be a valid email address');
    }

    return {
      enabled: this.readBoolean(payload.enabled, false),
      greetingMessage:
        this.normalizeOptionalString(payload.greetingMessage, 500) ??
        DEFAULT_SUPPORT_GREETING,
      supportEmail,
      escalationEnabled: this.readBoolean(payload.escalationEnabled, true),
      escalationLabel:
        this.normalizeOptionalString(payload.escalationLabel, 120) ??
        DEFAULT_SUPPORT_ESCALATION_LABEL,
      themePreference: this.normalizeSupportThemePreference(payload.themePreference),
      positionPreference: this.normalizeSupportPositionPreference(
        payload.positionPreference,
      ),
      shippingInfo: this.normalizeOptionalString(payload.shippingInfo, 2000),
      returnsPolicy: this.normalizeOptionalString(payload.returnsPolicy, 2000),
      paymentMethodsEnabled: this.normalizeOptionalString(
        payload.paymentMethodsEnabled,
        1000,
      ),
      storeHelpSummary: this.normalizeOptionalString(
        payload.storeHelpSummary,
        2000,
      ),
    };
  }

  private normalizeStorefrontSupportChatRequest(
    payload: Record<string, unknown>,
  ): StorefrontSupportChatRequest {
    const shop = this.normalizeShopDomain(this.pickString(payload, ['shop']));
    if (!shop) {
      throw new BadRequestException('Shop domain is required');
    }

    const message = this.normalizeOptionalString(payload.message, 1500);
    if (!message) {
      throw new BadRequestException('Message is required');
    }

    const sessionId = this.normalizeOptionalString(payload.sessionId, 255);
    if (!sessionId) {
      throw new BadRequestException('Session ID is required');
    }

    const pageUrl = this.normalizeStorefrontPageUrl(payload.pageUrl);

    return {
      shop,
      message,
      sessionId,
      pageUrl,
    };
  }

  private normalizeStorefrontSupportActivationRequest(
    payload: Record<string, unknown>,
  ): StorefrontSupportActivationRequest {
    const shop = this.normalizeShopDomain(this.pickString(payload, ['shop']));
    if (!shop) {
      throw new BadRequestException('Shop domain is required');
    }

    const source =
      this.normalizeOptionalString(payload.source, 80) ?? 'theme_app_extension';
    if (source !== 'theme_app_extension') {
      throw new BadRequestException('Unsupported activation source');
    }

    return {
      shop,
      source: 'theme_app_extension',
      pageUrl: this.normalizeStorefrontPageUrl(payload.pageUrl),
      userAgent:
        this.normalizeOptionalString(payload.userAgent, 500) ?? undefined,
    };
  }

  private async generateStorefrontSupportReply(args: {
    message: string;
    pageUrl: string | null;
    supportAgent: ReturnType<ShopifyService['serializeSupportAgentConfig']>;
    conversationHistory: StorefrontSupportConversationHistoryEntry[];
  }): Promise<StorefrontSupportReplyResult> {
    const deterministicReply = this.composeStorefrontSupportReply({
      message: args.message,
      pageUrl: args.pageUrl,
      supportAgent: args.supportAgent,
    });
    const deterministicResult: StorefrontSupportReplyResult = {
      reply: deterministicReply,
      source: 'deterministic',
      confidence: null,
      fallbackReason: null,
      escalationSuggested: this.shouldSuggestStorefrontEscalation(args.message),
    };

    const aiKey = this.resolveStorefrontAiApiKey();
    if (!aiKey) {
      return {
        ...deterministicResult,
        fallbackReason: 'missing_ai_api_key',
      };
    }

    try {
      const aiReply = await this.generateStorefrontAiReply({
        ...args,
        apiKey: aiKey,
      });
      const reply = this.normalizeOptionalString(aiReply.reply, 1200);
      const confidence =
        typeof aiReply.confidence === 'number' && Number.isFinite(aiReply.confidence)
          ? Math.max(0, Math.min(1, aiReply.confidence))
          : null;

      if (!reply) {
        return {
          ...deterministicResult,
          fallbackReason: 'empty_ai_reply',
        };
      }

      if (confidence === null) {
        return {
          ...deterministicResult,
          fallbackReason: 'missing_ai_confidence',
        };
      }

      if (confidence !== null && confidence < MIN_STOREFRONT_AI_CONFIDENCE) {
        return {
          ...deterministicResult,
          confidence,
          fallbackReason: 'low_ai_confidence',
        };
      }

      return {
        reply,
        source: 'ai',
        confidence,
        fallbackReason: null,
        escalationSuggested:
          Boolean(aiReply.escalationSuggested) ||
          this.shouldSuggestStorefrontEscalation(args.message),
      };
    } catch (error) {
      this.logger.warn(
        `Storefront support AI unavailable, using deterministic fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        ...deterministicResult,
        fallbackReason: 'ai_error',
      };
    }
  }

  private async generateStorefrontAiReply(args: {
    message: string;
    pageUrl: string | null;
    supportAgent: ReturnType<ShopifyService['serializeSupportAgentConfig']>;
    conversationHistory: StorefrontSupportConversationHistoryEntry[];
    apiKey: string;
  }): Promise<StorefrontAiReplyResponse> {
    const model =
      process.env.SHOPIFY_SUPPORT_AI_MODEL?.trim() ||
      process.env.SUPPORT_AI_MODEL?.trim() ||
      'gpt-4.1-mini';
    const payload = {
      model,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: this.buildStorefrontAiSystemPrompt(),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: this.buildStorefrontAiUserPrompt(args),
            },
          ],
        },
      ],
    };

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI storefront support failed (${res.status}): ${text}`);
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
    const outputText =
      data.output_text?.trim() ||
      data.output
        ?.flatMap((item) => item.content ?? [])
        .map((item) => (typeof item.text === 'string' ? item.text.trim() : ''))
        .filter(Boolean)
        .join('\n\n')
        .trim();

    if (!outputText) {
      throw new Error('OpenAI storefront support response had no text');
    }

    return this.parseStorefrontAiReply(outputText);
  }

  private buildStorefrontAiSystemPrompt() {
    return [
      'You are Stackaura storefront support for a Shopify merchant.',
      'Answer only from the supplied store context and recent conversation.',
      'Be concise, friendly, and practical for a shopper on the storefront.',
      'Do not invent order, shipping, refund, product, or payment configuration facts.',
      'If the question needs private order or payment lookup, say human support should help.',
      'Return strict JSON only with keys reply, confidence, escalationSuggested.',
      'confidence must be a number from 0 to 1.',
    ].join(' ');
  }

  private buildStorefrontAiUserPrompt(args: {
    message: string;
    pageUrl: string | null;
    supportAgent: ReturnType<ShopifyService['serializeSupportAgentConfig']>;
    conversationHistory: StorefrontSupportConversationHistoryEntry[];
  }) {
    const supportAgent = args.supportAgent;
    const context = {
      shopDomain: supportAgent.shopDomain,
      currentPageUrl: args.pageUrl,
      currentPagePath: this.extractPathFromUrl(args.pageUrl),
      supportEmail: supportAgent.supportEmail || null,
      escalationEnabled: supportAgent.escalationEnabled,
      escalationLabel: supportAgent.escalationLabel,
      merchantKnowledge: {
        storeHelpSummary: supportAgent.storeHelpSummary,
        shippingInfo: supportAgent.shippingInfo,
        returnsPolicy: supportAgent.returnsPolicy,
        paymentMethodsEnabled: supportAgent.paymentMethodsEnabled,
      },
      supportedStackauraProviders: ['Paystack', 'Ozow', 'Yoco', 'PayFast'],
    };
    const history = args.conversationHistory
      .slice(-8)
      .map((message) => ({
        role: message.role,
        message: message.message,
        pageUrl: message.pageUrl,
        createdAt: message.createdAt.toISOString(),
      }));

    return [
      `Store context JSON: ${JSON.stringify(context)}`,
      `Recent conversation JSON: ${JSON.stringify(history)}`,
      `Customer message: ${args.message}`,
    ].join('\n\n');
  }

  private parseStorefrontAiReply(outputText: string): StorefrontAiReplyResponse {
    try {
      const parsed = JSON.parse(outputText) as StorefrontAiReplyResponse;
      return parsed;
    } catch {
      const match = outputText.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]) as StorefrontAiReplyResponse;
      }

      return {
        reply: outputText,
        confidence: 0.5,
        escalationSuggested: false,
      };
    }
  }

  private resolveStorefrontAiApiKey() {
    return (
      process.env.SHOPIFY_SUPPORT_AI_OPENAI_API_KEY?.trim() ||
      process.env.SUPPORT_AI_OPENAI_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      ''
    );
  }

  private shouldSuggestStorefrontEscalation(message: string) {
    return (
      this.classifyStorefrontSupportIntent(message) === 'transaction_issue' ||
      /\b(order number|tracking|where is my order|missing order|refund status|chargeback|fraud)\b/i.test(
        message,
      )
    );
  }

  private composeStorefrontSupportReply(args: {
    message: string;
    pageUrl: string | null;
    supportAgent: ReturnType<ShopifyService['serializeSupportAgentConfig']>;
  }) {
    const intent = this.classifyStorefrontSupportIntent(args.message);
    const provider = this.detectStorefrontPaymentProvider(args.message);
    const pagePath = this.extractPathFromUrl(args.pageUrl);

    const replyParts: string[] = [];

    switch (intent) {
      case 'payment_gateway':
        replyParts.push(this.composePaymentGatewayAnswer(provider));
        break;
      case 'payment_method':
        replyParts.push(this.composePaymentMethodAnswer(provider));
        break;
      case 'checkout_payment':
        replyParts.push(
          'Stackaura checkout lets a merchant connect supported payment providers, create a checkout or payment request, and route the customer to an eligible payment rail configured for that store.',
        );
        replyParts.push(
          'When the provider confirms the result, Stackaura records the payment outcome and webhook reconciliation for the merchant.',
        );
        break;
      case 'transaction_issue':
        replyParts.push(
          'Stackaura can help with payment and checkout troubleshooting, including failed, declined, pending, or missing payment outcomes.',
        );
        replyParts.push(
          'I cannot inspect this specific live payment attempt from storefront chat yet, but I can capture the issue and route it to the merchant support team.',
        );
        break;
      case 'order_flow':
        replyParts.push(
          'I can help with general order, delivery, refund, or return questions, but I cannot securely look up customer orders from this storefront chat yet.',
        );
        replyParts.push(
          'Please include the order number or contact the merchant support team for account-specific help.',
        );
        break;
      case 'greeting':
        replyParts.push(
          args.supportAgent.greetingMessage ||
            'Hi there. Thanks for reaching out to Stackaura Support on this storefront.',
        );
        replyParts.push(
          'Ask me about payments, checkout, supported gateways, or how to contact the merchant support team.',
        );
        break;
      case 'general':
      default:
        replyParts.push(
          'Thanks for your message. I can help with general storefront questions about payments, checkout, and merchant support routing.',
        );
        replyParts.push(
          'For account-specific order or payment lookups, the merchant support team will need to help directly.',
        );
        break;
    }

    if (pagePath) {
      replyParts.push(`You are currently messaging from ${pagePath}.`);
    }

    if (args.supportAgent.escalationEnabled && args.supportAgent.supportEmail) {
      replyParts.push(
        `${args.supportAgent.escalationLabel} is available at ${args.supportAgent.supportEmail}.`,
      );
    } else if (args.supportAgent.supportEmail) {
      replyParts.push(
        `For direct human help, contact ${args.supportAgent.supportEmail}.`,
      );
    }

    return replyParts.join(' ');
  }

  private classifyStorefrontSupportIntent(
    message: string,
  ): StorefrontSupportReplyIntent {
    const lowerMessage = message.toLowerCase();
    const mentionsProvider = Boolean(
      this.detectStorefrontPaymentProvider(message),
    );
    const mentionsGateway = /\b(gateway|provider|rail)\b/.test(lowerMessage);
    const mentionsPaymentMethod =
      /\b(card|bank|eft|instant eft|credit card|debit card|qr|wallet)\b/.test(
        lowerMessage,
      );
    const asksSupport =
      /\b(support|do you support|can i use|can we use|available|accept|pay with|pay using|use)\b/.test(
        lowerMessage,
      );

    if (mentionsProvider || (mentionsGateway && asksSupport)) {
      return 'payment_gateway';
    }

    if (mentionsPaymentMethod) {
      return 'payment_method';
    }

    if (
      /\b(failed|failure|declined|pending|stuck|missing|not working|error|charged|double charged|refunded|refund|receipt|reference|transaction id)\b/.test(
        lowerMessage,
      ) &&
      /\b(payment|checkout|pay|transaction|order)\b/.test(lowerMessage)
    ) {
      return 'transaction_issue';
    }

    if (
      /\b(how does checkout work|checkout work|checkout flow|payment flow|how do payments work|how does payment work)\b/.test(
        lowerMessage,
      ) ||
      /\b(payment|checkout|pay)\b/.test(
        lowerMessage,
      )
    ) {
      return 'checkout_payment';
    }

    if (/\b(order|shipping|delivery|refund|return|cancel)\b/.test(lowerMessage)) {
      return 'order_flow';
    }

    if (/\b(hi|hello|hey|good morning|good afternoon)\b/.test(lowerMessage)) {
      return 'greeting';
    }

    return 'general';
  }

  private detectStorefrontPaymentProvider(
    message: string,
  ): StorefrontPaymentProvider | null {
    const lowerMessage = message.toLowerCase();
    if (/\bpaystack\b/.test(lowerMessage)) return 'paystack';
    if (/\bozow\b/.test(lowerMessage)) return 'ozow';
    if (/\byoco\b/.test(lowerMessage)) return 'yoco';
    if (/\bpayfast\b/.test(lowerMessage)) return 'payfast';
    return null;
  }

  private composePaymentGatewayAnswer(
    provider: StorefrontPaymentProvider | null,
  ) {
    const providers = {
      paystack:
        'Paystack is supported as a payment gateway rail that merchants can connect in Stackaura.',
      ozow:
        'Ozow is supported as an instant EFT payment rail that merchants can connect in Stackaura.',
      yoco:
        'Yoco is supported as a card payment provider that merchants can connect in Stackaura.',
      payfast:
        'PayFast is supported as a South African payment gateway that merchants can connect in Stackaura.',
    } satisfies Record<StorefrontPaymentProvider, string>;

    if (provider) {
      return `${providers[provider]} Availability on this storefront depends on whether the merchant has enabled and configured ${this.formatPaymentProviderName(provider)} in their Stackaura dashboard.`;
    }

    return 'Stackaura supports multiple payment gateway rails merchants can connect and route through, including Paystack, Ozow, Yoco, and PayFast. Availability on this storefront depends on which providers the merchant has enabled in Stackaura.';
  }

  private composePaymentMethodAnswer(
    provider: StorefrontPaymentProvider | null,
  ) {
    if (provider) {
      return this.composePaymentGatewayAnswer(provider);
    }

    return 'Customer payment methods depend on the payment providers this merchant has configured in Stackaura. For example, card payments usually come through card-capable providers such as Yoco or Paystack, while instant EFT-style flows can be available through rails such as Ozow when enabled.';
  }

  private formatPaymentProviderName(provider: StorefrontPaymentProvider) {
    switch (provider) {
      case 'paystack':
        return 'Paystack';
      case 'ozow':
        return 'Ozow';
      case 'yoco':
        return 'Yoco';
      case 'payfast':
        return 'PayFast';
    }
  }

  private extractPathFromUrl(pageUrl: string | null) {
    if (!pageUrl) {
      return null;
    }

    try {
      const parsed = new URL(pageUrl);
      return `${parsed.pathname}${parsed.search}` || null;
    } catch {
      return pageUrl;
    }
  }

  private normalizeStorefrontPageUrl(value: unknown) {
    const normalized = this.normalizeOptionalString(value, 2000);
    if (!normalized) {
      return undefined;
    }

    try {
      const parsed = new URL(normalized);
      const transientParams = new Set([
        '_ab',
        '_fd',
        '_pos',
        '_sid',
        '_ss',
        '_s',
        '_shopify_d',
        '_shopify_sa_p',
        '_shopify_sa_t',
        '_shopify_s',
        '_shopify_y',
        '_y',
        'key',
        'oseid',
        'pb',
        'preview_theme_id',
        'section_id',
        'surface_detail',
        'surface_inter_position',
        'surface_intra_position',
        'surface_type',
        'utm_campaign',
        'utm_content',
        'utm_medium',
        'utm_source',
        'utm_term',
        'variant',
        'view',
      ]);

      for (const key of [...parsed.searchParams.keys()]) {
        if (transientParams.has(key) || key.startsWith('utm_')) {
          parsed.searchParams.delete(key);
        }
      }

      parsed.hash = '';
      return parsed.toString();
    } catch {
      const [withoutHash] = normalized.split('#');
      const [path, query] = withoutHash.split('?', 2);
      if (!query) {
        return path;
      }

      const params = new URLSearchParams(query);
      for (const key of [...params.keys()]) {
        if (
          key === 'oseid' ||
          key === 'preview_theme_id' ||
          key === 'section_id' ||
          key.startsWith('utm_') ||
          key.startsWith('_shopify')
        ) {
          params.delete(key);
        }
      }

      const cleanedQuery = params.toString();
      return cleanedQuery ? `${path}?${cleanedQuery}` : path;
    }
  }

  private normalizeSupportThemePreference(value: unknown) {
    const normalized =
      typeof value === 'string' ? value.trim().toLowerCase() : DEFAULT_SUPPORT_THEME;
    if (SUPPORT_THEME_PREFERENCES.includes(normalized as (typeof SUPPORT_THEME_PREFERENCES)[number])) {
      return normalized as (typeof SUPPORT_THEME_PREFERENCES)[number];
    }

    return DEFAULT_SUPPORT_THEME;
  }

  private normalizeSupportPositionPreference(value: unknown) {
    const normalized =
      typeof value === 'string'
        ? value.trim().toLowerCase()
        : DEFAULT_SUPPORT_POSITION;
    if (
      SUPPORT_POSITION_PREFERENCES.includes(
        normalized as (typeof SUPPORT_POSITION_PREFERENCES)[number],
      )
    ) {
      return normalized as (typeof SUPPORT_POSITION_PREFERENCES)[number];
    }

    return DEFAULT_SUPPORT_POSITION;
  }

  private normalizeOptionalString(value: unknown, maxLength: number) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.slice(0, maxLength);
  }

  private readBoolean(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') {
      return value;
    }

    return fallback;
  }

  private serializeWebhookTopics(
    webhooks: ShopifyWebhookRecord[] | undefined,
    callbackUrl: string,
  ) {
    return Array.from(
      new Set(
        (webhooks ?? [])
          .filter((webhook) => webhook.address === callbackUrl)
          .map((webhook) => webhook.topic.toLowerCase()),
      ),
    ).sort();
  }

  private parseScopes(scope: string | null | undefined) {
    if (!scope) {
      return this.resolveScopes();
    }

    return scope
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private async safeParseJson(response: Response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { message: text };
    }
  }

  private pickString(data: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = data[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  private resolveApiKey() {
    const value = process.env.SHOPIFY_API_KEY?.trim();
    if (!value) {
      throw new InternalServerErrorException('SHOPIFY_API_KEY is not configured');
    }
    return value;
  }

  private resolveApiSecret() {
    const value = process.env.SHOPIFY_API_SECRET?.trim();
    if (!value) {
      throw new InternalServerErrorException('SHOPIFY_API_SECRET is not configured');
    }
    return value;
  }

  private resolveAppUrl() {
    return process.env.SHOPIFY_APP_URL?.trim() ?? null;
  }

  private resolveScopes() {
    const raw = process.env.SHOPIFY_SCOPES?.trim();
    if (!raw) {
      return [...DEFAULT_SCOPES];
    }

    return raw
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
  }

  private resolveApiVersion() {
    return process.env.SHOPIFY_API_VERSION?.trim() || DEFAULT_API_VERSION;
  }

  private resolveWebhookCallbackUrl() {
    const appUrl = this.resolveAppUrl();
    if (!appUrl) {
      throw new InternalServerErrorException('SHOPIFY_APP_URL is not configured');
    }

    const webhookPath =
      process.env.SHOPIFY_WEBHOOK_PATH?.trim() || DEFAULT_WEBHOOK_PATH;

    return new URL(webhookPath, appUrl.endsWith('/') ? appUrl : `${appUrl}/`).toString();
  }

  private resolveWebhookTopics() {
    const includeProtectedTopics =
      process.env.SHOPIFY_ENABLE_PROTECTED_CUSTOMER_DATA_WEBHOOKS?.trim() ===
      'true';

    return includeProtectedTopics
      ? [...DEFAULT_WEBHOOK_TOPICS, ...PROTECTED_CUSTOMER_DATA_WEBHOOK_TOPICS]
      : [...DEFAULT_WEBHOOK_TOPICS];
  }

  private hasRequiredConfig() {
    return Boolean(
      process.env.SHOPIFY_API_KEY?.trim() &&
        process.env.SHOPIFY_API_SECRET?.trim() &&
        process.env.SHOPIFY_APP_URL?.trim(),
    );
  }

  private assertConfig() {
    this.resolveApiKey();
    this.resolveApiSecret();
  }
}
