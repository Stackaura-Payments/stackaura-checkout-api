import { Injectable, ForbiddenException } from '@nestjs/common';
import { PermissionLevel } from './permission.types';
import { JarvisTool } from '../tools/tool.types';

@Injectable()
export class PermissionService {
  canExecute(tool: JarvisTool, approved = false): boolean {
    switch (tool.permission) {
      case 'observe':
      case 'safe':
        return true;

      case 'approval':
        return approved;

      case 'human-only':
        throw new ForbiddenException(
          `Tool "${tool.id}" requires direct human authorization.`,
        );

      default:
        return false;
    }
  }

  assertCanExecute(tool: JarvisTool, approved = false): void {
    if (!this.canExecute(tool, approved)) {
      throw new ForbiddenException(
        `Tool "${tool.id}" requires approval before execution.`,
      );
    }
  }
}
