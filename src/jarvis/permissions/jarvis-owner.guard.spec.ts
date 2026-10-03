import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JarvisOwnerGuard } from './jarvis-owner.guard';

describe('JarvisOwnerGuard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function buildContext(email?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          sessionAuth: email
            ? {
                user: {
                  email,
                },
              }
            : undefined,
        }),
      }),
    } as ExecutionContext;
  }

  it('allows the configured JARVIS owner', () => {
    process.env.STACKAURA_ADMIN_EMAILS = 'owner@example.com';

    const guard = new JarvisOwnerGuard();

    expect(
      guard.canActivate(buildContext('owner@example.com')),
    ).toBe(true);
  });

  it('rejects a non-owner', () => {
    process.env.STACKAURA_ADMIN_EMAILS = 'owner@example.com';

    const guard = new JarvisOwnerGuard();

    expect(() =>
      guard.canActivate(buildContext('merchant@example.com')),
    ).toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated request', () => {
    process.env.STACKAURA_ADMIN_EMAILS = 'owner@example.com';

    const guard = new JarvisOwnerGuard();

    expect(() =>
      guard.canActivate(buildContext()),
    ).toThrow(UnauthorizedException);
  });
});
