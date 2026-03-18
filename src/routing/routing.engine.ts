import { BadRequestException, Injectable } from '@nestjs/common';
import { GatewayProvider, Prisma } from '@prisma/client';
import { resolveOzowConfig } from '../gateways/ozow.config';

export type RoutingMode = 'STRICT_PRIORITY' | 'FAILOVER_PRIORITY';

export type RoutingCandidate = {
  gateway: GatewayProvider;
  priority: number;
  reason: string[];
};

export type RoutingDecision = {
  mode: RoutingMode;
  selectedGateway: GatewayProvider;
  rankedGateways: RoutingCandidate[];
};

type MerchantGatewayConfig = {
  gatewayOrder?: Prisma.JsonValue | null;
  payfastMerchantId?: string | null;
  payfastMerchantKey?: string | null;
  ozowSiteCode?: string | null;
  ozowPrivateKey?: string | null;
  yocoPublicKey?: string | null;
  yocoSecretKey?: string | null;
};

@Injectable()
export class RoutingEngine {
  private readonly defaultOrder: GatewayProvider[] = [
    GatewayProvider.OZOW,
    GatewayProvider.PAYFAST,
  ];

  decide(args: {
    requestedGateway: GatewayProvider | 'AUTO' | null;
    merchant: MerchantGatewayConfig;
    excludedGateways?: GatewayProvider[];
    mode: RoutingMode;
  }): RoutingDecision {
    if (
      args.requestedGateway &&
      args.requestedGateway !== 'AUTO'
    ) {
      const excluded = new Set(args.excludedGateways ?? []);
      if (excluded.has(args.requestedGateway)) {
        throw new BadRequestException(
          `Gateway ${args.requestedGateway} is not available for this merchant`,
        );
      }

      if (!this.isConfigured(args.requestedGateway, args.merchant)) {
        throw new BadRequestException(
          `Gateway ${args.requestedGateway} is not available for this merchant`,
        );
      }

      return {
        mode: args.mode,
        selectedGateway: args.requestedGateway,
        rankedGateways: [
          {
            gateway: args.requestedGateway,
            priority: 1,
            reason: ['explicit_gateway_request'],
          },
        ],
      };
    }

    const eligible = this.buildEligibleGateways(args.merchant, args.excludedGateways);

    if (!eligible.length) {
      throw new BadRequestException('No configured gateways available for merchant');
    }

    return {
      mode: args.mode,
      selectedGateway: eligible[0].gateway,
      rankedGateways: eligible,
    };
  }

  private buildEligibleGateways(
    merchant: MerchantGatewayConfig,
    excludedGateways?: GatewayProvider[],
  ): RoutingCandidate[] {
    const excluded = new Set(excludedGateways ?? []);
    const parsedOrder = Array.isArray(merchant.gatewayOrder)
  ? merchant.gatewayOrder.filter(
      (item): item is GatewayProvider =>
        typeof item === 'string' &&
        Object.values(GatewayProvider).includes(item as GatewayProvider),
    )
  : [];

const order = parsedOrder.length ? parsedOrder : this.defaultOrder;

    return order
      .filter((gateway) => !excluded.has(gateway))
      .filter((gateway) => this.isConfigured(gateway, merchant))
      .map((gateway, index) => ({
        gateway,
        priority: index + 1,
        reason: [`priority=${index + 1}`],
      }));
  }

  private isConfigured(
    gateway: GatewayProvider,
    merchant: MerchantGatewayConfig,
  ): boolean {
    switch (gateway) {
      case GatewayProvider.PAYFAST:
        return !!merchant.payfastMerchantId && !!merchant.payfastMerchantKey;
      case GatewayProvider.OZOW: {
        const config = resolveOzowConfig({
          ozowSiteCode: merchant.ozowSiteCode ?? null,
          ozowPrivateKey: merchant.ozowPrivateKey ?? null,
        });
        return Boolean(config.siteCode && config.privateKey);
      }
      case GatewayProvider.YOCO:
        return !!merchant.yocoPublicKey && !!merchant.yocoSecretKey;
      default:
        return false;
    }
  }
}
