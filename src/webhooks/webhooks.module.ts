import { GatewaysModule } from '../gateways/gateways.module';
import { PaymentsModule } from '../payments/payments.module';
import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { SupportModule } from '../support/support.module';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';
import { WhatsAppService } from './whatsapp.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [PrismaModule, PaymentsModule, GatewaysModule, SupportModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WhatsAppService,
    ApiKeyGuard,
    WebhookDeliveryWorker,
  ],
  exports: [WebhooksService],
})
export class WebhooksModule {}
