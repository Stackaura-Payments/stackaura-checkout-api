import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { createPrismaPgAdapter } from './prisma-adapter';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleDestroy
{
  private readonly pool: Pool;

  constructor() {
    const databaseUrl = PrismaService.readDatabaseUrl();
    const { adapter, pool } = createPrismaPgAdapter(databaseUrl);
    super({ adapter });
    this.pool = pool;
  }

  private static readDatabaseUrl() {
    const raw =
      process.env.DATABASE_URL?.trim() ?? process.env.DIRECT_URL?.trim();
    if (!raw) {
      Logger.warn(
        'DATABASE_URL is missing at startup. Prisma will fail on database queries until Cloud Run provides a real DATABASE_URL.',
        PrismaService.name,
      );
      return 'postgresql://user:password@localhost:5432/stackaura?schema=public';
    }

    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1);
    }

    return raw;
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}
