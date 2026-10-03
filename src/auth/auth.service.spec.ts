import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock };
    membership: { findMany: jest.Mock };
  };
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      SESSION_SECRET: 'test-session-secret',
    };
    prisma = {
      user: {
        findUnique: jest.fn(),
      },
      membership: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AuthService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('logs in an active user with a valid password', async () => {
    const passwordHash = await argon2.hash('ChangeMe123!');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      email: 'owner@example.com',
      passwordHash,
      isActive: true,
    });

    const result = await service.login('owner@example.com', 'ChangeMe123!');

    expect(result).toEqual(
      expect.objectContaining({
        userId: 'u-1',
        sessionToken: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    );
  });

  it('rejects login when the auth user is inactive', async () => {
    const passwordHash = await argon2.hash('ChangeMe123!');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      email: 'owner@example.com',
      passwordHash,
      isActive: false,
    });

    await expect(
      service.login('owner@example.com', 'ChangeMe123!'),
    ).rejects.toThrow(
      new UnauthorizedException(
        'Account not active. Complete signup to continue.',
      ),
    );
  });

  it('rejects password login for social-only accounts', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'social-user',
      email: 'social@example.test',
      passwordHash: null,
      isActive: true,
    });
    await expect(
      service.login('social@example.test', 'anything'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('flags social accounts without a workspace without exposing password hashes', async () => {
    const session = service.createSession('social-user');
    prisma.user.findUnique.mockResolvedValue({
      id: 'social-user',
      email: 'social@example.test',
      passwordHash: null,
    });
    prisma.membership.findMany.mockResolvedValue([]);
    const result = await service.resolveSession(session.sessionToken);
    expect(result?.onboardingRequired).toBe(true);
    expect(result?.user).toEqual({
      id: 'social-user',
      email: 'social@example.test',
    });
  });

  it('preserves password-account session behavior and rejects tampered sessions', async () => {
    const session = service.createSession('password-user');
    prisma.user.findUnique.mockResolvedValue({
      id: 'password-user',
      email: 'owner@example.test',
      passwordHash: 'private-hash',
    });
    prisma.membership.findMany.mockResolvedValue([]);
    expect(
      (await service.resolveSession(session.sessionToken))?.onboardingRequired,
    ).toBe(false);
    expect(
      await service.resolveSession(`${session.sessionToken}tampered`),
    ).toBeNull();
  });
});
