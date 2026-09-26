import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CommandCenterController } from './command-center.controller';
import { CommandCenterService } from './command-center.service';

describe('CommandCenterController', () => {
  let controller: CommandCenterController;
  let commandCenterService: {
    getOverview: jest.Mock;
  };

  beforeEach(async () => {
    commandCenterService = {
      getOverview: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommandCenterController],
      providers: [
        { provide: CommandCenterService, useValue: commandCenterService },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .compile();

    controller = module.get<CommandCenterController>(CommandCenterController);
  });

  it('uses the authenticated request merchant header for overview', async () => {
    commandCenterService.getOverview.mockResolvedValue({ ok: true });

    const req = {
      headers: { 'x-stackaura-merchant-id': 'm-1' },
      sessionAuth: {
        user: { id: 'u-1', email: 'owner@example.com' },
        memberships: [
          {
            id: 'mem-1',
            role: 'OWNER',
            merchant: { id: 'm-1', name: 'Merchant One' },
          },
        ],
      },
    };

    await expect(controller.overview(req as never)).resolves.toEqual({
      ok: true,
    });
    expect(commandCenterService.getOverview).toHaveBeenCalledWith('m-1');
  });

  it('rejects a missing merchant header', async () => {
    const req = {
      headers: {},
      sessionAuth: {
        user: { id: 'u-1', email: 'owner@example.com' },
        memberships: [
          {
            id: 'mem-1',
            role: 'OWNER',
            merchant: { id: 'm-1', name: 'Merchant One' },
          },
        ],
      },
    };

    await expect(controller.overview(req as never)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(commandCenterService.getOverview).not.toHaveBeenCalled();
  });

  it('allows an authorized merchant membership', async () => {
    commandCenterService.getOverview.mockResolvedValue({ merchantId: 'm-1' });

    const req = {
      headers: { 'x-stackaura-merchant-id': 'm-1' },
      sessionAuth: {
        user: { id: 'u-1', email: 'owner@example.com' },
        memberships: [
          {
            id: 'mem-1',
            role: 'OWNER',
            merchant: { id: 'm-1', name: 'Merchant One' },
          },
        ],
      },
    };

    await expect(controller.overview(req as never)).resolves.toEqual({
      merchantId: 'm-1',
    });
    expect(commandCenterService.getOverview).toHaveBeenCalledWith('m-1');
  });

  it('rejects an unauthorized merchant membership', async () => {
    const req = {
      headers: { 'x-stackaura-merchant-id': 'm-2' },
      sessionAuth: {
        user: { id: 'u-1', email: 'owner@example.com' },
        memberships: [
          {
            id: 'mem-1',
            role: 'OWNER',
            merchant: { id: 'm-1', name: 'Merchant One' },
          },
        ],
      },
    };

    await expect(controller.overview(req as never)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(commandCenterService.getOverview).not.toHaveBeenCalled();
  });
});
