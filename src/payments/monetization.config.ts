export const MERCHANT_PLAN_CODES = ['starter', 'growth', 'scale'] as const;

export type MerchantPlanCode = (typeof MERCHANT_PLAN_CODES)[number];

export type PlatformFeeRuleType =
  | 'NONE'
  | 'FIXED'
  | 'PERCENTAGE'
  | 'FIXED_PLUS_PERCENTAGE';

export type ResolvedPlatformFeePolicy = {
  fixedFeeCents: number;
  percentageBps: number;
  ruleType: PlatformFeeRuleType;
  source: 'platform_default' | 'merchant_plan' | 'merchant_override';
  merchantOverrideApplied: boolean;
};

export type PlatformFeeBreakdown = {
  platformFeeCents: number;
  merchantNetCents: number;
};

export type RoutingPlanFeatures = {
  planCode: MerchantPlanCode;
  manualGatewaySelection: boolean;
  autoRouting: boolean;
  fallback: boolean;
  source: 'platform_default' | 'merchant_plan';
};

export type ResolvedMerchantPlan = {
  code: MerchantPlanCode;
  source: 'merchant_assigned' | 'platform_default';
  feePolicy: ResolvedPlatformFeePolicy;
  routingFeatures: RoutingPlanFeatures;
};

type PlatformFeePolicySource = {
  merchantPlatformFeeBps?: number | null;
  merchantPlatformFeeFixedCents?: number | null;
};

type MerchantPlanResolverSource = PlatformFeePolicySource & {
  merchantPlanCode?: string | null;
};

type PlanFeatureSet = Omit<
  RoutingPlanFeatures,
  'planCode' | 'source'
>;

const BUILTIN_PLAN_FEATURES: Record<MerchantPlanCode, PlanFeatureSet> = {
  starter: {
    manualGatewaySelection: false,
    autoRouting: true,
    fallback: false,
  },
  growth: {
    manualGatewaySelection: true,
    autoRouting: true,
    fallback: true,
  },
  scale: {
    manualGatewaySelection: true,
    autoRouting: true,
    fallback: true,
  },
};

function parseBooleanEnv(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function parseIntegerEnv(value: string | undefined) {
  const parsed = Number(value?.trim());
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.trunc(parsed);
}

function hasEnvValue(value: string | undefined) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeFeeComponent(value: number | null | undefined) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value as number));
}

function resolveRuleType(args: {
  fixedFeeCents: number;
  percentageBps: number;
}): PlatformFeeRuleType {
  if (args.fixedFeeCents > 0 && args.percentageBps > 0) {
    return 'FIXED_PLUS_PERCENTAGE';
  }

  if (args.fixedFeeCents > 0) {
    return 'FIXED';
  }

  if (args.percentageBps > 0) {
    return 'PERCENTAGE';
  }

  return 'NONE';
}

export function normalizeMerchantPlanCode(
  value: string | null | undefined,
): MerchantPlanCode | null {
  const normalized =
    typeof value === 'string' && value.trim()
      ? value.trim().toLowerCase()
      : null;

  if (!normalized) {
    return null;
  }

  return MERCHANT_PLAN_CODES.includes(normalized as MerchantPlanCode)
    ? (normalized as MerchantPlanCode)
    : null;
}

export function resolveDefaultMerchantPlanCode() {
  return (
    normalizeMerchantPlanCode(process.env.STACKAURA_DEFAULT_MERCHANT_PLAN) ??
    normalizeMerchantPlanCode(process.env.STACKAURA_ROUTING_PLAN) ??
    'growth'
  );
}

function resolvePlatformDefaultFeePolicy(): ResolvedPlatformFeePolicy {
  const fixedFeeCents = normalizeFeeComponent(
    parseIntegerEnv(process.env.STACKAURA_PLATFORM_FEE_FIXED_CENTS),
  );
  const percentageBps = normalizeFeeComponent(
    parseIntegerEnv(process.env.STACKAURA_PLATFORM_FEE_BPS),
  );

  return {
    fixedFeeCents,
    percentageBps,
    ruleType: resolveRuleType({
      fixedFeeCents,
      percentageBps,
    }),
    source: 'platform_default',
    merchantOverrideApplied: false,
  };
}

function resolveMerchantOverrideFeePolicy(
  source: PlatformFeePolicySource,
): ResolvedPlatformFeePolicy | null {
  const fixedFeeCents = normalizeFeeComponent(source.merchantPlatformFeeFixedCents);
  const percentageBps = normalizeFeeComponent(source.merchantPlatformFeeBps);

  if (fixedFeeCents <= 0 && percentageBps <= 0) {
    return null;
  }

  return {
    fixedFeeCents,
    percentageBps,
    ruleType: resolveRuleType({
      fixedFeeCents,
      percentageBps,
    }),
    source: 'merchant_override',
    merchantOverrideApplied: true,
  };
}

function resolvePlanFeePolicy(
  planCode: MerchantPlanCode,
  fallback: ResolvedPlatformFeePolicy,
): ResolvedPlatformFeePolicy {
  const upperPlanCode = planCode.toUpperCase();
  const fixedEnvKey = `STACKAURA_PLAN_${upperPlanCode}_FEE_FIXED_CENTS`;
  const bpsEnvKey = `STACKAURA_PLAN_${upperPlanCode}_FEE_BPS`;
  const hasPlanFeeOverride =
    hasEnvValue(process.env[fixedEnvKey]) || hasEnvValue(process.env[bpsEnvKey]);

  if (!hasPlanFeeOverride) {
    return fallback;
  }

  const fixedFeeCents = normalizeFeeComponent(
    parseIntegerEnv(process.env[fixedEnvKey]),
  );
  const percentageBps = normalizeFeeComponent(
    parseIntegerEnv(process.env[bpsEnvKey]),
  );

  return {
    fixedFeeCents,
    percentageBps,
    ruleType: resolveRuleType({
      fixedFeeCents,
      percentageBps,
    }),
    source: 'merchant_plan',
    merchantOverrideApplied: false,
  };
}

export function resolvePlatformFeePolicy(
  source: PlatformFeePolicySource = {},
): ResolvedPlatformFeePolicy {
  return (
    resolveMerchantOverrideFeePolicy(source) ?? resolvePlatformDefaultFeePolicy()
  );
}

export function computePlatformFeeBreakdown(args: {
  amountCents: number;
  policy: ResolvedPlatformFeePolicy;
}): PlatformFeeBreakdown {
  const amountCents = Number.isFinite(args.amountCents)
    ? Math.max(0, Math.trunc(args.amountCents))
    : 0;
  const fixedFeeCents = normalizeFeeComponent(args.policy.fixedFeeCents);
  const percentageBps = normalizeFeeComponent(args.policy.percentageBps);
  const variableFeeCents = Math.round((amountCents * percentageBps) / 10000);
  const unclampedPlatformFeeCents = fixedFeeCents + variableFeeCents;
  const platformFeeCents = Math.max(
    0,
    Math.min(amountCents, unclampedPlatformFeeCents),
  );

  return {
    platformFeeCents,
    merchantNetCents: amountCents - platformFeeCents,
  };
}

export function resolveRoutingPlanFeatures(): RoutingPlanFeatures {
  const planCode = resolveDefaultMerchantPlanCode();

  return {
    planCode,
    manualGatewaySelection:
      parseBooleanEnv(process.env.STACKAURA_FEATURE_MANUAL_GATEWAY_SELECTION) ??
      true,
    autoRouting:
      parseBooleanEnv(process.env.STACKAURA_FEATURE_AUTO_ROUTING) ?? true,
    fallback:
      parseBooleanEnv(process.env.STACKAURA_FEATURE_FALLBACK) ?? true,
    source: 'platform_default',
  };
}

export function resolveMerchantPlan(
  source: MerchantPlanResolverSource = {},
): ResolvedMerchantPlan {
  const platformDefaultFeePolicy = resolvePlatformDefaultFeePolicy();
  const platformDefaultFeatures = resolveRoutingPlanFeatures();
  const merchantPlanCode = normalizeMerchantPlanCode(source.merchantPlanCode);
  const code = merchantPlanCode ?? platformDefaultFeatures.planCode;
  const merchantOverrideFeePolicy = resolveMerchantOverrideFeePolicy(source);

  const feePolicy =
    merchantOverrideFeePolicy ??
    resolvePlanFeePolicy(code, platformDefaultFeePolicy);
  const routingFeatures = merchantPlanCode
    ? {
        planCode: code,
        ...BUILTIN_PLAN_FEATURES[code],
        source: 'merchant_plan' as const,
      }
    : platformDefaultFeatures;

  return {
    code,
    source: merchantPlanCode ? 'merchant_assigned' : 'platform_default',
    feePolicy,
    routingFeatures,
  };
}
