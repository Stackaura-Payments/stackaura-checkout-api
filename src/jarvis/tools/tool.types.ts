import { PermissionLevel } from '../permissions/permission.types';

export interface JarvisTool {
  id: string;
  name: string;
  description: string;
  permission: PermissionLevel;
  readOnly: boolean;
}
