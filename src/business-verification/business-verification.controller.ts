import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  SessionAuthGuard,
  type SessionRequest,
} from '../auth/session-auth.guard';
import { BusinessVerificationService } from './business-verification.service';

@Controller()
@UseGuards(SessionAuthGuard)
export class BusinessVerificationController {
  constructor(private readonly service: BusinessVerificationService) {}
  private user(req: SessionRequest, write = false) {
    if (
      write &&
      !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')
    )
      throw new BadRequestException('JSON is required');
    return req.sessionAuth!.user.id;
  }
  @Post('auth/workspace')
  createWorkspace(
    @Req() req: SessionRequest,
    @Body() body: { businessName?: unknown },
  ) {
    return this.service.createWorkspace(this.user(req, true), body);
  }
  @Get('merchants/:merchantId/business-verification')
  @Header('Cache-Control', 'no-store')
  get(@Req() req: SessionRequest, @Param('merchantId') merchantId: string) {
    return this.service.get(this.user(req), merchantId);
  }
  @Post('merchants/:merchantId/business-verification')
  save(
    @Req() req: SessionRequest,
    @Param('merchantId') merchantId: string,
    @Body() body: unknown,
  ) {
    return this.service.save(this.user(req, true), merchantId, body, false);
  }
  @Post('merchants/:merchantId/business-verification/submit')
  submit(
    @Req() req: SessionRequest,
    @Param('merchantId') merchantId: string,
    @Body() body: unknown,
  ) {
    return this.service.save(this.user(req, true), merchantId, body, true);
  }
}
