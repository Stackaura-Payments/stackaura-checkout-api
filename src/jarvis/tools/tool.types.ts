import { PermissionLevel } from '../permissions/permission.types';

export type JarvisToolScope = 'owner' | 'merchant';

export interface JarvisTool {
  id: string;
  name: string;
  description: string;
  permission: PermissionLevel;
  readOnly: boolean;
  scope: JarvisToolScope;
}
