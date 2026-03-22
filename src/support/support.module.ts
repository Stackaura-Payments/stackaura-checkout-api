import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SupportAiService } from './support-ai.service';
import { SupportContextService } from './support-context.service';
import { SupportController } from './support.controller';
import { SupportEscalationService } from './support-escalation.service';
import { SupportKnowledgeService } from './support-knowledge.service';
import { SupportService } from './support.service';

@Module({
  imports: [PrismaModule, AuthModule, MerchantsModule],
  controllers: [SupportController],
  providers: [
    SupportService,
    SupportContextService,
    SupportKnowledgeService,
    SupportAiService,
    SupportEscalationService,
  ],
  exports: [SupportService],
})
export class SupportModule {}
