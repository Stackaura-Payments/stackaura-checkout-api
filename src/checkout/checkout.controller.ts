import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { GatewayRedirectForm } from '../gateways/gateway.types';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('checkout')
export class CheckoutController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Get('cancel')
  async cancel(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() res: Response,
  ) {
    return this.tryFailoverAndRedirect(query, res, 'cancel');
  }

  @Get('error')
  async error(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() res: Response,
  ) {
    return this.tryFailoverAndRedirect(query, res, 'error');
  }

  @Get('success')
  async success(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() res: Response,
  ) {
    const reference = this.extractPaymentReference(query);
    const context = await this.loadStatusPageContext(reference);
    const content = this.resolveStatusContent('success', context);

    return res
      .status(200)
      .type('html')
      .send(
        this.renderStatusPage({
          title: content.title,
          status: content.status,
          message: content.message,
          reference: context?.reference ?? reference,
          gateway: context?.gateway ?? null,
          tone: content.tone,
        }),
      );
  }

  @Get(':checkoutToken')
  async getCheckout(
    @Param('checkoutToken') checkoutToken: string,
    @Res() res: Response,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        checkoutToken,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        amountCents: true,
        currency: true,
        status: true,
        description: true,
        customerEmail: true,
        expiresAt: true,
        gateway: true,
        rawGateway: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Checkout session not found or expired');
    }

    const merchant = await this.prisma.merchant.findUnique({
      where: { id: payment.merchantId },
      select: { name: true },
    });

    const latestAttempt = await this.prisma.paymentAttempt.findFirst({
      where: { paymentId: payment.id },
      orderBy: { createdAt: 'desc' },
      select: {
        redirectUrl: true,
        gateway: true,
      },
    });

    return res
      .status(200)
      .type('html')
      .send(
        this.renderCheckoutPage({
          merchantName: merchant?.name ?? 'Merchant',
          reference: payment.reference,
          amountCents: payment.amountCents,
          currency: payment.currency,
          status: payment.status,
          description: payment.description,
          customerEmail: payment.customerEmail,
          expiresAt: payment.expiresAt,
          gateway: latestAttempt?.gateway ?? payment.gateway ?? null,
          ...this.resolveRedirectState(
            payment.rawGateway,
            latestAttempt?.redirectUrl ?? null,
          ),
        }),
      );
  }

  private parseRedirectForm(value: unknown): GatewayRedirectForm | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const action =
      typeof record.action === 'string' && record.action.trim()
        ? record.action.trim()
        : null;
    const method =
      typeof record.method === 'string' && record.method.trim().toUpperCase() === 'POST'
        ? 'POST'
        : null;
    const fields =
      record.fields && typeof record.fields === 'object' && !Array.isArray(record.fields)
        ? (record.fields as Record<string, unknown>)
        : null;

    if (!action || !method || !fields) {
      return null;
    }

    const normalizedFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string') {
        normalizedFields[key] = value;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        normalizedFields[key] = String(value);
      }
    }

    return {
      action,
      method,
      fields: normalizedFields,
    };
  }

  private resolveRedirectState(rawGateway: unknown, fallbackRedirectUrl: string | null) {
    const root =
      rawGateway && typeof rawGateway === 'object' && !Array.isArray(rawGateway)
        ? (rawGateway as Record<string, unknown>)
        : null;
    const request =
      root?.request && typeof root.request === 'object' && !Array.isArray(root.request)
        ? (root.request as Record<string, unknown>)
        : root;
    const redirectForm = this.parseRedirectForm(
      request?.redirectForm ?? root?.redirectForm,
    );
    const redirectUrl =
      (typeof request?.redirectUrl === 'string' && request.redirectUrl.trim()) ||
      redirectForm?.action ||
      fallbackRedirectUrl;

    return {
      redirectUrl: redirectUrl ?? null,
      redirectForm,
    };
  }

  private async tryFailoverAndRedirect(
    query: Record<string, string | string[] | undefined>,
    res: Response,
    route: 'cancel' | 'error',
  ) {
    const reference = this.extractPaymentReference(query);
    const context = await this.loadStatusPageContext(reference);
    const content = this.resolveStatusContent(route, context);

    if (!reference) {
      return res
        .status(200)
        .type('html')
        .send(
          this.renderStatusPage({
            title: content.title,
            status: content.status,
            message: content.message,
            reference: null,
            gateway: null,
            tone: content.tone,
          }),
        );
    }

    const failover =
      await this.paymentsService.autoFailoverByReference(reference);

    if (failover?.redirectUrl) {
      return res.redirect(302, failover.redirectUrl);
    }

    return res
      .status(200)
      .type('html')
      .send(
        this.renderStatusPage({
          title: content.title,
          status: content.status,
          message: content.message,
          reference: context?.reference ?? reference,
          gateway: context?.gateway ?? null,
          tone: content.tone,
        }),
      );
  }

  private async loadStatusPageContext(reference: string | null) {
    const normalizedReference = reference?.trim();
    if (!normalizedReference) {
      return null;
    }

    const payment = await this.prisma.payment.findFirst({
      where: { reference: normalizedReference },
      select: {
        reference: true,
        gateway: true,
        rawGateway: true,
      },
    });

    if (!payment) {
      return null;
    }

    const rawGateway = this.asRecord(payment.rawGateway);
    const publicFlow = this.asRecord(rawGateway?.publicFlow);

    return {
      reference: payment.reference,
      gateway:
        typeof payment.gateway === 'string' && payment.gateway.trim()
          ? payment.gateway.trim()
          : null,
      isSignupFlow: publicFlow?.flow === 'merchant_signup',
    };
  }

  private resolveStatusContent(
    route: 'success' | 'cancel' | 'error',
    context: { isSignupFlow: boolean } | null,
  ) {
    if (context?.isSignupFlow) {
      if (route === 'success') {
        return {
          title: 'Merchant activation successful',
          status: 'SUCCESS',
          message:
            'Your activation payment was completed successfully. Your merchant account can now be activated.',
          tone: 'success' as const,
        };
      }

      if (route === 'cancel') {
        return {
          title: 'Merchant activation cancelled',
          status: 'CANCELLED',
          message:
            'The merchant activation payment was cancelled before completion.',
          tone: 'warning' as const,
        };
      }

      return {
        title: 'Merchant activation failed',
        status: 'ERROR',
        message: 'We couldn’t complete the merchant activation payment.',
        tone: 'error' as const,
      };
    }

    if (route === 'success') {
      return {
        title: 'Payment successful',
        status: 'SUCCESS',
        message: 'Your payment was completed successfully.',
        tone: 'success' as const,
      };
    }

    if (route === 'cancel') {
      return {
        title: 'Payment cancelled',
        status: 'CANCELLED',
        message: 'The payment was cancelled before completion.',
        tone: 'warning' as const,
      };
    }

    return {
      title: 'Payment failed',
      status: 'ERROR',
      message: 'We couldn’t complete the payment.',
      tone: 'error' as const,
    };
  }

  private renderCheckoutPage(args: {
    merchantName: string;
    reference: string;
    amountCents: number;
    currency: string;
    status: string;
    description: string | null;
    customerEmail: string | null;
    expiresAt: Date;
    gateway: string | null;
    redirectUrl: string | null;
    redirectForm: GatewayRedirectForm | null;
  }) {
    const amount = this.formatMoney(args.amountCents, args.currency);
    const expiresAt = new Date(args.expiresAt).toLocaleString();
    const expiresAtIso = new Date(args.expiresAt).toISOString();
    const description =
      args.description ?? 'Secure payment powered by Stackaura.';
    const customer = args.customerEmail ?? 'Not provided';
    const gateway = args.gateway ?? 'STACKAURA';
    const gatewayLabel = this.formatDisplayToken(gateway);
    const statusLabel = this.formatDisplayToken(args.status);
    const cta = args.redirectForm
      ? this.renderRedirectForm(args.redirectForm, gatewayLabel)
      : args.redirectUrl
        ? `<a class="cta" href="${this.escapeHtml(args.redirectUrl)}">Continue to ${this.escapeHtml(gatewayLabel)}</a>`
        : `<div class="muted-box">Gateway redirect is being prepared by Stackaura. Refresh this page in a moment if the payment link does not appear yet.</div>`;

    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Stackaura Checkout</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #edf3ff;
        --bg-deep: #dfe9fb;
        --panel: rgba(255, 255, 255, 0.76);
        --panel-strong: rgba(255, 255, 255, 0.92);
        --border: rgba(93, 120, 167, 0.18);
        --shadow: 0 28px 80px rgba(43, 69, 120, 0.14);
        --text: #10203b;
        --muted: #5b6a87;
        --subtle: #7b8aa7;
        --accent: #1e4ed8;
        --accent-strong: #143fb9;
        --accent-soft: rgba(30, 78, 216, 0.1);
        --accent-warm: #e9a65f;
        --success: #1f8f63;
        --pill-bg: rgba(255, 255, 255, 0.7);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(77, 139, 255, 0.22), transparent 34%),
          radial-gradient(circle at top right, rgba(233, 166, 95, 0.18), transparent 32%),
          linear-gradient(180deg, #f8fbff 0%, var(--bg) 54%, var(--bg-deep) 100%);
        color: var(--text);
        font-family: "Satoshi", "Avenir Next", "Segoe UI", sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 28px;
        position: relative;
        overflow-x: hidden;
      }
      body::before,
      body::after {
        content: "";
        position: fixed;
        border-radius: 999px;
        pointer-events: none;
        filter: blur(22px);
        z-index: 0;
      }
      body::before {
        width: 280px;
        height: 280px;
        background: rgba(74, 137, 255, 0.14);
        top: 48px;
        left: max(16px, calc(50% - 620px));
      }
      body::after {
        width: 220px;
        height: 220px;
        background: rgba(233, 166, 95, 0.14);
        bottom: 64px;
        right: max(16px, calc(50% - 560px));
      }
      .shell {
        position: relative;
        z-index: 1;
        width: 100%;
        max-width: 1120px;
        display: grid;
        gap: 22px;
      }
      .brand {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 4px 4px 0;
      }
      .brand-lockup {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .logo {
        width: 58px;
        height: 58px;
        border-radius: 18px;
        background:
          linear-gradient(145deg, rgba(255,255,255,0.94), rgba(225,236,255,0.88));
        color: var(--accent-strong);
        display: grid;
        place-items: center;
        font-size: 26px;
        font-weight: 700;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.9),
          0 20px 40px rgba(43, 69, 120, 0.12);
      }
      .brand-copy {
        display: grid;
        gap: 6px;
      }
      .brand-kicker {
        color: var(--accent-strong);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .brand-copy h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.06;
        letter-spacing: -0.03em;
      }
      .brand-copy p {
        margin: 0;
        color: var(--muted);
        max-width: 520px;
        line-height: 1.55;
      }
      .trust-rail {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.66);
        border: 1px solid rgba(93, 120, 167, 0.16);
        box-shadow: 0 12px 32px rgba(43, 69, 120, 0.08);
        color: var(--muted);
        font-size: 13px;
        font-weight: 600;
      }
      .trust-rail strong {
        color: var(--text);
      }
      .grid {
        display: grid;
        gap: 22px;
        grid-template-columns: minmax(0, 1.12fr) minmax(320px, 0.88fr);
      }
      .card {
        border: 1px solid var(--border);
        background: var(--panel);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        border-radius: 30px;
        padding: 28px;
        box-shadow: var(--shadow);
        position: relative;
        overflow: hidden;
      }
      .card::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(160deg, rgba(255,255,255,0.4), transparent 34%);
      }
      .eyebrow {
        color: var(--accent-strong);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        font-weight: 700;
      }
      .amount {
        margin-top: 18px;
        font-size: 54px;
        font-weight: 700;
        line-height: 0.98;
        letter-spacing: -0.05em;
      }
      .summary-topline {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
      }
      .summary-accent {
        min-width: 92px;
        padding: 12px 14px;
        border-radius: 22px;
        background: linear-gradient(180deg, rgba(30, 78, 216, 0.12), rgba(30, 78, 216, 0.04));
        border: 1px solid rgba(30, 78, 216, 0.14);
      }
      .summary-accent-label {
        color: var(--subtle);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }
      .summary-accent-value {
        margin-top: 6px;
        color: var(--text);
        font-size: 15px;
        font-weight: 700;
      }
      .description {
        margin-top: 14px;
        color: var(--muted);
        line-height: 1.65;
        max-width: 58ch;
      }
      .pill-row {
        margin-top: 22px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid rgba(93, 120, 167, 0.16);
        border-radius: 999px;
        padding: 10px 14px;
        color: var(--subtle);
        background: var(--pill-bg);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.65);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 700;
      }
      .badge strong {
        color: var(--text);
        font-weight: 700;
      }
      .badge-gateway {
        background: rgba(255,255,255,0.82);
      }
      .badge-status {
        background: rgba(30, 78, 216, 0.08);
        border-color: rgba(30, 78, 216, 0.12);
      }
      .list {
        margin-top: 24px;
        display: grid;
        gap: 12px;
      }
      .row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        border: 1px solid rgba(93, 120, 167, 0.14);
        background: rgba(255, 255, 255, 0.52);
        border-radius: 20px;
        padding: 16px 18px;
        color: var(--muted);
      }
      .row strong {
        color: var(--text);
        text-align: right;
        max-width: 60%;
        line-height: 1.45;
      }
      .row span {
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 700;
        color: var(--subtle);
      }
      .cta {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        min-height: 60px;
        border: none;
        border-radius: 20px;
        background: linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%);
        color: #ffffff;
        font-weight: 700;
        letter-spacing: -0.01em;
        text-decoration: none;
        box-shadow:
          0 20px 34px rgba(30, 78, 216, 0.24),
          inset 0 1px 0 rgba(255,255,255,0.28);
        transition: transform 140ms ease, box-shadow 140ms ease;
        cursor: pointer;
      }
      .cta:hover {
        transform: translateY(-1px);
        box-shadow:
          0 24px 40px rgba(30, 78, 216, 0.28),
          inset 0 1px 0 rgba(255,255,255,0.28);
      }
      .muted-box {
        border: 1px dashed rgba(93, 120, 167, 0.24);
        border-radius: 20px;
        padding: 16px 18px;
        background: rgba(255,255,255,0.5);
        color: var(--muted);
        line-height: 1.6;
      }
      .stack {
        display: grid;
        gap: 18px;
      }
      .aside-title {
        margin: 10px 0 0;
        font-size: 28px;
        line-height: 1.08;
        letter-spacing: -0.04em;
      }
      .aside-copy {
        margin: 0;
        color: var(--muted);
        line-height: 1.65;
      }
      .countdown {
        padding: 20px;
        border-radius: 24px;
        border: 1px solid rgba(30, 78, 216, 0.14);
        background:
          linear-gradient(155deg, rgba(255,255,255,0.76), rgba(242,247,255,0.92));
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.84);
      }
      .countdown-label {
        color: var(--subtle);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-weight: 700;
      }
      .countdown-value {
        margin-top: 10px;
        font-size: 38px;
        font-weight: 700;
        letter-spacing: -0.05em;
      }
      .countdown-sub {
        margin-top: 6px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }
      .trust-copy {
        margin: 0;
        color: var(--muted);
        line-height: 1.65;
      }
      .trust-copy strong {
        color: var(--text);
      }
      .support-panel {
        display: grid;
        gap: 10px;
        padding: 18px;
        border-radius: 22px;
        background: rgba(255,255,255,0.56);
        border: 1px solid rgba(93, 120, 167, 0.14);
      }
      .support-title {
        color: var(--text);
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .support-row {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        color: var(--muted);
      }
      .support-row strong {
        color: var(--text);
        text-align: right;
        max-width: 56%;
      }
      .hero-note {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        width: fit-content;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(255,255,255,0.68);
        border: 1px solid rgba(93, 120, 167, 0.14);
        color: var(--muted);
        font-size: 13px;
        font-weight: 600;
      }
      .hero-note .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--success);
        box-shadow: 0 0 0 6px rgba(31, 143, 99, 0.12);
      }
      @media (max-width: 820px) {
        body {
          padding: 18px;
        }
        .brand {
          align-items: flex-start;
          flex-direction: column;
        }
        .grid {
          grid-template-columns: 1fr;
        }
        .card {
          padding: 22px;
          border-radius: 24px;
        }
        .amount {
          font-size: 42px;
        }
        .summary-topline {
          flex-direction: column;
        }
        .summary-accent {
          width: 100%;
        }
        .row,
        .support-row {
          flex-direction: column;
        }
        .row strong,
        .support-row strong {
          max-width: 100%;
          text-align: left;
        }
        .aside-title {
          font-size: 24px;
        }
        .countdown-value {
          font-size: 34px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="brand">
        <div class="brand-lockup">
          <div class="logo">S</div>
          <div class="brand-copy">
            <div class="brand-kicker">Stackaura Checkout</div>
            <h1>Secure merchant payment handoff</h1>
            <p>Premium payment infrastructure with clear merchant context, strong trust signals, and a streamlined gateway handoff.</p>
          </div>
        </div>
        <div class="trust-rail">Protected by <strong>Stackaura infrastructure</strong></div>
      </div>

      <div class="grid">
        <section class="card">
          <div class="hero-note"><span class="dot"></span>Ready to continue securely</div>
          <div class="summary-topline">
            <div>
              <div class="eyebrow">Paying ${this.escapeHtml(args.merchantName)}</div>
              <div class="amount">${this.escapeHtml(amount)}</div>
            </div>
            <div class="summary-accent">
              <div class="summary-accent-label">Reference</div>
              <div class="summary-accent-value">${this.escapeHtml(args.reference)}</div>
            </div>
          </div>
          <div class="description">${this.escapeHtml(description)}</div>
          <div class="pill-row">
            <div class="badge badge-gateway">Gateway <strong>${this.escapeHtml(gatewayLabel)}</strong></div>
            <div class="badge badge-status">Status <strong>${this.escapeHtml(statusLabel)}</strong></div>
          </div>

          <div class="list">
            <div class="row">
              <span>Reference</span>
              <strong>${this.escapeHtml(args.reference)}</strong>
            </div>
            <div class="row">
              <span>Merchant</span>
              <strong>${this.escapeHtml(args.merchantName)}</strong>
            </div>
            <div class="row">
              <span>Customer</span>
              <strong>${this.escapeHtml(customer)}</strong>
            </div>
            <div class="row">
              <span>Expires</span>
              <strong>${this.escapeHtml(expiresAt)}</strong>
            </div>
          </div>
        </section>

        <aside class="card stack">
          <div>
            <div class="eyebrow">Next step</div>
            <h2 class="aside-title">Continue to ${this.escapeHtml(gatewayLabel)}</h2>
            <p class="aside-copy">Your payment details are locked in. Continue to the selected gateway to authorize and complete checkout.</p>
          </div>
          <div class="countdown">
            <div class="countdown-label">Checkout expires in</div>
            <div class="countdown-value" id="countdown">--:--</div>
            <div class="countdown-sub">Expires at ${this.escapeHtml(expiresAt)}</div>
          </div>
          ${cta}
          <p class="trust-copy">
            By continuing, you’ll be redirected to the selected gateway through <strong>Stackaura’s secure payment infrastructure</strong>.
          </p>
          <div class="support-panel">
            <div class="support-title">Checkout summary</div>
            <div class="support-row">
              <span>Gateway</span>
              <strong>${this.escapeHtml(gatewayLabel)}</strong>
            </div>
            <div class="support-row">
              <span>Status</span>
              <strong>${this.escapeHtml(statusLabel)}</strong>
            </div>
            <div class="support-row">
              <span>Customer</span>
              <strong>${this.escapeHtml(customer)}</strong>
            </div>
          </div>
        </aside>
      </div>
    </div>
    <script>
      (function () {
        const expiresAt = new Date(${JSON.stringify(expiresAtIso)}).getTime();
        const el = document.getElementById('countdown');
        if (!el) return;

        function render() {
          const remaining = Math.max(0, expiresAt - Date.now());
          const totalSeconds = Math.floor(remaining / 1000);
          const minutes = Math.floor(totalSeconds / 60);
          const seconds = totalSeconds % 60;
          el.textContent = \`\${String(minutes).padStart(2, '0')}:\${String(seconds).padStart(2, '0')}\`;
        }

        render();
        const timer = setInterval(() => {
          render();
          if (Date.now() >= expiresAt) {
            clearInterval(timer);
          }
        }, 1000);
      })();
    </script>
  </body>
</html>`;
  }

  private renderRedirectForm(
    redirectForm: GatewayRedirectForm,
    gateway: string,
  ) {
    const hiddenInputs = Object.entries(redirectForm.fields)
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${this.escapeHtml(key)}" value="${this.escapeHtml(value)}" />`,
      )
      .join('');

    return `
<form id="gateway-form" method="${this.escapeHtml(redirectForm.method)}" action="${this.escapeHtml(redirectForm.action)}">
  ${hiddenInputs}
  <button class="cta" type="submit">Continue to ${this.escapeHtml(gateway)}</button>
</form>
<script>
  (function () {
    const form = document.getElementById('gateway-form');
    if (form) {
      form.submit();
    }
  })();
</script>`;
  }

  private renderStatusPage(args: {
    title: string;
    status: string;
    message: string;
    reference: string | null;
    gateway: string | null;
    tone: 'success' | 'warning' | 'error';
  }) {
    const accent =
      args.tone === 'success'
        ? '#1f9d55'
        : args.tone === 'warning'
          ? '#d97706'
          : '#dc2626';

    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${this.escapeHtml(args.title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        background: #050505;
        color: #f5f5f7;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: 100%;
        max-width: 640px;
        border-radius: 24px;
        border: 1px solid #202027;
        background: #0d0d0f;
        padding: 28px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        border: 1px solid ${accent};
        color: ${accent};
      }
      h1 {
        margin: 16px 0 10px;
        font-size: 32px;
      }
      p {
        margin: 0;
        color: #b4b4be;
        line-height: 1.6;
      }
      .meta {
        margin-top: 18px;
        border-top: 1px solid #202027;
        padding-top: 18px;
        color: #d8d8de;
      }
      .meta strong {
        color: #fff;
      }
    </style>
  </head>
  <body>
    <section class="card">
      <div class="badge">${this.escapeHtml(args.status)}</div>
      <h1>${this.escapeHtml(args.title)}</h1>
      <p>${this.escapeHtml(args.message)}</p>
      <div class="meta">
        <div><strong>Powered by:</strong> Stackaura Checkout</div>
        <div style="margin-top:8px;"><strong>Reference:</strong> ${this.escapeHtml(args.reference ?? 'Unavailable')}</div>
        ${args.gateway ? `<div style="margin-top:8px;"><strong>Gateway:</strong> ${this.escapeHtml(args.gateway)}</div>` : ''}
      </div>
    </section>
  </body>
</html>`;
  }

  private formatMoney(amountCents: number, currency: string) {
    return `${currency} ${(amountCents / 100).toFixed(2)}`;
  }

  private formatDisplayToken(value: string) {
    return value
      .trim()
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private asRecord(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private extractPaymentReference(
    query: Record<string, string | string[] | undefined>,
  ) {
    const pick = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;

    const candidates = [
      pick(query.reference),
      pick(query.m_payment_id),
      pick(query.payment_id),
      pick(query.TransactionReference),
      pick(query.transactionReference),
      pick(query.transaction_reference),
    ];

    for (const value of candidates) {
      const normalized = value?.trim();
      if (normalized) return normalized;
    }

    return null;
  }
}
