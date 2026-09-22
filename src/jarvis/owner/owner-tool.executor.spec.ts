import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PermissionService } from '../permissions/permission.service';
import { ToolRegistry } from '../tools/tool.registry';
import { OwnerOperationService } from './owner-operation.service';
import { OwnerToolExecutor } from './owner-tool.executor';

describe('OwnerToolExecutor', () => {
  let executor: OwnerToolExecutor;
  const toolRegistry = { get: jest.fn() };
  const permissionService = { assertCanExecute: jest.fn() };
  const ownerOperationService = {
    start: jest.fn(),
    succeed: jest.fn(),
    fail: jest.fn(),
    deny: jest.fn(),
  };

  const ownerTool = {
    id: 'jarvis.owner-test',
    name: 'JARVIS Owner Test',
    description: 'Harmless owner execution boundary test tool.',
    permission: 'observe',
    readOnly: true,
    scope: 'owner',
  };

  const context = {
    identity: { ownerId: 'owner-1', userId: 'user-1' },
    resource: undefined,
    agent: 'chief-of-staff',
    intent: 'inspect-owner-runtime',
    arguments: { target: 'self' },
    approved: false,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    toolRegistry.get.mockReturnValue(ownerTool);
    permissionService.assertCanExecute.mockImplementation(() => undefined);
    ownerOperationService.start.mockResolvedValue({ id: 'owner-op-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OwnerToolExecutor,
        { provide: ToolRegistry, useValue: toolRegistry },
        { provide: PermissionService, useValue: permissionService },
        { provide: OwnerOperationService, useValue: ownerOperationService },
      ],
    }).compile();
    executor = module.get<OwnerToolExecutor>(OwnerToolExecutor);
  });

  it('executes an owner-scoped tool without a merchant resource', async () => {
    await expect(executor.execute(ownerTool.id, context)).resolves.toEqual({
      ok: true,
      message: 'Owner-scoped JARVIS tool executed successfully.',
      ownerId: 'owner-1',
      arguments: { target: 'self' },
    });

    expect(ownerOperationService.start).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        userId: 'user-1',
        toolId: ownerTool.id,
      }),
    );
    expect(ownerOperationService.succeed).toHaveBeenCalledWith(
      'owner-op-1',
      expect.objectContaining({ ok: true }),
    );
  });

  it('rejects a merchant-scoped tool before any owner operation is created', async () => {
    toolRegistry.get.mockReturnValue({ ...ownerTool, scope: 'merchant' });
    await expect(executor.execute(ownerTool.id, context)).rejects.toThrow(
      BadRequestException,
    );
    expect(ownerOperationService.start).not.toHaveBeenCalled();
  });

  it('rejects owner approval/human-only permissions until an owner authorization path exists', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      permission: 'approval',
    });
    await expect(executor.execute(ownerTool.id, context)).rejects.toThrow(
      ForbiddenException,
    );
    expect(ownerOperationService.start).not.toHaveBeenCalled();
  });

  it('records permission denial in the owner operation ledger', async () => {
    const error = new ForbiddenException('blocked');
    permissionService.assertCanExecute.mockImplementation(() => {
      throw error;
    });

    await expect(executor.execute(ownerTool.id, context)).rejects.toThrow('blocked');
    expect(ownerOperationService.deny).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner-1', userId: 'user-1' }),
      error,
    );
  });

  it('marks failed owner execution and rethrows the original error', async () => {
    toolRegistry.get.mockReturnValue({
      ...ownerTool,
      id: 'jarvis.unimplemented-owner-tool',
    });

    await expect(
      executor.execute('jarvis.unimplemented-owner-tool', context),
    ).rejects.toThrow('No owner executor is implemented');

    expect(ownerOperationService.fail).toHaveBeenCalledWith(
      'owner-op-1',
      expect.any(Error),
    );
  });
});
