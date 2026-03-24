import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { SessionRequest } from '../auth/session-auth.guard';
import { isPlatformAdminEmail } from './admin-access';

@Injectable()
export class AdminAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const email = request.sessionAuth?.user?.email;

    if (!email) {
      throw new UnauthorizedException('Not authenticated');
    }

    if (!isPlatformAdminEmail(email)) {
      throw new ForbiddenException('Admin access denied');
    }

    return true;
  }
}
