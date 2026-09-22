import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { OwnerOperationService } from './owner-operation.service';

describe('OwnerOperationService', () => {
  let service: OwnerOperationService;
  const prisma = {
    jarvisOwnerOperation: {
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OwnerOperationService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get<OwnerOperationService>(OwnerOperationService);
  });

  it('starts an owner operation with owner identity and sanitized request', async () => {
    prisma.jarvisOwnerOperation.create.mockResolvedValue({ id: 'op-1' });

    await service.start({
      ownerId: 'owner-1',
      userId: 'user-1',
      agent: 'chief-of-staff',
      toolId: 'jarvis.owner-test',
      intent: 'inspect',
      permission: 'observe',
      request: {
        token: 'do-not-store',
        nested: { apiKey: 'do-not-store' },
      },
    });

    expect(prisma.jarvisOwnerOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: 'owner-1',
          userId: 'user-1',
          toolId: 'jarvis.owner-test',
          status: 'STARTED',
          request: {
            token: '[REDACTED]',
            nested: { apiKey: '[REDACTED]' },
          },
        }),
      }),
    );
  });

  it('marks an operation successful', async () => {
    prisma.jarvisOwnerOperation.update.mockResolvedValue({ id: 'op-1' });
    await service.succeed('op-1', { ok: true });
    expect(prisma.jarvisOwnerOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'op-1' },
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    );
  });

  it('marks an operation failed without leaking error objects', async () => {
    prisma.jarvisOwnerOperation.update.mockResolvedValue({ id: 'op-1' });
    await service.fail('op-1', new Error('backend failed'));
    expect(prisma.jarvisOwnerOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'op-1' },
        data: expect.objectContaining({
          status: 'FAILED',
          error: 'backend failed',
        }),
      }),
    );
  });

  it('lists operations only within the owner scope', async () => {
    prisma.jarvisOwnerOperation.findMany.mockResolvedValue([]);
    await service.list({ ownerId: 'owner-1', userId: 'user-1', limit: 200 });
    expect(prisma.jarvisOwnerOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: 'owner-1', userId: 'user-1' },
        take: 100,
      }),
    );
  });
});
