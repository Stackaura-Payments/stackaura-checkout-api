import {
  Controller,
  Get,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  SessionAuthGuard,
  type SessionRequest,
} from '../auth/session-auth.guard';
import { CommandCenterService } from './command-center.service';

const DASHBOARD_MERCHANT_HEADER = 'x-stackaura-merchant-id';

@ApiTags('command-center')
@Controller('command-center')
@UseGuards(SessionAuthGuard)
export class CommandCenterController {
  constructor(private readonly commandCenterService: CommandCenterService) {}

  @ApiOperation({ summary: 'Get Command Center overview for a merchant' })
  @Get('overview')
  async overview(@Req() req: SessionRequest) {
    const merchantId = this.requireSessionMerchantId(req);
    return this.commandCenterService.getOverview(merchantId);
  }

  private requireSessionMerchantId(req: SessionRequest) {
    const rawHeader = req.headers?.[DASHBOARD_MERCHANT_HEADER];
    const merchantId = Array.isArray(rawHeader)
      ? rawHeader[0]?.trim()
      : rawHeader?.trim();

    if (!merchantId) {
      throw new UnauthorizedException('Merchant access denied');
    }

    const hasMembership = req.sessionAuth?.memberships.some(
      (membership) => membership.merchant.id === merchantId,
    );

    if (!hasMembership) {
      throw new UnauthorizedException('Merchant access denied');
    }

    return merchantId;
  }
}
