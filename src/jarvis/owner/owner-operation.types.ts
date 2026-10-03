import { PermissionLevel } from '../permissions/permission.types';

export type JarvisOwnerOperationStatus =
  | 'STARTED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DENIED';

export interface JarvisOwnerOperation {
  id: string;
  ownerId: string;
  userId: string;
  agent: string;
  toolId: string;
  intent: string;
  permission: PermissionLevel;
  approved: boolean;
  status: JarvisOwnerOperationStatus;
  request?: unknown;
  result?: unknown;
  error?: string | null;
  startedAt: Date;
  completedAt?: Date | null;
  createdAt: Date;
}

export interface StartOwnerOperationInput {
  ownerId: string;
  userId: string;
  agent: string;
  toolId: string;
  intent: string;
  permission: PermissionLevel;
  approved?: boolean;
  request?: unknown;
}
