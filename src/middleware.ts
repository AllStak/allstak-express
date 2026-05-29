/**
 * Express auto-integration middlewares for AllStak.
 *
 * These wrap the public `@allstak/js` surface (`AllStak.captureException`,
 * `AllStak.captureRequest`, `AllStak.startSpan`, trace context) — they never
 * reach into SDK internals — so the package tracks the published `@allstak/js`
 * contract and nothing else.
 *
 *   import { requestHandler, errorHandler } from '@allstak/express';
 *
 *   app.use(requestHandler());   // FIRST — opens the request span
 *   // ... your routes ...
 *   app.use(errorHandler());     // LAST — captures thrown/forwarded errors
 *
 * Both middlewares are fail-open: if AllStak has not been initialised, or if a
 * capture throws, the customer's request still completes normally.
 */
import { AllStak } from '@allstak/js';
import type { Span } from '@allstak/js';

// Minimal Express type-shapes. We do not hard-depend on `@types/express` at
// runtime — customers who have it installed get full inference for free, and
// the shapes below keep us self-typed when they do not.
export interface AllStakExpressRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  path?: string;
  route?: { path?: string | RegExp | Array<string | RegExp> };
  baseUrl?: string;
  hostname?: string;
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: { id?: string | number; email?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface AllStakExpressResponse {
  statusCode?: number;
  setHeader?(name: string, value: string | number | readonly string[]): unknown;
  on(event: string, listener: () => void): unknown;
  [k: string]: unknown;
}

export type AllStakNextFunction = (err?: unknown) => void;

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
]);

type NormalizedMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS';

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function methodOf(req: AllStakExpressRequest): NormalizedMethod {
  const m = (req.method || 'GET').toUpperCase();
  return (HTTP_METHODS.has(m) ? m : 'GET') as NormalizedMethod;
}

/** Concrete path with the query string stripped, for stable grouping. */
function pathOf(req: AllStakExpressRequest): string {
  const raw = req.originalUrl ?? req.url ?? req.path ?? '/';
  const qIdx = raw.indexOf('?');
  return qIdx >= 0 ? raw.substring(0, qIdx) : raw;
}

function hostOf(req: AllStakExpressRequest): string {
  if (req.hostname) return req.hostname;
  const h = req.headers?.host;
  if (typeof h === 'string') return h;
  return 'unknown';
}

/**
 * The matched route *pattern* (e.g. `/users/:id`), not the concrete URL.
 * Falls back to `baseUrl` (router mount point) and finally the concrete path
 * so a span is always named even before the router resolves `req.route`.
 */
function routeTemplateOf(req: AllStakExpressRequest): string | undefined {
  const routePath = req.route?.path;
  const route = Array.isArray(routePath)
    ? routePath.map(String).join('|')
    : routePath != null
      ? String(routePath)
      : undefined;
  if (route) return `${req.baseUrl ?? ''}${route}`;
  if (req.baseUrl) return req.baseUrl;
  return undefined;
}

function userAgentOf(req: AllStakExpressRequest): string | undefined {
  return firstHeader(req.headers?.['user-agent']);
}

function userFromRequest(
  req: AllStakExpressRequest,
): { id?: string; email?: string } | null {
  const u = req.user;
  if (!u || typeof u !== 'object') return null;
  const id = u.id != null ? String(u.id) : undefined;
  const email = typeof u.email === 'string' ? u.email : undefined;
  if (!id && !email) return null;
  return { id, email };
}

/** Trace id from an inbound W3C `traceparent`, if well-formed. */
function traceIdFromTraceparent(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Read the inbound trace id from AllStak headers first, then W3C
 * `traceparent`. Returns `undefined` when the caller did not propagate one.
 */
function inboundTraceId(req: AllStakExpressRequest): string | undefined {
  const headers = req.headers ?? {};
  return (
    firstHeader(headers['x-allstak-trace-id']) ??
    firstHeader(headers['x-trace-id']) ??
    traceIdFromTraceparent(firstHeader(headers['traceparent']))
  );
}

/** Read the inbound request id, if the caller propagated one. */
function inboundRequestId(req: AllStakExpressRequest): string | undefined {
  const headers = req.headers ?? {};
  return (
    firstHeader(headers['x-request-id']) ??
    firstHeader(headers['x-allstak-request-id'])
  );
}

export interface RequestHandlerOptions {
  /**
   * Logical service name recorded on request rows / spans. Defaults to
   * whatever was configured at `AllStak.init`.
   */
  serviceName?: string;
}

/**
 * Mount this BEFORE your routes. It:
 *   - reads the inbound trace id from `traceparent` / AllStak trace headers and
 *     sets it as the active trace via `AllStak.setTraceId`,
 *   - opens an inbound request span named by the route *pattern* (not the
 *     concrete URL),
 *   - on response `finish`, records the request through
 *     `AllStak.captureRequest` with the final status code and round-trip
 *     duration and finishes the span.
 *
 * Fully fail-open: a missing init or a capture error never breaks the request.
 */
export function requestHandler(_options: RequestHandlerOptions = {}) {
  return function allstakRequestHandler(
    req: AllStakExpressRequest,
    res: AllStakExpressResponse,
    next: AllStakNextFunction,
  ): void {
    // No init → pass straight through.
    if (!AllStak._getInstance()) {
      next();
      return;
    }

    const start = Date.now();
    const method = methodOf(req);
    const host = hostOf(req);
    let span: Span | null = null;

    try {
      // Honour upstream trace propagation so the inbound work joins the
      // caller's distributed trace.
      const upstreamTrace = inboundTraceId(req);
      if (upstreamTrace) {
        AllStak.setTraceId(upstreamTrace);
      }
      const requestId = inboundRequestId(req);
      const traceId = AllStak.getTraceId();
      // Name the span by the route pattern when known; at request entry the
      // router has not matched yet, so fall back to the concrete path. The
      // span is renamed to the resolved pattern on `finish` via a tag.
      const earlyName = routeTemplateOf(req) ?? pathOf(req);
      span = AllStak.startSpan(`${method} ${earlyName}`, {
        description: `HTTP ${method} ${earlyName}`,
        op: 'http.server',
        platform: 'node',
        tags: {
          'http.method': method,
          'http.host': host,
          ...(requestId ? { 'http.request_id': requestId } : {}),
        },
        attributes: {
          'http.method': method,
          'http.host': host,
          'http.target': pathOf(req),
        },
      });

      try {
        res.setHeader?.('x-allstak-trace-id', traceId);
        if (requestId) res.setHeader?.('x-allstak-request-id', requestId);
      } catch {
        /* headers already sent / unsupported response — best effort */
      }

      let finalized = false;
      const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        try {
          const durationMs = Date.now() - start;
          const statusCode = res.statusCode ?? 0;
          // At finish the router has matched, so the route *pattern* is now
          // available — this is the stable, low-cardinality span/request name.
          const routeTemplate = routeTemplateOf(req) ?? pathOf(req);
          const u = userFromRequest(req);
          if (u) {
            try {
              AllStak.setUser(u);
            } catch {
              /* best effort */
            }
          }

          AllStak.captureRequest({
            traceId,
            requestId,
            spanId: span?.spanId,
            direction: 'inbound',
            method,
            host,
            path: routeTemplate,
            statusCode,
            durationMs,
            userId: u?.id,
            timestamp: new Date(start).toISOString(),
          });

          if (span) {
            try {
              span.setTag('http.route', routeTemplate);
              span.setTag('http.status_code', String(statusCode));
              span.finish(statusCode >= 500 ? 'error' : 'ok');
            } catch {
              /* best effort */
            }
          }
          try {
            AllStak.resetTrace();
          } catch {
            /* best effort */
          }
        } catch {
          /* never break the response */
        }
      };

      res.on('finish', finalize);
      res.on('close', finalize);
    } catch {
      /* never break the request pipeline */
    }

    next();
  };
}

/** Alias for {@link requestHandler}. */
export const middleware = requestHandler;

/**
 * Mount this AFTER your routes. Express recognises the 4-arg
 * `(err, req, res, next)` signature as error-handling middleware. It forwards
 * the error to `AllStak.captureException` with method / path / statusCode /
 * userAgent in `requestContext`, then calls `next(err)` so the customer's own
 * error handling still runs.
 *
 * Fully fail-open: a missing init or a capture error never stops the error
 * from propagating.
 */
export function errorHandler() {
  return function allstakErrorHandler(
    err: unknown,
    req: AllStakExpressRequest,
    res: AllStakExpressResponse,
    next: AllStakNextFunction,
  ): void {
    try {
      if (AllStak._getInstance()) {
        const e = err instanceof Error ? err : new Error(String(err));
        const method = methodOf(req);
        const path = routeTemplateOf(req) ?? pathOf(req);
        const host = hostOf(req);
        const statusCode = res.statusCode && res.statusCode >= 400 ? res.statusCode : 500;
        const u = userFromRequest(req);
        if (u) {
          try {
            AllStak.setUser(u);
          } catch {
            /* best effort */
          }
        }

        AllStak.captureException(e, {
          traceId: AllStak.getTraceId(),
          spanId: AllStak.getCurrentSpanId() ?? undefined,
          transaction: `${method} ${path}`,
          requestContext: {
            method,
            path,
            host,
            statusCode,
            userAgent: userAgentOf(req),
          },
        });
      }
    } catch {
      /* never break the error pipeline */
    }
    next(err);
  };
}
