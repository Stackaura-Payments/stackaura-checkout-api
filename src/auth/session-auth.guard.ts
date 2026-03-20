import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AuthService } from './auth.service';

export type SessionAuthContext = NonNullable<
  Awaited<ReturnType<AuthService['resolveSession']>>
>;

export type SessionRequest = Request & {
  sessionAuth?: SessionAuthContext;
};

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<SessionRequest>();
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'stackaura_session';
    const token = request.cookies?.[cookieName];
    const session = await this.authService.resolveSession(token);

    if (!session) {
      throw new UnauthorizedException('Not authenticated');
    }

    request.sessionAuth = session;
    return true;
  }
}
