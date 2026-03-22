import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { PaymentsModule } from './payments/payments.module';
import { MerchantsModule } from './merchants/merchants.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { CheckoutModule } from './checkout/checkout.module';
import { PayoutsModule } from './payouts/payouts.module';
import { AuthModule } from './auth/auth.module';
import { SubscriptionScheduler } from './scheduler/subscription.scheduler';
import { SupportModule } from './support/support.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    PaymentsModule,
    MerchantsModule,
    WebhooksModule,
    CheckoutModule,
    PayoutsModule,
    AuthModule,
    SupportModule,
  ],
  controllers: [AppController],
  providers: [AppService, SubscriptionScheduler],
})
export class AppModule {}
