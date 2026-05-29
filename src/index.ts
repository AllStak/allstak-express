/**
 * @allstak/express — Express auto-integration for AllStak.
 *
 * Wraps `@allstak/js`:
 *   - `requestHandler()` / `middleware()` — opens an inbound request span,
 *     adopts the inbound trace id, and records the request on response finish
 *     (named by the route pattern, not the concrete URL).
 *   - `errorHandler()` — Express error-handling middleware that forwards thrown
 *     and `next(err)`-forwarded errors to `AllStak.captureException`, then
 *     calls `next(err)`.
 *   - `setup()` / `allstakExpress(app, options)` — one-line init + wiring in the
 *     correct order (request handler first, error handler last).
 *
 * The full `@allstak/js` public surface (`AllStak`, `Scope`, tracing types,
 * integrations, …) is re-exported so a single import covers most apps.
 */

// Express auto-integration surface.
export {
  requestHandler,
  middleware,
  errorHandler,
  type RequestHandlerOptions,
  type AllStakExpressRequest,
  type AllStakExpressResponse,
  type AllStakNextFunction,
} from './middleware';

export {
  setup,
  allstakExpress,
  type AllStakExpressApp,
  type AllStakExpressOptions,
  type AllStakExpressHandlers,
} from './setup';

export { SDK_NAME, SDK_VERSION } from './version';

// Re-export the @allstak/js surface so consumers can `AllStak.captureMessage`,
// `AllStak.setUser`, start spans, etc. without a second import.
export * from '@allstak/js';
export { AllStak, default as AllStakDefault } from '@allstak/js';

// Default export mirrors the functional auto-integration entrypoint used by the
// other AllStak framework SDKs.
import { allstakExpress } from './setup';
export default allstakExpress;
