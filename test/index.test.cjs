const assert = require('node:assert/strict')
const { test } = require('node:test')
const CreateSmartCluster = require('..')

const delay = milliseconds =>
	new Promise(resolve => {
		setTimeout(resolve, milliseconds)
	})

test('exposes native CommonJS and ESM entrypoints', async () => {
	assert.equal(typeof CreateSmartCluster, 'function')
	assert.equal(CreateSmartCluster.default, CreateSmartCluster)
	// The build creates the package self-reference before the tests run.
	// eslint-disable-next-line import-js/no-unresolved
	const esmModule = await import('puppeteer-smart-cluster')
	assert.equal(typeof esmModule.default, 'function')
})

const createPuppeteer = ({ withoutInitialPage = false } = {}) => {
	const launches = []
	const browsers = []
	let newPageCalls = 0

	const instance = {
		async launch(options) {
			launches.push(options)
			const page = {
				authenticateCalls: [],
				closeCalls: 0,
				async authenticate(credentials) {
					this.authenticateCalls.push(credentials)
				},
				async close() {
					this.closeCalls++
				},
			}
			const browser = {
				closeCalls: 0,
				page,
				async pages() {
					if (withoutInitialPage) return []
					return [page]
				},
				async newPage() {
					newPageCalls++
					return page
				},
				async close() {
					this.closeCalls++
				},
			}
			browsers.push(browser)
			return browser
		},
	}

	return {
		browsers,
		instance,
		launches,
		get newPageCalls() {
			return newPageCalls
		},
	}
}

test('validates numeric options', () => {
	const puppeteer = createPuppeteer()
	assert.throws(
		() => CreateSmartCluster({ maxWorkers: 0, puppeteerInstance: puppeteer.instance }),
		/maxWorkers/
	)
	assert.throws(
		() =>
			CreateSmartCluster({
				maxWorkers: 1,
				puppeteerInstance: puppeteer.instance,
				retryLimit: -1,
			}),
		/retryLimit/
	)
	assert.throws(
		() =>
			CreateSmartCluster({
				iterationsBeforeStop: 2,
				maxWorkers: 1,
				poolingTime: 2_147_483_647,
				puppeteerInstance: puppeteer.instance,
			}),
		/poolingTime \* iterationsBeforeStop/
	)
	assert.throws(
		() =>
			CreateSmartCluster({
				maxWorkers: 1,
				proxy: 'http://proxyhost:8080',
				puppeteerInstance: puppeteer.instance,
				puppeteerOptions: { args: ['--proxy-server=http://other-proxy:8080'] },
			}),
		/cannot be combined/
	)
})

test('limits concurrency and supports repeated idle cycles', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		maxWorkers: 2,
		poolingTime: 100,
		puppeteerInstance: puppeteer.instance,
	})
	let activeTasks = 0
	let maximumActiveTasks = 0
	let completedTasks = 0
	const task = async () => {
		activeTasks++
		maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks)
		await delay(5)
		activeTasks--
		completedTasks++
	}

	for (let index = 0; index < 5; index++) cluster.addTask(task, index)
	cluster.start()
	cluster.start()
	await cluster.idle()

	assert.equal(completedTasks, 5)
	assert.equal(maximumActiveTasks, 2)

	cluster.addTask(task, 6)
	await cluster.idle()
	assert.equal(completedTasks, 6)
	assert.equal(puppeteer.browsers.length, 6)
	assert.ok(puppeteer.browsers.every(browser => browser.closeCalls === 1))
	await cluster.stop()
})

test('bounds retries and reports attempt metadata', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
		retryDelay: 0,
		retryLimit: 2,
	})
	const errors = []
	cluster.on.error((error, parameters, context) => {
		errors.push({ error, parameters, context })
	})
	cluster.addTask(async () => {
		throw new Error('failure')
	}, 'task')

	cluster.start()
	await cluster.idle()

	assert.equal(puppeteer.launches.length, 3)
	assert.deepEqual(
		errors.map(item => item.context),
		[
			{ attempt: 1, retriesLeft: 2, willRetry: true },
			{ attempt: 2, retriesLeft: 1, willRetry: true },
			{ attempt: 3, retriesLeft: 0, willRetry: false },
		]
	)
	assert.ok(errors.every(item => item.error.message === 'failure'))
	assert.ok(errors.every(item => item.parameters === 'task'))
	await cluster.stop()
})

test('releases the worker slot while a retry is waiting', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
		retryDelay: 20,
		retryLimit: 1,
	})
	const executionOrder = []
	let firstTaskAttempts = 0
	cluster.addTask(async () => {
		firstTaskAttempts++
		executionOrder.push(`first-${firstTaskAttempts}`)
		if (firstTaskAttempts === 1) throw new Error('retry once')
	}, undefined)
	cluster.addTask(async () => {
		executionOrder.push('second')
	}, undefined)

	cluster.start()
	await cluster.idle()

	assert.deepEqual(executionOrder, ['first-1', 'second', 'first-2'])
	await cluster.stop()
})

test('re-evaluates proxies and creates a page when the browser has none', async () => {
	const puppeteer = createPuppeteer({ withoutInitialPage: true })
	let attempts = 0
	let proxyCalls = 0
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
		proxy: async () => {
			proxyCalls++
			return `http://proxy-${proxyCalls}`
		},
		retryDelay: 0,
		retryLimit: 1,
	})
	cluster.addTask(async ({ proxy, signal }) => {
		assert.equal(signal.aborted, false)
		attempts++
		assert.equal(proxy, `http://proxy-${attempts}`)
		if (attempts === 1) throw new Error('retry once')
	}, undefined)

	cluster.start()
	await cluster.idle()

	assert.equal(attempts, 2)
	assert.equal(proxyCalls, 2)
	assert.equal(puppeteer.newPageCalls, 2)
	assert.deepEqual(
		puppeteer.launches.map(options => options.args),
		[['--proxy-server=http://proxy-1'], ['--proxy-server=http://proxy-2']]
	)
	await cluster.stop()
})

test('authenticates proxies without exposing credentials in process arguments', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		proxy: {
			server: ' http://proxyhost:8080 ',
			username: 'username',
			password: 'password',
		},
		puppeteerInstance: puppeteer.instance,
	})
	cluster.addTask(async ({ proxy }) => {
		assert.equal(proxy, 'http://proxyhost:8080')
	}, undefined)

	cluster.start()
	await cluster.idle()

	assert.deepEqual(puppeteer.launches[0].args, ['--proxy-server=http://proxyhost:8080'])
	assert.deepEqual(puppeteer.browsers[0].page.authenticateCalls, [
		{ username: 'username', password: 'password' },
	])
	await cluster.stop()
})

test('supports authenticated proxy URLs from version 1.0', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		proxy: 'http://username:password@proxyhost:8080',
		puppeteerInstance: puppeteer.instance,
	})
	cluster.addTask(async ({ proxy }) => {
		assert.equal(proxy, 'http://proxyhost:8080/')
	}, undefined)

	cluster.start()
	await cluster.idle()

	assert.deepEqual(puppeteer.launches[0].args, ['--proxy-server=http://proxyhost:8080/'])
	assert.deepEqual(puppeteer.browsers[0].page.authenticateCalls, [
		{ username: 'username', password: 'password' },
	])
	await cluster.stop()
})

test('supports the infinite retry behavior from version 1.0', async () => {
	const puppeteer = createPuppeteer()
	let attempts = 0
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
		retryDelay: 0,
		retryLimit: Number.POSITIVE_INFINITY,
	})
	cluster.addTask(async () => {
		attempts++
		if (attempts < 3) throw new Error('retry')
	}, undefined)

	cluster.start()
	await cluster.idle()

	assert.equal(attempts, 3)
	await cluster.stop()
})

test('stop aborts active work and cancels retry backoff', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
		retryDelay: 60_000,
		retryLimit: 2,
	})
	let attempts = 0
	let firstFailure
	const failed = new Promise(resolve => {
		firstFailure = resolve
	})
	cluster.on.error(() => firstFailure())
	cluster.addTask(async () => {
		attempts++
		throw new Error('failure')
	}, undefined)

	cluster.start()
	await failed
	await cluster.stop()
	await cluster.idle()

	assert.equal(attempts, 1)
})

test('stop exposes cancellation to a running task', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
		retryLimit: 0,
	})
	let started
	const taskStarted = new Promise(resolve => {
		started = resolve
	})
	let receivedAbort = false
	cluster.addTask(async ({ signal }) => {
		started()
		await new Promise(resolve => {
			signal.addEventListener(
				'abort',
				() => {
					receivedAbort = true
					resolve()
				},
				{ once: true }
			)
		})
	}, undefined)

	cluster.start()
	await taskStarted
	await cluster.stop()

	assert.equal(receivedAbort, true)
})

test('stop exposes cancellation to the proxy resolver', async () => {
	const puppeteer = createPuppeteer()
	let proxyStarted
	const started = new Promise(resolve => {
		proxyStarted = resolve
	})
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
		proxy: async (parameters, signal) => {
			proxyStarted()
			await new Promise((resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
			return 'http://unused-proxy'
		},
	})
	let taskExecuted = false
	cluster.addTask(async () => {
		taskExecuted = true
	}, undefined)

	cluster.start()
	await started
	await cluster.stop()

	assert.equal(taskExecuted, false)
})

test('rejects lifecycle mutations while stop is in progress', async () => {
	const puppeteer = createPuppeteer()
	let taskStarted
	const started = new Promise(resolve => {
		taskStarted = resolve
	})
	let finishTask
	const taskFinished = new Promise(resolve => {
		finishTask = resolve
	})
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
	})
	cluster.addTask(async () => {
		taskStarted()
		await taskFinished
	}, undefined)
	cluster.start()
	await started

	const stopping = cluster.stop()
	assert.throws(() => cluster.start(), /while it is stopping/)
	assert.throws(() => cluster.addTask(async () => {}, undefined), /while the cluster is stopping/)
	finishTask()
	await stopping
})

test('stop clears tasks that have not started', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
	})
	let executed = false
	cluster.addTask(async () => {
		executed = true
	}, undefined)

	await cluster.stop()
	await cluster.idle()
	cluster.start()
	await cluster.idle()

	assert.equal(executed, false)
	await cluster.stop()
})

test('isolates failures thrown by the error listener', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
		retryDelay: 0,
		retryLimit: 1,
	})
	let attempts = 0
	cluster.on.error(() => {
		throw new Error('listener failure')
	})
	cluster.addTask(async () => {
		attempts++
		throw new Error('task failure')
	}, undefined)

	cluster.start()
	await cluster.idle()

	assert.equal(attempts, 2)
	await cluster.stop()
})

test('restarts cleanly after automatic shutdown', async () => {
	const puppeteer = createPuppeteer()
	const cluster = CreateSmartCluster({
		iterationsBeforeStop: 0,
		maxWorkers: 1,
		poolingTime: 0,
		puppeteerInstance: puppeteer.instance,
	})
	let completedTasks = 0
	const task = async () => {
		completedTasks++
	}

	cluster.addTask(task, undefined)
	cluster.start()
	await cluster.idle()
	await delay(5)

	cluster.addTask(task, undefined)
	await delay(5)
	assert.equal(completedTasks, 1)

	cluster.start()
	await cluster.idle()
	assert.equal(completedTasks, 2)
	await cluster.stop()
})

test('turns retry delay failures into terminal errors', async () => {
	const puppeteer = createPuppeteer()
	const errors = []
	const cluster = CreateSmartCluster({
		maxWorkers: 1,
		puppeteerInstance: puppeteer.instance,
		retryDelay: () => Number.NaN,
		retryLimit: 1,
	})
	cluster.on.error((error, parameters, context) => {
		errors.push({ error, context })
	})
	cluster.addTask(async () => {
		throw new Error('task failure')
	}, undefined)

	cluster.start()
	await cluster.idle()

	assert.equal(errors.length, 2)
	assert.equal(errors[0].context.willRetry, false)
	assert.match(errors[1].error.message, /retryDelay result/)
	assert.equal(errors[1].context.willRetry, false)
	await cluster.stop()
})
