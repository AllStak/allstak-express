# @allstak/express

AllStak SDK for Express. A thin auto-integration that wraps
[`@allstak/js`](https://www.npmjs.com/package/@allstak/js): a request-span
middleware, an error-capture middleware, inbound trace propagation, and a
one-line setup.

## Install

```bash
npm install @allstak/express @allstak/js
```

Peer dependency:

```bash
npm install express
```

## One-line setup

```ts
import express from 'express';
import { allstakExpress } from '@allstak/express';

const app = express();

// Inits @allstak/js and mounts the request handler FIRST + error handler LAST.
allstakExpress(app, {
  apiKey: process.env.ALLSTAK_API_KEY,
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.ALLSTAK_RELEASE,
  serviceName: 'api',
});

app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id });
});

app.listen(3000);
```

Because Express error-handling middleware must run after every route, `setup`
mounts the request handler first and appends the error handler. For the common
"setup before routes" order this is correct. If you register routes in a way
that needs full control, pass `mountErrorHandler: false` and mount the returned
handler yourself as the final `app.use`:

```ts
const { errorHandler } = allstakExpress(app, {
  apiKey: process.env.ALLSTAK_API_KEY,
  mountErrorHandler: false,
});

// ... your routes ...

app.use(errorHandler); // LAST
```

## Manual wiring

```ts
import express from 'express';
import { AllStak } from '@allstak/js';
import { requestHandler, errorHandler } from '@allstak/express';

AllStak.init({ apiKey: process.env.ALLSTAK_API_KEY });

const app = express();

app.use(requestHandler()); // FIRST — opens the request span
// ... your routes ...
app.use(errorHandler());   // LAST — captures thrown / next(err) errors
```

`middleware()` is an alias for `requestHandler()`.

## What is captured

- Inbound HTTP request telemetry on response finish: method, route pattern,
  status code, and round-trip duration via `AllStak.captureRequest`.
- A server span per request (`http.server`) named by the route pattern.
- Unhandled and `next(err)`-forwarded errors via `AllStak.captureException`,
  with `method` / `path` / `statusCode` / `userAgent` in `requestContext`.
- Inbound trace adoption from `X-AllStak-Trace-Id` / `X-Trace-Id` / W3C
  `traceparent`, with the resolved trace id stamped back on the response.

## Route-pattern naming

Spans and request rows are named by the matched route *pattern*
(`req.route?.path`, e.g. `/users/:id`), prefixed by the router mount point
(`req.baseUrl`) — never the concrete URL (`/users/42`). This keeps telemetry
cardinality low and groupable.

## Options

`allstakExpress(app, options)` accepts every `@allstak/js` `init` option plus:

| Option | Description |
| --- | --- |
| `apiKey` | Project API key. Required unless `init: false`. |
| `environment` | Deployment environment. |
| `release` | App version or commit SHA. |
| `serviceName` | Logical service name. |
| `init` | Call `AllStak.init`. Default `true`. Set `false` if you already initialised `@allstak/js`. |
| `mountErrorHandler` | Auto-mount the error handler as the final `app.use`. Default `true`. |
| `request` | Options forwarded to the request-handler middleware. |

## Reliability

Every code path is fail-open. A missing `AllStak.init`, a capture error, or an
ingest outage never breaks the customer's request or error pipeline.

## Contributing and Support

- Report bugs with the GitHub bug report template: https://github.com/AllStak/allstak-express/issues/new/choose
- Open pull requests using the checklist in [CONTRIBUTING.md](CONTRIBUTING.md).
- Report security vulnerabilities privately through [SECURITY.md](SECURITY.md).

## License

MIT
