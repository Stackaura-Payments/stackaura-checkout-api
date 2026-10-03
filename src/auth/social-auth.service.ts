import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

export type SocialProvider = 'google' | 'apple';
export function socialProvider(value: string): SocialProvider {
  if (value !== 'google' && value !== 'apple')
    throw new BadRequestException('Unsupported provider');
  return value;
}
export function dashboardDestination(value?: string) {
  if (!value || !/^\/dashboard(?:\/[A-Za-z0-9_-]+)*\/?$/.test(value))
    return '/dashboard';
  return value;
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class SocialAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  private callback(provider: SocialProvider) {
    const raw = process.env.SOCIAL_AUTH_CALLBACK_BASE_URL?.trim();
    if (!raw)
      throw new ServiceUnavailableException('Social sign-in is not configured');
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new ServiceUnavailableException('Invalid callback configuration');
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (
      url.protocol !== 'https:' &&
      !(
        provider === 'google' &&
        local &&
        process.env.NODE_ENV !== 'production' &&
        url.protocol === 'http:'
      )
    ) {
      throw new ServiceUnavailableException('Social sign-in requires HTTPS');
    }
    return `${url.origin}/api/auth/oauth/${provider}/callback`;
  }

  providerStatus() {
    if (!this.rolloutEnabled()) return { google: false, apple: false };
    const configured = (provider: SocialProvider) => {
      try {
        this.callback(provider);
      } catch {
        return false;
      }
      const keys =
        provider === 'google'
          ? ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
          : [
              'APPLE_CLIENT_ID',
              'APPLE_TEAM_ID',
              'APPLE_KEY_ID',
              'APPLE_PRIVATE_KEY',
            ];
      return ['SESSION_SECRET', ...keys].every((key) =>
        Boolean(process.env[key]?.trim()),
      );
    };
    return { google: configured('google'), apple: configured('apple') };
  }

  private rolloutEnabled() {
    return (
      process.env.NODE_ENV !== 'production' ||
      process.env.SOCIAL_AUTH_ENABLED === 'true'
    );
  }

  private async configuration(provider: SocialProvider) {
    if (!this.providerStatus()[provider])
      throw new ServiceUnavailableException('Social sign-in is not configured');
    const client = await import('openid-client');
    let secret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
    if (provider === 'apple') {
      const jose = await import('jose');
      const key = await jose.importPKCS8(
        process.env.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
        'ES256',
      );
      secret = await new jose.SignJWT({})
        .setProtectedHeader({
          alg: 'ES256',
          kid: process.env.APPLE_KEY_ID!.trim(),
        })
        .setIssuer(process.env.APPLE_TEAM_ID!.trim())
        .setSubject(process.env.APPLE_CLIENT_ID!.trim())
        .setAudience('https://appleid.apple.com')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(key);
    }
    const config = await client.discovery(
      new URL(
        provider === 'google'
          ? 'https://accounts.google.com'
          : 'https://appleid.apple.com',
      ),
      process.env[
        provider === 'google' ? 'GOOGLE_CLIENT_ID' : 'APPLE_CLIENT_ID'
      ]!.trim(),
      secret,
      client.ClientSecretPost(secret),
      { timeout: 10 },
    );
    client.enableNonRepudiationChecks(config);
    return { client, config };
  }

  async start(provider: SocialProvider, next?: string) {
    const { client, config } = await this.configuration(provider);
    const state = randomBytes(32).toString('base64url');
    const bindingToken = randomBytes(32).toString('base64url');
    const nonce = client.randomNonce();
    const verifier =
      provider === 'google' ? client.randomPKCECodeVerifier() : '';
    const parameters: Record<string, string> = {
      redirect_uri: this.callback(provider),
      scope: provider === 'google' ? 'openid email' : 'email',
      state,
      nonce,
    };
    if (provider === 'google') {
      parameters.code_challenge =
        await client.calculatePKCECodeChallenge(verifier);
      parameters.code_challenge_method = 'S256';
      parameters.prompt = 'select_account';
    } else parameters.response_mode = 'form_post';
    await this.prisma.oAuthAttempt.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await this.prisma.oAuthAttempt.create({
      data: {
        stateHash: hash(state),
        provider,
        bindingHash: hash(bindingToken),
        nonce,
        verifier,
        nextPath: dashboardDestination(next),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return {
      authorizationUrl: client.buildAuthorizationUrl(config, parameters).href,
      bindingToken,
    };
  }

  async complete(
    provider: SocialProvider,
    body: {
      state?: string;
      code?: string;
      bindingToken?: string;
      iss?: string;
    },
  ) {
    if (!this.rolloutEnabled())
      throw new ServiceUnavailableException('Social sign-in is not enabled');
    if (
      typeof body.state !== 'string' ||
      typeof body.code !== 'string' ||
      typeof body.bindingToken !== 'string' ||
      body.state.length > 256 ||
      body.code.length > 4096 ||
      body.bindingToken.length > 256 ||
      (body.iss !== undefined &&
        (typeof body.iss !== 'string' || body.iss.length > 2048))
    ) {
      throw new UnauthorizedException('Invalid sign-in response');
    }
    const stateHash = hash(body.state);
    const attempt = await this.prisma.oAuthAttempt.findUnique({
      where: { stateHash },
    });
    const bindingHash = hash(body.bindingToken);
    if (
      !attempt ||
      attempt.provider !== provider ||
      attempt.expiresAt <= new Date() ||
      !timingSafeEqual(
        Buffer.from(attempt.bindingHash),
        Buffer.from(bindingHash),
      )
    ) {
      throw new UnauthorizedException(
        'Sign-in expired or browser does not match',
      );
    }
    // Consume state before the exchange so concurrent callbacks cannot reuse it.
    const consumed = await this.prisma.oAuthAttempt.deleteMany({
      where: {
        stateHash,
        bindingHash,
        provider,
        expiresAt: { gt: new Date() },
      },
    });
    if (consumed.count !== 1)
      throw new UnauthorizedException('Sign-in already used');
    const { client, config } = await this.configuration(provider);
    const callback = this.callback(provider);
    const params = new URLSearchParams({ code: body.code, state: body.state });
    if (body.iss !== undefined) params.set('iss', body.iss);
    const response =
      provider === 'apple'
        ? new Request(callback, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: params,
          })
        : new URL(`${callback}?${params}`);
    const tokens = await client.authorizationCodeGrant(config, response, {
      expectedState: body.state,
      expectedNonce: attempt.nonce,
      idTokenExpected: true,
      ...(attempt.verifier ? { pkceCodeVerifier: attempt.verifier } : {}),
    });
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string')
      throw new UnauthorizedException('Identity not verified');
    const subject = claims.sub;
    let user = (
      await this.prisma.externalIdentity.findUnique({
        where: { provider_subject: { provider, subject } },
        include: { user: true },
      })
    )?.user;
    if (!user) {
      const email =
        typeof claims.email === 'string'
          ? claims.email.trim().toLowerCase()
          : '';
      if (
        !email ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        ![true, 'true'].includes(claims.email_verified as boolean | string)
      )
        throw new UnauthorizedException('Verified email is required');
      try {
        user = await this.prisma.$transaction(async (tx) => {
          if (await tx.user.findUnique({ where: { email } }))
            throw new ConflictException(
              'Use the existing account sign-in method',
            );
          return tx.user.create({
            data: {
              email,
              passwordHash: null,
              externalIdentities: { create: { provider, subject } },
            },
          });
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          throw new ConflictException(
            'Use the existing account sign-in method',
          );
        throw error;
      }
    }
    if (!user.isActive)
      throw new UnauthorizedException('Account is not active');
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    return {
      ...this.auth.createSession(user.id),
      nextPath: membership
        ? dashboardDestination(attempt.nextPath)
        : '/onboarding',
    };
  }
}
