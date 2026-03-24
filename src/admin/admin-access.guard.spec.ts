import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';

describe('AdminAccessGuard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function buildContext(email: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          sessionAuth: {
            user: {
              email,
            },
          },
        }),
      }),
    } as ExecutionContext;
  }

  it('allows configured admin emails', () => {
    process.env.STACKAURA_ADMIN_EMAILS = 'owner@stackaura.co.za';
    const guard = new AdminAccessGuard();

    expect(guard.canActivate(buildContext('owner@stackaura.co.za'))).toBe(true);
  });

  it('rejects non-admin emails', () => {
    process.env.STACKAURA_ADMIN_EMAILS = 'owner@stackaura.co.za';
    const guard = new AdminAccessGuard();

    expect(() =>
      guard.canActivate(buildContext('merchant@example.com')),
    ).toThrow(ForbiddenException);
  });
});
