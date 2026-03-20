import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionAuthGuard } from './session-auth.guard';

describe('SessionAuthGuard', () => {
  let guard: SessionAuthGuard;
  let authService: {
    resolveSession: jest.Mock;
  };
  let reflector: {
    getAllAndOverride: jest.Mock;
  };

  beforeEach(() => {
    authService = {
      resolveSession: jest.fn(),
    };
    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };

    guard = new SessionAuthGuard(authService as never, reflector as never);
  });

  it('authenticates from the session cookie without an Authorization header', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [],
    });

    const request = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    };

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(authService.resolveSession).toHaveBeenCalledWith('session-token');
    expect(request).toMatchObject({
      sessionAuth: {
        user: { id: 'u-1', email: 'owner@example.com' },
      },
    });
  });

  it('rejects missing or invalid session cookies', async () => {
    authService.resolveSession.mockResolvedValue(null);

    const request = {
      cookies: {},
      headers: {},
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    };

    await expect(guard.canActivate(context as never)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
