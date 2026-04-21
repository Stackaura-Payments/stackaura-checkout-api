import {
  Body,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { ShopifyService } from './shopify.service';

type RawBodyRequest = Request & { rawBody?: string | Buffer };

@ApiTags('shopify')
@Controller('shopify')
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(private readonly shopifyService: ShopifyService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Check Shopify integration readiness' })
  health() {
    return this.shopifyService.health();
  }

  @Public()
  @Post('auth/token-exchange')
  @ApiOperation({
    summary:
      'Verify a Shopify embedded session token and exchange it for an offline Admin API token',
  })
  async tokenExchange(@Req() req: Request) {
    return this.shopifyService.exchangeSessionToken(
      this.shopifyService.readSessionTokenFromRequest(req),
    );
  }

  @Public()
  @Get('shop')
  @ApiOperation({
    summary:
      'Return the current shop installation state and a small authenticated Admin API snapshot',
  })
  async shop(@Req() req: Request) {
    return this.shopifyService.getShopSnapshot(
      this.shopifyService.readSessionTokenFromRequest(req),
    );
  }

  @Public()
  @Post('register-webhooks')
  @ApiOperation({ summary: 'Register the minimum Shopify webhooks for Stackaura' })
  async registerWebhooks(@Req() req: Request) {
    return this.shopifyService.registerWebhooks(
      this.shopifyService.readSessionTokenFromRequest(req),
    );
  }

  @Public()
  @Get('support-agent')
  @ApiOperation({ summary: 'Return the current Support Agent configuration for the installed Shopify shop' })
  async supportAgent(@Req() req: Request) {
    return this.shopifyService.getSupportAgentSettings(
      this.shopifyService.readSessionTokenFromRequest(req),
    );
  }

  @Public()
  @Put('support-agent')
  @ApiOperation({ summary: 'Save the current Support Agent configuration for the installed Shopify shop' })
  async updateSupportAgent(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ) {
    return this.shopifyService.saveSupportAgentSettings(
      this.shopifyService.readSessionTokenFromRequest(req),
      body,
    );
  }

  @Public()
  @Get('support-agent/deployment')
  @ApiOperation({
    summary:
      'Return derived storefront widget deployment readiness for the installed Shopify shop',
  })
  async supportAgentDeployment(@Req() req: Request) {
    return this.shopifyService.getSupportAgentDeployment(
      this.shopifyService.readSessionTokenFromRequest(req),
    );
  }

  @Public()
  @Get('support-agent/widget-config')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Return storefront-safe Support Agent widget configuration and deployment guidance for the installed Shopify shop',
  })
  async supportAgentWidgetConfig(
    @Req() req: Request,
    @Query('shop') shopDomain?: string,
  ) {
    const authorization =
      req.header('authorization') ?? req.header('Authorization');

    if (authorization?.startsWith('Bearer ')) {
      return this.shopifyService.getSupportAgentWidgetConfig(
        this.shopifyService.readSessionTokenFromRequest(req),
      );
    }

    return this.shopifyService.getPublicSupportAgentWidgetConfig(shopDomain);
  }

  @Public()
  @HttpCode(200)
  @Post('support-agent/activation')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Record a lightweight storefront activation ping for the Support Agent widget',
  })
  async supportAgentActivation(@Body() body: Record<string, unknown>) {
    return this.shopifyService.recordSupportAgentActivation(body);
  }

  @Public()
  @HttpCode(200)
  @Post('support-agent/chat')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Handle a public storefront support message for the current Shopify shop',
  })
  async supportAgentChat(@Body() body: Record<string, unknown>) {
    return this.shopifyService.chatWithSupportAgent(body);
  }

  @Public()
  @Get('support-agent/conversations')
  @ApiOperation({
    summary:
      'Return the latest storefront support conversations for the installed Shopify shop',
  })
  async supportAgentConversations(@Req() req: Request) {
    return this.shopifyService.getSupportAgentConversations(
      this.shopifyService.readSessionTokenFromRequest(req),
    );
  }

  @Public()
  @Get('support-agent/conversations/:sessionId')
  @ApiOperation({
    summary:
      'Return a single storefront support conversation thread for the installed Shopify shop',
  })
  async supportAgentConversation(
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
  ) {
    return this.shopifyService.getSupportAgentConversation(
      this.shopifyService.readSessionTokenFromRequest(req),
      sessionId,
    );
  }

  @Public()
  @HttpCode(200)
  @Post('webhooks')
  @ApiOperation({ summary: 'Receive Shopify webhooks and verify HMAC on raw payload' })
  async webhooks(
    @Req() req: RawBodyRequest,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    try {
      return await this.shopifyService.handleWebhook(body, {
        rawBody: req?.rawBody,
        headers,
      });
    } catch (error) {
      this.logger.error(
        'Shopify webhook processing failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}
