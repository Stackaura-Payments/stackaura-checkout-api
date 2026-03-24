import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminService } from './admin.service';

@ApiTags('admin')
@Controller('admin')
@UseGuards(SessionAuthGuard, AdminAccessGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @ApiOperation({ summary: 'Get internal Stackaura admin analytics overview' })
  @Get('overview')
  async getOverview() {
    return this.adminService.getOverview();
  }
}
