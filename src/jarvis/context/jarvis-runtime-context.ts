/**
 * Authenticated owner identity for a JARVIS operation.
 *
 * Identity is derived exclusively from the authenticated session.
 * Request bodies and caller-supplied context must never be able
 * to override these values.
 */
export interface JarvisIdentity {
  ownerId: string;
  userId: string;
}

/**
 * Resource currently being operated on by JARVIS.
 *
 * Resources are deliberately separate from owner identity so
 * JARVIS can eventually operate on non-merchant resources such
 * as GitHub, Vercel, Supabase, Shopify, or platform infrastructure.
 */
export interface JarvisResourceContext {
  type: 'merchant';
  id: string;
}

/**
 * Runtime context for one JARVIS operation.
 *
 * Identity is always required.
 * Resource scope is optional at the runtime boundary.
 */
export interface JarvisRuntimeContext {
  identity: JarvisIdentity;
  resource?: JarvisResourceContext;
}
