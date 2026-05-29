/**
 * One-line wiring for Express applications.
 *
 *   import express from 'express';
 *   import { allstakExpress } from '@allstak/express';
 *
 *   const app = express();
 *   allstakExpress(app, { apiKey: process.env.ALLSTAK_API_KEY });
 *
 *   app.get('/users/:id', handler);
 *   // ... routes ...
 *   // (error handler is mounted for you on `setup`; see options below)
 *
 * `setup` initialises `@allstak/js` (unless `init: false`) and mounts the
 * request-span middleware FIRST. Because Express error-handling middleware must
 * run AFTER all routes, the error handler cannot be mounted at setup time
 * without sitting before your routes — so `setup` returns it for you to mount
 * last, and also auto-mounts a deferred copy via `app.use` only when
 * `mountErrorHandler` is left enabled (it is appended after the current
 * middleware stack, which for the common "setup first, routes after" order is
 * correct). When in doubt, mount the returned `errorHandler` yourself as the
 * final `app.use`.
 */
import { AllStak } from '@allstak/js';
import type { AllStakConfig } from '@allstak/js';
import {
  errorHandler,
  requestHandler,
  type AllStakNextFunction,
  type AllStakExpressRequest,
  type AllStakExpressResponse,
  type RequestHandlerOptions,
} from './middleware';
import { SDK_NAME, SDK_VERSION } from './version';

/** Minimal shape of the Express `app` we rely on. */
export interface AllStakExpressApp {
  use(
    handler:
      | ((req: AllStakExpressRequest, res: AllStakExpressResponse, next: AllStakNextFunction) => void)
      | ((
          err: unknown,
          req: AllStakExpressRequest,
          res: AllStakExpressResponse,
          next: AllStakNextFunction,
        ) => void),
  ): unknown;
  [k: string]: unknown;
}

export interface AllStakExpressOptions extends Partial<AllStakConfig> {
  /**
   * Call `AllStak.init` with these options. Default `true`. Set `false` if you
   * already initialised `@allstak/js` elsewhere and only want the middlewares
   * wired.
   */
  init?: boolean;
  /**
   * Auto-mount the error handler as the final `app.use`. Default `true`. When
   * `false`, mount the returned `errorHandler` yourself after your routes.
   */
  mountErrorHandler?: boolean;
  /** Forwarded to the request-handler middleware. */
  request?: RequestHandlerOptions;
}

export interface AllStakExpressHandlers {
  /** The request-span middleware that was mounted first. */
  requestHandler: ReturnType<typeof requestHandler>;
  /**
   * The error-capture middleware. Auto-mounted unless
   * `mountErrorHandler: false`; always returned so callers can mount it last
   * themselves.
   */
  errorHandler: ReturnType<typeof errorHandler>;
}

/**
 * Initialise AllStak and wire the Express middlewares in the correct order:
 * the request handler is mounted FIRST, and the error handler LAST.
 */
export function setup(
  app: AllStakExpressApp,
  options: AllStakExpressOptions = {},
): AllStakExpressHandlers {
  const { init = true, mountErrorHandler = true, request, ...config } = options;

  if (init) {
    if (!config.apiKey) {
      throw new Error('allstakExpress: `apiKey` is required unless `init: false` is passed.');
    }
    AllStak.init(config as AllStakConfig);
    // Stamp the SDK identity so ingest sees `@allstak/express` as the origin.
    try {
      AllStak.setIdentity({ sdkName: SDK_NAME, sdkVersion: SDK_VERSION, platform: 'node' });
    } catch {
      /* best effort */
    }
  }

  const onRequest = requestHandler(request);
  const onError = errorHandler();

  // Request handler FIRST.
  app.use(onRequest);

  // Error handler LAST. Appended after the current stack so, for the
  // recommended "setup before routes" usage, it still runs after routes that
  // were registered between setup and the first error.
  if (mountErrorHandler) {
    app.use(onError);
  }

  return { requestHandler: onRequest, errorHandler: onError };
}

/**
 * Functional alias matching the naming of the other AllStak framework
 * auto-integrations: `allstakExpress(app, options)`.
 */
export const allstakExpress = setup;
