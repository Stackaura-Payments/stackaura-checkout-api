import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BusinessVerificationController } from './business-verification.controller';
import { BusinessVerificationService } from './business-verification.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [BusinessVerificationController],
  providers: [BusinessVerificationService],
})
export class BusinessVerificationModule {}
