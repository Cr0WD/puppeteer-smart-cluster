# 🔁 puppeteer-smart-cluster

[![package version](https://img.shields.io/npm/v/puppeteer-smart-cluster.svg?style=flat-square)](https://www.npmjs.com/package/puppeteer-smart-cluster)
[![package downloads](https://img.shields.io/npm/dm/puppeteer-smart-cluster.svg?style=flat-square)](https://www.npmjs.com/package/puppeteer-smart-cluster)
[![package license](https://img.shields.io/npm/l/puppeteer-smart-cluster.svg?style=flat-square)](https://www.npmjs.com/package/puppeteer-smart-cluster)


⚡ A minimal, resilient, and proxy-aware Puppeteer cluster engine for parallel scraping tasks.

## ✨ Features

- ✅ Minimal setup, no configuration boilerplate
- 🧠 Smart concurrency and task retries
- 🌍 Built-in support for per-instance proxies (`string` or `async function`)
- ⚙️ Works with custom Puppeteer builds or plugin wrappers
- 🧹 Automatically manages browser and page lifecycle
- 💤 Gracefully shuts down when idle

---

## 📦 Installation

### Using Yarn:

```bash
yarn add puppeteer puppeteer-smart-cluster
```

### Or with npm:

```bash
npm install puppeteer puppeteer-smart-cluster
```

> `puppeteer` is a peer dependency.

---

## 🚀 Quick Start

```ts
import puppeteer from 'puppeteer'
import CreateSmartCluster from 'puppeteer-smart-cluster'

const cluster = CreateSmartCluster<{ url: string }>({
	maxWorkers: 3,
	puppeteerInstance: puppeteer,
	puppeteerOptions: {
		args: ['--no-sandbox'],
	},
	proxy: 'http://username:password@proxyhost:port', // or async (params) => 'proxy'
	debug: true,
})

cluster.on.error((err, params) => {
	console.error('Task failed:', err, params)
})

cluster.start()

const urls = ['https://example.com', 'https://github.com', 'https://npmjs.com']

for (const url of urls) {
	cluster.addTask(async ({ page, props }) => {
		await page.goto(props.url)
		const title = await page.title()
		console.log(`${props.url} → ${title}`)
	}, { url })
}

await cluster.idle()
```

---

## 🔐 Proxy Support

`puppeteer-smart-cluster` allows you to assign a different proxy to each browser instance via a simple config option:

```ts
proxy: async ({ url }) => {
	// Rotate proxies dynamically
	return getProxyFromPool() // → 'http://user:pass@proxy:port'
}
```

Or use a static proxy string:

```ts
proxy: 'http://user:pass@proxy:port'
```

The proxy is injected into each Puppeteer launch via `--proxy-server` automatically.

---

## 🔄 Comparison with [`puppeteer-cluster`](https://www.npmjs.com/package/puppeteer-cluster)

Both libraries offer powerful tools for parallelizing Puppeteer tasks — but follow different philosophies:

- **`puppeteer-cluster`** is a versatile job queue with reusable browser contexts and built-in progress monitoring.
- **`puppeteer-smart-cluster`** is minimal and focused: it gives you predictable, isolated browser execution with out-of-the-box proxy support.

| Feature                        | `puppeteer-smart-cluster`                                | `puppeteer-cluster`                    |
|--------------------------------|----------------------------------------------------------|----------------------------------------|
| 🧠 Execution model             | Simple task queue with isolated browser per task	        | Queue-based, shared browsers optional  |
| 🌍 Per-instance proxy support  | Built-in (`string` or `() => string \| Promise<string>`) | Requires manual integration            |
| 🧼 Auto browser & page cleanup | Included                                                 | Requires manual handling in some cases |
| 🔁 Task retries                | Failed tasks are automatically re-queued                 | Retry logic handled manually           |
| 📊 Monitoring & progress UI    | Minimal debug output if needed (you control logging)     | Built-in dashboard and job stats       |
| 🎯 Concurrency control         | Not exposed — runs `maxWorkers` parallel browsers        | Fine-grained concurrency configuration |

**Use `puppeteer-cluster`** for advanced orchestration, persistent contexts, or when you need to fine-tune concurrency.  
**Choose `puppeteer-smart-cluster`** if you want a focused, proxy-friendly, and easy-to-use system that just works.

---

## ⚙️ API

### `CreateSmartCluster<T>(options: ClusterOptions<T>)`

```ts
type TaskFunction<T> = (params: {
	page: puppeteer.Page
	props: T
	proxy?: string
}) => Promise<void>
```

| Option                | Type                                  | Description |
|-----------------------|---------------------------------------|-------------|
| `maxWorkers`          | `number`                              | Max concurrent browsers |
| `proxy?`              | `string \| (params: T) => Promise<string>` | Static or per-task proxy |
| `puppeteerOptions?`   | `puppeteer.LaunchOptions`             | Passed to `puppeteer.launch()` |
| `puppeteerInstance?`  | `typeof puppeteer`                    | Custom Puppeteer instance |
| `poolingTime?`        | `number`                              | Poll interval in ms (default: `500`) |
| `iterationsBeforeStop?` | `number`                            | Empty loop rounds before stopping (default: `1`) |
| `debug?`              | `boolean`                             | Enable debug logs |
| `showStatus?`         | `boolean`                             | Log task queue/browser status every tick |

---

## 🧼 Cleanup & Shutdown

Use `.idle()` to wait until all tasks complete:

```ts
await cluster.idle()
```

Or stop the cluster manually:

```ts
await cluster.stop()
```

---

## 🪪 License

[MIT](./LICENSE) — © [Denis Orlov](https://github.com/Cr0WD)

---

## 🙋‍♂️ Questions or ideas?

Open an [issue](https://github.com/Cr0WD/puppeteer-smart-cluster/issues) or contribute via PR.
