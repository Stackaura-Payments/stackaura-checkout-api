import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Header,
  Post,
  Param,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { SocialAuthService, socialProvider } from './social-auth.service';

type LoginDto = { email: string; password: string };
type SessionCookieSameSite = 'lax' | 'strict' | 'none';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly social: SocialAuthService,
  ) {}

  private parseBooleanEnv(value: string | undefined) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }

    return null;
  }

  private resolveSessionCookieSameSite(): SessionCookieSameSite {
    const normalized =
      process.env.SESSION_COOKIE_SAME_SITE?.trim().toLowerCase();
    if (normalized === 'strict' || normalized === 'none') {
      return normalized;
    }

    return 'lax';
  }

  private resolveSessionCookieSecure(sameSite: SessionCookieSameSite): boolean {
    if (sameSite === 'none') {
      return true;
    }

    const explicit = this.parseBooleanEnv(process.env.SESSION_COOKIE_SECURE);
    if (explicit !== null) {
      return explicit;
    }

    return process.env.NODE_ENV === 'production';
  }

  private resolveSessionCookieDomain() {
    const domain = process.env.SESSION_COOKIE_DOMAIN?.trim();
    return domain ? domain : undefined;
  }

  private buildSessionCookieOptions(expires?: Date) {
    const sameSite = this.resolveSessionCookieSameSite();
    const secure = this.resolveSessionCookieSecure(sameSite);
    const domain = this.resolveSessionCookieDomain();

    return {
      httpOnly: true,
      sameSite,
      secure,
      path: '/',
      ...(expires ? { expires } : {}),
      ...(domain ? { domain } : {}),
    } as const;
  }

  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { userId, sessionToken, expiresAt } = await this.auth.login(
      body.email,
      body.password,
    );

    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'stackaura_session';

    res.cookie(
      cookieName,
      sessionToken,
      this.buildSessionCookieOptions(expiresAt),
    );

    return { ok: true, userId };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'stackaura_session';
    const token = (req as any).cookies?.[cookieName];

    if (token) {
      const session = await this.auth.resolveSession(token);
      if (session?.user?.id) await this.auth.logoutByUserId(session.user.id);
    }

    res.clearCookie(cookieName, this.buildSessionCookieOptions());
    return { ok: true };
  }

  @Get('oauth/providers')
  providers() {
    return this.social.providerStatus();
  }

  @Get('oauth/:provider/start')
  @Header('Cache-Control', 'no-store')
  startSocial(
    @Param('provider') provider: string,
    @Query('next') next?: string,
  ) {
    return this.social.start(socialProvider(provider), next);
  }

  @Post('oauth/:provider/callback')
  @Header('Cache-Control', 'no-store')
  async socialCallback(
    @Param('provider') provider: string,
    @Body()
    body: {
      state?: string;
      code?: string;
      bindingToken?: string;
      iss?: string;
    },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new BadRequestException('JSON is required');
    }
    const result = await this.social.complete(
      socialProvider(provider),
      body ?? {},
    );
    res.cookie(
      process.env.SESSION_COOKIE_NAME ?? 'stackaura_session',
      result.sessionToken,
      this.buildSessionCookieOptions(result.expiresAt),
    );
    return { ok: true, nextPath: result.nextPath };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'stackaura_session';
    const token = (req as any).cookies?.[cookieName];

    const session = await this.auth.resolveSession(token);
    if (!session) throw new UnauthorizedException('Not authenticated');

    return session;
  }
}
