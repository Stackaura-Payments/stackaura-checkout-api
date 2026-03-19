import { Module } from '@nestjs/common';
import { GatewayRegistry } from './gateway.registry';
import { OzowGateway } from './ozow.gateway';
import { PayfastGateway } from './payfast.gateway';
import { PaystackGateway } from './paystack.gateway';
import { YocoGateway } from './yoco.gateway';

@Module({
  providers: [
    GatewayRegistry,
    PayfastGateway,
    OzowGateway,
    YocoGateway,
    PaystackGateway,
  ],
  exports: [
    GatewayRegistry,
    PayfastGateway,
    OzowGateway,
    YocoGateway,
    PaystackGateway,
  ],
})
export class GatewaysModule {}
