# 🔁 puppeteer-smart-cluster

[![package version](https://img.shields.io/npm/v/puppeteer-smart-cluster.svg?style=flat-square)](https://www.npmjs.com/package/puppeteer-smart-cluster)
[![package downloads](https://img.shields.io/npm/dm/puppeteer-smart-cluster.svg?style=flat-square)](https://www.npmjs.com/package/puppeteer-smart-cluster)
[![package license](https://img.shields.io/npm/l/puppeteer-smart-cluster.svg?style=flat-square)](https://www.npmjs.com/package/puppeteer-smart-cluster)

A small, proxy-aware Puppeteer task queue. Every attempt runs in an isolated browser, concurrency is bounded, retries are finite, and shutdown is explicit.

## Features

- Isolated browser per task attempt
- Static or per-attempt asynchronous proxies
- Configurable retry limit and backoff
- Deterministic `start()`, `idle()`, and `stop()` lifecycle
- Cooperative cancellation through `AbortSignal`
- Custom Puppeteer builds and wrappers
- Typed task and error contexts

## Installation

```bash
yarn add puppeteer puppeteer-smart-cluster
```

Or:

```bash
npm install puppeteer puppeteer-smart-cluster
```

`puppeteer` is a peer dependency. Node.js 18 or newer is required.

## Quick start

```ts
import CreateSmartCluster from 'puppeteer-smart-cluster'

const cluster = CreateSmartCluster<{ url: string }>({
	maxWorkers: 3,
	proxy: async ({ url }) => getProxyFor(url),
	retryLimit: 2,
	retryDelay: ({ attempt }) => 500 * 2 ** (attempt - 1),
})

cluster.on.error((error, parameters, context) => {
	console.error('Task attempt failed', { error, parameters, context })
})

for (const url of ['https://example.com', 'https://github.com']) {
	cluster.addTask(async ({ page, props, signal }) => {
		if (signal.aborted) return
		await page.goto(props.url)
		console.log(await page.title())
	}, { url })
}

cluster.start()
await cluster.idle()
```

Tasks may be added before or while the cluster is running. Call `start()` again after the cluster has automatically stopped. Repeated `start()` calls while it is running are safe.

## Retries and errors

`retryLimit` is the number of retries after the first attempt. It defaults to `3`, so a task can run at most four times. The default delay is exponential: 1, 2, 4 seconds, capped at 30 seconds.

Version 1.0 retried forever without a delay. If an existing application depends on that behavior, enable it explicitly:

```ts
retryLimit: Number.POSITIVE_INFINITY,
retryDelay: 0,
```

Use a fixed delay:

```ts
const cluster = CreateSmartCluster({
	maxWorkers: 2,
	retryLimit: 2,
	retryDelay: 250,
})
```

Or calculate it from the failed attempt:

```ts
retryDelay: ({ attempt, error, parameters, signal }) => {
	signal.throwIfAborted()
	return Math.min(1000 * 2 ** (attempt - 1), 30_000)
}
```

The error listener runs after every failed attempt. Its context contains:

```ts
interface TaskErrorContext {
	attempt: number
	retriesLeft: number
	willRetry: boolean
}
```

When `willRetry` is `false`, the task has reached a terminal failure. Listener failures are isolated from the queue.

## Proxy support

A proxy can be fixed for the whole cluster:

```ts
proxy: 'http://proxyhost:port'
```

Or selected for each attempt:

```ts
proxy: async (parameters, signal) => {
	signal.throwIfAborted()
	return getProxyFor(parameters)
}
```

The proxy is passed to Puppeteer as `--proxy-server=...` and exposed to the task as `proxy`.

For an authenticated HTTP proxy, keep credentials out of the browser process arguments:

```ts
proxy: {
	server: 'http://proxyhost:port',
	username: 'username',
	password: 'password',
}
```

The cluster applies these credentials with `page.authenticate()` before executing the task. For compatibility with 1.0, credentials inside a proxy URL are also accepted and are removed from the Chrome process arguments automatically.
Do not combine the `proxy` option with a manual `--proxy-server` launch argument.

## Compatibility with 1.0

Version 1.1 preserves the documented 1.0 API: existing cluster options, string and function proxies, task callbacks, `start()`, `addTask()`, `idle()`, `stop()`, and `on.error()` remain valid. New callback fields and error metadata are additive.

The intentional behavioral change is the default retry budget. Failed tasks now stop after three retries instead of retrying forever. Use the legacy retry configuration above when infinite retries are required. Native CommonJS and ESM imports now both work without changing existing default-import code.

## Lifecycle

`start()` begins dispatching queued tasks. It is idempotent while the cluster is running. `idle()` only waits; it never starts a stopped cluster.

`idle()` resolves when the current queue, active attempts, and retry delays are empty. Each call observes the current work, so it can be used across multiple task batches.

`stop()` clears queued tasks, aborts active task signals, closes active browsers, cancels retry delays, and waits for active task functions to settle. A task can react to cancellation:

```ts
cluster.addTask(async ({ page, props, signal }) => {
	signal.throwIfAborted()
	await page.goto(props.url)
}, { url })
```

Task functions should finish when their signal is aborted. Browser closure also interrupts most active Puppeteer operations.

After the queue becomes idle, the cluster automatically changes to the stopped state. The grace period is `poolingTime * iterationsBeforeStop` and defaults to 500 ms. This only changes lifecycle state; `idle()` resolves as soon as work is complete.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxWorkers` | `number` | required | Maximum concurrent browsers |
| `proxy` | `ProxyValue \| (parameters: T, signal: AbortSignal) => ProxyValue \| Promise<ProxyValue>` | none | Proxy source evaluated for each attempt |
| `puppeteerOptions` | `LaunchOptions` | none | Options passed to `puppeteer.launch()` |
| `puppeteerInstance` | `Partial<typeof puppeteer>` | Puppeteer | Custom Puppeteer implementation |
| `retryLimit` | `number` | `3` | Retries after the first attempt |
| `retryDelay` | `number \| RetryDelay<T>` | exponential | Delay before each retry |
| `poolingTime` | `number` | `500` | Idle grace period unit in milliseconds |
| `iterationsBeforeStop` | `number` | `1` | Number of idle grace period units |
| `debug` | `boolean` | `false` | Log task execution and cleanup errors |
| `showStatus` | `boolean` | `false` | Log dispatcher status |

Numeric options are validated when the cluster is created. A dynamic retry delay is validated before it is used.

## Development

```bash
yarn validate
```

This runs linting, formatting and type checks, a production build, and the test suite.

## License

[MIT](./LICENSE) © [Denis Orlov](https://github.com/Cr0WD)
