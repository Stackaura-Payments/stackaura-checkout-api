import {
  computePlatformFeeBreakdown,
  resolveDefaultMerchantPlanCode,
  resolveMerchantPlan,
  resolvePlatformFeePolicy,
  resolveRoutingPlanFeatures,
} from './monetization.config';

describe('monetization.config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('applies platform default fixed fees', () => {
    process.env.STACKAURA_PLATFORM_FEE_FIXED_CENTS = '125';

    const policy = resolvePlatformFeePolicy();
    const fee = computePlatformFeeBreakdown({
      amountCents: 1000,
      policy,
    });

    expect(policy).toEqual(
      expect.objectContaining({
        fixedFeeCents: 125,
        percentageBps: 0,
        ruleType: 'FIXED',
        source: 'platform_default',
      }),
    );
    expect(fee).toEqual({
      platformFeeCents: 125,
      merchantNetCents: 875,
    });
  });

  it('applies platform default percentage fees', () => {
    process.env.STACKAURA_PLATFORM_FEE_BPS = '250';

    const policy = resolvePlatformFeePolicy();
    const fee = computePlatformFeeBreakdown({
      amountCents: 2000,
      policy,
    });

    expect(policy).toEqual(
      expect.objectContaining({
        fixedFeeCents: 0,
        percentageBps: 250,
        ruleType: 'PERCENTAGE',
        source: 'platform_default',
      }),
    );
    expect(fee).toEqual({
      platformFeeCents: 50,
      merchantNetCents: 1950,
    });
  });

  it('supports combined fees and merchant override precedence', () => {
    process.env.STACKAURA_PLATFORM_FEE_FIXED_CENTS = '80';
    process.env.STACKAURA_PLATFORM_FEE_BPS = '100';

    const plan = resolveMerchantPlan({
      merchantPlanCode: 'growth',
      merchantPlatformFeeFixedCents: 150,
      merchantPlatformFeeBps: 300,
    });
    const fee = computePlatformFeeBreakdown({
      amountCents: 10000,
      policy: plan.feePolicy,
    });

    expect(plan.feePolicy).toEqual(
      expect.objectContaining({
        fixedFeeCents: 150,
        percentageBps: 300,
        ruleType: 'FIXED_PLUS_PERCENTAGE',
        source: 'merchant_override',
        merchantOverrideApplied: true,
      }),
    );
    expect(fee).toEqual({
      platformFeeCents: 450,
      merchantNetCents: 9550,
    });
  });

  it('resolves starter plan feature access', () => {
    const plan = resolveMerchantPlan({ merchantPlanCode: 'starter' });

    expect(plan.routingFeatures).toEqual({
      planCode: 'starter',
      manualGatewaySelection: false,
      autoRouting: true,
      fallback: false,
      source: 'merchant_plan',
    });
  });

  it('resolves growth plan feature access', () => {
    const plan = resolveMerchantPlan({ merchantPlanCode: 'growth' });

    expect(plan.routingFeatures).toEqual({
      planCode: 'growth',
      manualGatewaySelection: true,
      autoRouting: true,
      fallback: true,
      source: 'merchant_plan',
    });
  });

  it('resolves scale plan feature access', () => {
    const plan = resolveMerchantPlan({ merchantPlanCode: 'scale' });

    expect(plan.routingFeatures).toEqual({
      planCode: 'scale',
      manualGatewaySelection: true,
      autoRouting: true,
      fallback: true,
      source: 'merchant_plan',
    });
  });

  it('allows plan fee settings to override platform defaults', () => {
    process.env.STACKAURA_PLATFORM_FEE_BPS = '100';
    process.env.STACKAURA_PLAN_SCALE_FEE_BPS = '25';

    const plan = resolveMerchantPlan({ merchantPlanCode: 'scale' });

    expect(plan.feePolicy).toEqual(
      expect.objectContaining({
        fixedFeeCents: 0,
        percentageBps: 25,
        ruleType: 'PERCENTAGE',
        source: 'merchant_plan',
        merchantOverrideApplied: false,
      }),
    );
  });

  it('falls back to platform defaults when merchant plan is missing', () => {
    process.env.STACKAURA_DEFAULT_MERCHANT_PLAN = 'growth';

    expect(resolveDefaultMerchantPlanCode()).toBe('growth');
    expect(resolveRoutingPlanFeatures()).toEqual({
      planCode: 'growth',
      manualGatewaySelection: true,
      autoRouting: true,
      fallback: true,
      source: 'platform_default',
    });
  });
});
