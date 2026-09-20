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
  escalationOffered?: boolean;
  supportEmail?: string | null;
};

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

    const reply = this.composeStorefrontSupportReply({
      message: normalized.message,
      pageUrl: normalized.pageUrl ?? null,
      supportAgent,
    });

    await this.persistStorefrontSupportConversation({
      shopDomain: normalized.shop,
      sessionId: normalized.sessionId,
      userMessage: normalized.message,
      assistantMessage: reply,
      pageUrl: normalized.pageUrl ?? null,
      escalationOffered:
        supportAgent.escalationEnabled && Boolean(supportAgent.supportEmail),
      supportEmailShown: Boolean(supportAgent.supportEmail),
    });

    return {
      ok: true,
      reply,
      sessionId: normalized.sessionId,
      escalationOffered:
        supportAgent.escalationEnabled && Boolean(supportAgent.supportEmail),
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
        },
      ],
    });
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

    const pageUrl = this.normalizeOptionalString(payload.pageUrl, 2000) ?? undefined;

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
      pageUrl: this.normalizeOptionalString(payload.pageUrl, 2000) ?? undefined,
      userAgent:
        this.normalizeOptionalString(payload.userAgent, 500) ?? undefined,
    };
  }

  private composeStorefrontSupportReply(args: {
    message: string;
    pageUrl: string | null;
    supportAgent: ReturnType<ShopifyService['serializeSupportAgentConfig']>;
  }) {
    const lowerMessage = args.message.toLowerCase();
    const messageLooksLikeGreeting =
      /\b(hi|hello|hey|good morning|good afternoon)\b/.test(lowerMessage);
    const mentionsOrderFlow =
      /\b(order|shipping|delivery|refund|return|cancel)\b/.test(lowerMessage);
    const mentionsPayments =
      /\b(payment|checkout|card|bank|pay|transaction)\b/.test(lowerMessage);
    const pagePath = this.extractPathFromUrl(args.pageUrl);

    const replyParts: string[] = [];

    if (messageLooksLikeGreeting) {
      replyParts.push(
        'Hi there. Thanks for reaching out to Stackaura Support on this storefront.',
      );
    } else {
      replyParts.push(
        'Thanks for your message. This storefront support widget is now live for lightweight help and routing.',
      );
    }

    if (mentionsOrderFlow) {
      replyParts.push(
        'This first conversation runtime cannot securely look up orders or customer records yet, so we cannot confirm order-specific details from the widget today.',
      );
    } else if (mentionsPayments) {
      replyParts.push(
        'We can help route checkout or payment questions, but this first release does not yet perform live payment or order lookups from the storefront widget.',
      );
    } else {
      replyParts.push(
        'A fuller AI support experience comes next, but we can already capture your question here and guide you to the right human contact when needed.',
      );
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
