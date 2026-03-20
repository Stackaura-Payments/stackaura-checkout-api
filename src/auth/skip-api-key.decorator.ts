import { SetMetadata } from '@nestjs/common';

export const SKIP_API_KEY_GUARD = 'skipApiKeyGuard';
export const SkipApiKeyGuard = () => SetMetadata(SKIP_API_KEY_GUARD, true);
