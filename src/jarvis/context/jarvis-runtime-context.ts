/**
 * Runtime identity and resource context for a JARVIS operation.
 *
 * ownerId/userId identify the authenticated JARVIS operator.
 * merchantId identifies the Stackaura resource currently in scope.
 *
 * merchantId is optional at the runtime boundary so JARVIS can
 * eventually operate on non-merchant resources without making the
 * owner identity itself merchant-dependent.
 */
export interface JarvisRuntimeContext {
  ownerId: string;
  userId: string;
  merchantId?: string;
}
