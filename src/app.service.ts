import { Injectable } from '@nestjs/common';
import { resolvePublicPricingSnapshot } from './payments/monetization.config';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  getPricing() {
    return resolvePublicPricingSnapshot();
  }
}
