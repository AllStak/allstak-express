# Changelog

All notable changes to @allstak/express will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0] — 2026-05-29

Initial beta release. `@allstak/express` is a thin Express auto-integration that
wraps the public `@allstak/js` surface — it adds no transport, redaction, or
batching of its own and tracks the published `@allstak/js` contract directly.

### Added — Request-span middleware
- `requestHandler()` (alias `middleware()`) opens an inbound request span via
  `AllStak.startSpan` and records the request through `AllStak.captureRequest`
  on response `finish`/`close`, with the final status code and round-trip
  duration. Spans and request rows are named by the matched **route pattern**
  (`req.route?.path` / `req.baseUrl`, e.g. `/users/:id`) rather than the
  concrete URL, keeping cardinality low.

### Added — Trace propagation
- Reads the inbound trace id from `X-AllStak-Trace-Id` / `X-Trace-Id` and the
  W3C `traceparent` header and adopts it via `AllStak.setTraceId`, so inbound
  work joins the caller's distributed trace. The resolved trace id is stamped
  back onto the response as `x-allstak-trace-id`.

### Added — Error-capture middleware
- `errorHandler()` is an Express error-handling middleware
  (`(err, req, res, next)`) that forwards thrown and `next(err)`-forwarded
  errors to `AllStak.captureException` with `method` / `path` / `statusCode` /
  `userAgent` in `requestContext`, then calls `next(err)` so the customer's own
  error handling still runs.

### Added — One-line setup
- `setup()` / `allstakExpress(app, options)` initialises `@allstak/js` and wires
  both middlewares in the correct order (request handler first, error handler
  last). `init: false` skips initialisation for apps that already called
  `AllStak.init`.

### Added — Re-exported SDK surface
- The full `@allstak/js` public surface (`AllStak`, `Scope`, tracing types,
  integrations) is re-exported so a single import covers most apps.

### Notes
- Every code path is **fail-open**: a missing init or a capture error never
  breaks the customer's request or error pipeline.
- `express` is a peer dependency (`>=4.0.0`); `@allstak/js` (`^0.3.0`) is a
  runtime dependency.
