import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { SessionRequest } from '../../auth/session-auth.guard';
import { isPlatformAdminEmail } from '../../admin/admin-access';

@Injectable()
export class JarvisOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request =
      context.switchToHttp().getRequest<SessionRequest>();

    const email = request.sessionAuth?.user?.email;

    if (!email) {
      throw new UnauthorizedException('Not authenticated');
    }

    if (!isPlatformAdminEmail(email)) {
      throw new ForbiddenException('JARVIS owner access denied');
    }

    return true;
  }
}
