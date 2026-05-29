/**
 * Behavioural tests for @allstak/express against a real Express 4 app.
 *
 * We mock the public `@allstak/js` surface (the only thing this package
 * touches) so we can assert exactly which capture calls the middlewares make,
 * then drive a real `express()` instance via `supertest` so the route matcher,
 * error-handling dispatch, and `res` lifecycle are the genuine framework ones.
 *
 * Asserts:
 *   1. the error middleware forwards to `captureException` AND calls `next(err)`
 *      so the customer's handler still runs;
 *   2. the request middleware records the request via `captureRequest` with the
 *      route-template path (`/users/:id`, not `/users/42`);
 *   3. the inbound trace id is read from request headers and adopted;
 *   4. fail-open — when a capture throws, the request still completes.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mock @allstak/js public surface -------------------------------------

interface CapturedException {
  error: Error;
  context: Record<string, unknown> | undefined;
}
interface CapturedRequest {
  [k: string]: unknown;
}

const state = {
  inited: true,
  traceId: 'tid-default-0000000000000000000000',
  spanFinishes: [] as Array<'ok' | 'error' | 'timeout'>,
  exceptions: [] as CapturedException[],
  requests: [] as CapturedRequest[],
  captureRequestThrows: false,
};

function makeSpan() {
  return {
    spanId: 'span-abcdef0123456789',
    setTag: vi.fn(),
    finish: vi.fn((status: 'ok' | 'error' | 'timeout' = 'ok') => {
      state.spanFinishes.push(status);
    }),
  };
}

vi.mock('@allstak/js', () => {
  const AllStak = {
    _getInstance: () => (state.inited ? {} : null),
    init: vi.fn(),
    setIdentity: vi.fn(),
    setUser: vi.fn(),
    setTraceId: vi.fn((id: string) => {
      state.traceId = id;
    }),
    getTraceId: vi.fn(() => state.traceId),
    getCurrentSpanId: vi.fn(() => 'span-abcdef0123456789'),
    resetTrace: vi.fn(),
    startSpan: vi.fn(() => makeSpan()),
    captureRequest: vi.fn((item: CapturedRequest) => {
      if (state.captureRequestThrows) throw new Error('ingest exploded');
      state.requests.push(item);
    }),
    captureException: vi.fn((error: Error, context?: Record<string, unknown>) => {
      state.exceptions.push({ error, context });
    }),
  };
  return { AllStak, default: AllStak };
});

// Import AFTER the mock is registered.
import { allstakExpress, errorHandler, requestHandler } from '../src/index';

beforeEach(() => {
  state.inited = true;
  state.traceId = 'tid-default-0000000000000000000000';
  state.spanFinishes = [];
  state.exceptions = [];
  state.requests = [];
  state.captureRequestThrows = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

function buildApp(): Express {
  const app = express();
  // Our middlewares are typed against minimal Express shapes; cast to the
  // framework's RequestHandler when mounting on a real app.
  app.use(requestHandler() as never);

  app.get('/users/:id', (req: Request, res: Response) => {
    res.status(200).json({ id: req.params.id });
  });

  app.get('/boom', (_req: Request, _res: Response, next: NextFunction) => {
    next(new Error('intentional boom'));
  });

  const customerHandlerHits: string[] = [];
  (app as unknown as { _customerHits: string[] })._customerHits = customerHandlerHits;

  app.use(errorHandler() as never);
  // Customer's own error handler — must still run because errorHandler calls next(err).
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    customerHandlerHits.push(err.message);
    res.status(500).json({ error: err.message });
  });

  return app;
}

describe('@allstak/express request middleware', () => {
  it('records the request with the route-template path, not the concrete URL', async () => {
    const app = buildApp();
    const res = await request(app).get('/users/42').expect(200);
    expect(res.body).toEqual({ id: '42' });

    expect(state.requests).toHaveLength(1);
    const row = state.requests[0];
    expect(row.path).toBe('/users/:id');
    expect(row.method).toBe('GET');
    expect(row.statusCode).toBe(200);
    expect(row.direction).toBe('inbound');
    expect(row.spanId).toBe('span-abcdef0123456789');
    // span finished as ok for a 2xx
    expect(state.spanFinishes).toEqual(['ok']);
  });

  it('reads the inbound trace id from AllStak headers and adopts it', async () => {
    const app = buildApp();
    const inbound = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await request(app)
      .get('/users/7')
      .set('x-allstak-trace-id', inbound)
      .expect(200);

    expect(res.headers['x-allstak-trace-id']).toBe(inbound);
    expect(state.requests[0].traceId).toBe(inbound);
  });

  it('reads the inbound trace id from a W3C traceparent header', async () => {
    const app = buildApp();
    const traceId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await request(app)
      .get('/users/7')
      .set('traceparent', `00-${traceId}-cccccccccccccccc-01`)
      .expect(200);

    expect(state.requests[0].traceId).toBe(traceId);
  });

  it('fail-open: when captureRequest throws, the request still completes', async () => {
    state.captureRequestThrows = true;
    const app = buildApp();
    const res = await request(app).get('/users/99').expect(200);
    expect(res.body).toEqual({ id: '99' });
    // capture threw, so nothing was recorded — but the response is intact.
    expect(state.requests).toHaveLength(0);
  });

  it('passes straight through when AllStak is not initialised', async () => {
    state.inited = false;
    const app = buildApp();
    const res = await request(app).get('/users/1').expect(200);
    expect(res.body).toEqual({ id: '1' });
    expect(state.requests).toHaveLength(0);
  });
});

describe('@allstak/express error middleware', () => {
  it('forwards to captureException and calls next(err) so the customer handler runs', async () => {
    const app = buildApp();
    const res = await request(app).get('/boom').expect(500);
    expect(res.body).toEqual({ error: 'intentional boom' });

    // captureException was called with the thrown error.
    expect(state.exceptions).toHaveLength(1);
    expect(state.exceptions[0].error.message).toBe('intentional boom');

    // requestContext carries method/path/statusCode/userAgent.
    const ctx = state.exceptions[0].context as {
      requestContext?: { method?: string; path?: string; statusCode?: number; userAgent?: string };
    };
    expect(ctx.requestContext?.method).toBe('GET');
    expect(ctx.requestContext?.path).toBe('/boom');
    expect(ctx.requestContext?.statusCode).toBe(500);

    // next(err) ran the customer's error handler.
    const hits = (app as unknown as { _customerHits: string[] })._customerHits;
    expect(hits).toEqual(['intentional boom']);
  });

  it('fail-open: when captureException throws, the error still propagates to the customer handler', async () => {
    const app = buildApp();
    // Make captureException blow up.
    const { AllStak } = await import('@allstak/js');
    (AllStak.captureException as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('capture exploded');
    });

    const res = await request(app).get('/boom').expect(500);
    expect(res.body).toEqual({ error: 'intentional boom' });
    const hits = (app as unknown as { _customerHits: string[] })._customerHits;
    expect(hits).toEqual(['intentional boom']);
  });
});

describe('@allstak/express setup()', () => {
  it('allstakExpress(app, opts) inits AllStak and wires both middlewares (request first)', async () => {
    const { AllStak } = await import('@allstak/js');
    const useOrder: string[] = [];
    const app = {
      use: vi.fn((fn: { name?: string }) => {
        useOrder.push(fn.name || 'anon');
      }),
    };

    const handlers = allstakExpress(app as never, { apiKey: 'ask_test_key', environment: 'test' });

    expect(AllStak.init).toHaveBeenCalledTimes(1);
    expect((AllStak.init as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      apiKey: 'ask_test_key',
      environment: 'test',
    });
    // request handler mounted first, error handler last.
    expect(useOrder).toEqual(['allstakRequestHandler', 'allstakErrorHandler']);
    expect(typeof handlers.requestHandler).toBe('function');
    expect(typeof handlers.errorHandler).toBe('function');
  });

  it('throws when apiKey is missing and init is requested', () => {
    const app = { use: vi.fn() };
    expect(() => allstakExpress(app as never, {})).toThrow(/apiKey/);
  });

  it('init:false wires middlewares without calling AllStak.init', async () => {
    const { AllStak } = await import('@allstak/js');
    const app = { use: vi.fn() };
    allstakExpress(app as never, { init: false });
    expect(AllStak.init).not.toHaveBeenCalled();
    expect((app.use as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});
