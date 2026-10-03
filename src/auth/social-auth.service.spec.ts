import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  SocialAuthService,
  dashboardDestination,
  socialProvider,
} from './social-auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

describe('Social sign-in safety', () => {
  const stateHash = createHash('sha256').update('state').digest('hex');
  const bindingHash = createHash('sha256').update('browser').digest('hex');
  const prisma = {
    oAuthAttempt: { findUnique: jest.fn(), deleteMany: jest.fn() },
    externalIdentity: { findUnique: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    membership: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  const auth = { createSession: jest.fn() };
  let service: SocialAuthService;
  const originalEnv = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { NODE_ENV: 'test' };
    service = new SocialAuthService(
      prisma as unknown as PrismaService,
      auth as unknown as AuthService,
    );
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('disables unconfigured providers and fails closed', async () => {
    expect(service.providerStatus()).toEqual({ google: false, apple: false });
    await expect(service.start('google')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
  it('requires explicit production activation even when Google credentials exist', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SOCIAL_AUTH_CALLBACK_BASE_URL = 'https://stackaura.co.za';
    process.env.SESSION_SECRET = 'test-session-secret';
    process.env.GOOGLE_CLIENT_ID = 'client';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    expect(service.providerStatus()).toEqual({ google: false, apple: false });
    await expect(service.start('google')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(
      service.complete('google', {
        state: 'state',
        code: 'code',
        bindingToken: 'browser',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.oAuthAttempt.findUnique).not.toHaveBeenCalled();
    process.env.SOCIAL_AUTH_ENABLED = 'true';
    expect(service.providerStatus()).toEqual({ google: true, apple: false });
  });
  it('allows local Google setup but never non-HTTPS Apple', () => {
    process.env.SOCIAL_AUTH_CALLBACK_BASE_URL = 'http://127.0.0.1:4178';
    process.env.GOOGLE_CLIENT_ID = 'client';
    process.env.SESSION_SECRET = 'test-session-secret';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    process.env.APPLE_CLIENT_ID = 'apple';
    process.env.APPLE_TEAM_ID = 'team';
    process.env.APPLE_KEY_ID = 'key';
    process.env.APPLE_PRIVATE_KEY = 'private';
    expect(service.providerStatus()).toEqual({ google: true, apple: false });
    process.env.NODE_ENV = 'production';
    expect(service.providerStatus()).toEqual({ google: false, apple: false });
  });
  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/dashboard?next=evil',
    '/dashboard/../api/auth/logout',
    '/dashboard\n',
  ])('rejects unsafe redirect %s', (path) => {
    expect(dashboardDestination(path)).toBe('/dashboard');
  });
  it('supports dashboard subpaths only and rejects unknown providers', () => {
    expect(dashboardDestination('/dashboard/payments')).toBe(
      '/dashboard/payments',
    );
    expect(() => socialProvider('unknown')).toThrow(BadRequestException);
  });
  it('rejects malformed callbacks before touching the database', async () => {
    await expect(service.complete('google', {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.oAuthAttempt.findUnique).not.toHaveBeenCalled();
  });
  it.each([null, 123, {}, 'x'.repeat(2049)])(
    'rejects malformed callback issuer before database access (%s)',
    async (iss) => {
      await expect(
        service.complete('google', {
          state: 'state',
          code: 'code',
          bindingToken: 'browser',
          iss: iss as string,
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.oAuthAttempt.findUnique).not.toHaveBeenCalled();
      expect(auth.createSession).not.toHaveBeenCalled();
    },
  );
  it.each(['browser-mismatch', 'expired', 'provider-mismatch', 'missing'])(
    'rejects %s before exchange or session creation',
    async (reason) => {
      prisma.oAuthAttempt.findUnique.mockResolvedValue(
        reason === 'missing'
          ? null
          : {
              stateHash,
              bindingHash:
                reason === 'browser-mismatch'
                  ? createHash('sha256').update('other').digest('hex')
                  : bindingHash,
              provider: reason === 'provider-mismatch' ? 'apple' : 'google',
              expiresAt: new Date(
                Date.now() + (reason === 'expired' ? -1000 : 60000),
              ),
            },
      );
      await expect(
        service.complete('google', {
          state: 'state',
          code: 'code',
          bindingToken: 'browser',
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.oAuthAttempt.deleteMany).not.toHaveBeenCalled();
      expect(auth.createSession).not.toHaveBeenCalled();
    },
  );
  it('rejects a callback consumed by another request', async () => {
    prisma.oAuthAttempt.findUnique.mockResolvedValue({
      stateHash,
      bindingHash,
      provider: 'google',
      expiresAt: new Date(Date.now() + 60000),
    });
    prisma.oAuthAttempt.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      service.complete('google', {
        state: 'state',
        code: 'code',
        bindingToken: 'browser',
      }),
    ).rejects.toThrow('Sign-in already used');
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  describe('validated identity exchange', () => {
    const grant = jest.fn();
    const claims = jest.fn();
    const body = { state: 'state', code: 'code', bindingToken: 'browser' };
    beforeEach(() => {
      process.env.SOCIAL_AUTH_CALLBACK_BASE_URL = 'https://example.test';
      prisma.oAuthAttempt.findUnique.mockResolvedValue({
        stateHash,
        bindingHash,
        provider: 'google',
        nonce: 'nonce',
        verifier: 'verifier',
        nextPath: '/dashboard/payments',
        expiresAt: new Date(Date.now() + 60000),
      });
      prisma.oAuthAttempt.deleteMany.mockResolvedValue({ count: 1 });
      prisma.externalIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(
        (callback: (tx: typeof prisma) => unknown) => callback(prisma),
      );
      claims.mockReturnValue({
        sub: 'subject',
        email: 'Owner@example.test',
        email_verified: true,
      });
      grant.mockResolvedValue({ claims });
      jest
        .spyOn(
          service as unknown as { configuration: () => Promise<unknown> },
          'configuration',
        )
        .mockResolvedValue({
          client: { authorizationCodeGrant: grant },
          config: 'config',
        });
      prisma.user.create.mockResolvedValue({ id: 'user', isActive: true });
      prisma.membership.findFirst.mockResolvedValue(null);
      auth.createSession.mockReturnValue({
        userId: 'user',
        sessionToken: 'session',
        expiresAt: new Date(),
      });
    });
    it('passes state, nonce, PKCE and ID token requirements to the validated OIDC library', async () => {
      const result = await service.complete('google', body);
      expect(grant).toHaveBeenCalledWith('config', expect.any(URL), {
        expectedState: 'state',
        expectedNonce: 'nonce',
        pkceCodeVerifier: 'verifier',
        idTokenExpected: true,
      });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          email: 'owner@example.test',
          passwordHash: null,
          externalIdentities: {
            create: { provider: 'google', subject: 'subject' },
          },
        },
      });
      expect(result.nextPath).toBe('/onboarding');
    });
    it('preserves the callback issuer for OIDC validation', async () => {
      await service.complete('google', {
        ...body,
        iss: 'https://accounts.google.com',
      });
      const response = (grant.mock.calls as unknown[][]).at(-1)?.[1] as URL;
      expect(response.searchParams.get('iss')).toBe(
        'https://accounts.google.com',
      );
    });
    it('does not replace an untrusted issuer or bypass OIDC rejection', async () => {
      grant.mockRejectedValueOnce(new Error('Unexpected authorization issuer'));
      await expect(
        service.complete('google', { ...body, iss: 'https://evil.example' }),
      ).rejects.toThrow('Unexpected authorization issuer');
      const response = (grant.mock.calls as unknown[][]).at(-1)?.[1] as URL;
      expect(response.searchParams.get('iss')).toBe('https://evil.example');
      expect(auth.createSession).not.toHaveBeenCalled();
    });
    it('does not link an existing password account by email', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'password-user' });
      await expect(service.complete('google', body)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(auth.createSession).not.toHaveBeenCalled();
    });
    it.each([false, 'false', undefined])(
      'does not create users for unverified emails (%s)',
      async (verified) => {
        claims.mockReturnValue({
          sub: 'subject',
          email: 'owner@example.test',
          email_verified: verified,
        });
        await expect(service.complete('google', body)).rejects.toThrow(
          UnauthorizedException,
        );
        expect(prisma.user.create).not.toHaveBeenCalled();
      },
    );
    it('accepts Apple relay email and its POST callback without unsupported PKCE', async () => {
      prisma.oAuthAttempt.findUnique.mockResolvedValue({
        stateHash,
        bindingHash,
        provider: 'apple',
        nonce: 'nonce',
        verifier: '',
        nextPath: '/dashboard',
        expiresAt: new Date(Date.now() + 60000),
      });
      claims.mockReturnValue({
        sub: 'apple-subject',
        email: 'relay@privaterelay.appleid.com',
        email_verified: 'true',
      });
      await service.complete('apple', body);
      expect(grant).toHaveBeenCalledWith('config', expect.any(Request), {
        expectedState: 'state',
        expectedNonce: 'nonce',
        idTokenExpected: true,
      });
      expect(
        ((grant.mock.calls as unknown[][]).at(-1)?.[1] as Request).method,
      ).toBe('POST');
      expect(
        (prisma.user.create.mock.calls as unknown[][])[0][0],
      ).toMatchObject({ data: { email: 'relay@privaterelay.appleid.com' } });
    });
    it('reuses subject identity without creating another user and preserves dashboard destination', async () => {
      prisma.externalIdentity.findUnique.mockResolvedValue({
        user: { id: 'user', isActive: true },
      });
      prisma.membership.findFirst.mockResolvedValue({ id: 'membership' });
      expect((await service.complete('google', body)).nextPath).toBe(
        '/dashboard/payments',
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
    it('rejects inactive identities and invalid token exchanges without issuing sessions', async () => {
      prisma.externalIdentity.findUnique.mockResolvedValue({
        user: { id: 'user', isActive: false },
      });
      await expect(service.complete('google', body)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(auth.createSession).not.toHaveBeenCalled();
      grant.mockRejectedValueOnce(
        new Error('Invalid token signature or nonce'),
      );
      await expect(service.complete('google', body)).rejects.toThrow(
        'Invalid token signature or nonce',
      );
      expect(auth.createSession).not.toHaveBeenCalled();
    });
  });
});
