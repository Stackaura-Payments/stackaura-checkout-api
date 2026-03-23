import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('pricing', () => {
    it('returns the public pricing snapshot', () => {
      process.env.STACKAURA_PLATFORM_FEE_FIXED = '150';
      process.env.STACKAURA_PLATFORM_FEE_BPS = '150';
      process.env.STACKAURA_PLAN_GROWTH_FEE_FIXED = '250';
      process.env.STACKAURA_PLAN_GROWTH_FEE_BPS = '250';
      process.env.STACKAURA_PLAN_SCALE_FEE_FIXED = '750';
      process.env.STACKAURA_PLAN_SCALE_FEE_BPS = '750';

      const pricing = appController.pricing();

      expect(pricing.plans.starter.display.fromPrice).toBe(
        'From 1.50% + R1.50 / transaction',
      );
      expect(pricing.plans.growth.display.fromPrice).toBe(
        'From 2.50% + R2.50 / transaction',
      );
      expect(pricing.plans.scale.display.startingFromPrice).toBe(
        'Starting from 7.50% + R7.50 / transaction',
      );
    });
  });
});
