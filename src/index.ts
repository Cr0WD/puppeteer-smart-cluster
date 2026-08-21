import puppeteer, { Browser, LaunchOptions, Page } from 'puppeteer'

export interface ProxyConfiguration {
	server: string
	username?: string
	password?: string
}

export type ProxyValue = string | ProxyConfiguration

export type ProxyFunction<T> =
	| ProxyValue
	| ((parameters: T, signal: AbortSignal) => ProxyValue | Promise<ProxyValue>)

export interface TaskContext<T> {
	page: Page
	props: T
	proxy?: string
	signal: AbortSignal
}

export type TaskFunction<T, R = void> = (context: TaskContext<T>) => Promise<R>

export interface RetryContext<T> {
	attempt: number
	error: Error
	parameters: T
	signal: AbortSignal
}

export type RetryDelay<T> = number | ((context: RetryContext<T>) => number | Promise<number>)

export interface TaskErrorContext {
	attempt: number
	retriesLeft: number
	willRetry: boolean
}

export interface ClusterOptions<T> {
	/** Optional proxy string or a function returning a proxy URL for each attempt. */
	proxy?: ProxyFunction<T>

	/** Maximum number of browser instances running in parallel. */
	maxWorkers: number

	/** Idle grace period unit in milliseconds. */
	poolingTime?: number

	/** Options passed directly to puppeteer.launch(). */
	puppeteerOptions?: LaunchOptions

	/** Custom Puppeteer instance, useful for wrappers and tests. */
	puppeteerInstance?: Partial<typeof puppeteer>

	/** Number of idle grace period units before automatic shutdown. */
	iterationsBeforeStop?: number

	/** Maximum number of retries after the first attempt. */
	retryLimit?: number

	/** Fixed or dynamic delay before a retry. */
	retryDelay?: RetryDelay<T>

	/** Enable debug logging. */
	debug?: boolean

	/** Log queue and browser status whenever the dispatcher runs. */
	showStatus?: boolean
}

interface QueuedTask<T> {
	attempt: number
	controller: AbortController
	task: TaskFunction<T, unknown>
	parameters: T
}

type ClusterState = 'running' | 'stopped' | 'stopping'

const defaultPoolingTime = 500
const defaultRetryLimit = 3
const maximumTimerDelay = 2_147_483_647

const defaultRetryDelay = ({ attempt }: RetryContext<unknown>) =>
	Math.min(1000 * 2 ** (attempt - 1), 30_000)

const toError = (value: unknown): Error => {
	if (value instanceof Error) return value
	return new Error(String(value))
}

const assertNonNegativeInteger = (name: string, value: number) => {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative integer`)
	}
}

const assertNonNegativeFiniteNumber = (name: string, value: number) => {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative finite number`)
	}
}

const assertTimerDelay = (name: string, value: number) => {
	assertNonNegativeFiniteNumber(name, value)
	if (value > maximumTimerDelay) {
		throw new RangeError(`${name} must not exceed ${maximumTimerDelay}`)
	}
}

const parseProxyServer = (server: unknown): ProxyConfiguration => {
	if (typeof server !== 'string' || server.trim().length === 0) {
		throw new TypeError('proxy server must not be empty')
	}
	const normalizedServer = server.trim()

	let url: URL | undefined
	try {
		url = new URL(normalizedServer)
	} catch {
		url = undefined
	}
	if (url && (url.username || url.password)) {
		const username = decodeURIComponent(url.username)
		const password = decodeURIComponent(url.password)
		url.username = ''
		url.password = ''
		return { server: url.toString(), username, password }
	}

	const bareCredentials = normalizedServer.match(/^([^/@\s]+):([^/@\s]*)@(.+)$/)
	if (bareCredentials) {
		return {
			server: bareCredentials[3],
			username: decodeURIComponent(bareCredentials[1]),
			password: decodeURIComponent(bareCredentials[2]),
		}
	}
	return { server: normalizedServer }
}

const normalizeProxy = (value?: ProxyValue): ProxyConfiguration | undefined => {
	if (value === undefined) return
	if (typeof value === 'string') return parseProxyServer(value)
	const parsedProxy = parseProxyServer(value.server)
	let username = parsedProxy.username
	let password = parsedProxy.password
	if (value.username !== undefined) username = value.username
	if (value.password !== undefined) password = value.password
	return {
		server: parsedProxy.server,
		username,
		password,
	}
}

const getProxyArguments = (args: string[]) =>
	args.filter(argument => argument.startsWith('--proxy-server='))

const CreateSmartCluster = <T>({
	proxy,
	maxWorkers,
	puppeteerOptions,
	puppeteerInstance = puppeteer,
	poolingTime = defaultPoolingTime,
	iterationsBeforeStop = 1,
	retryLimit = defaultRetryLimit,
	retryDelay = defaultRetryDelay,
	debug = false,
	showStatus = false,
}: ClusterOptions<T>) => {
	if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) {
		throw new RangeError('maxWorkers must be a positive integer')
	}
	assertNonNegativeFiniteNumber('poolingTime', poolingTime)
	assertNonNegativeInteger('iterationsBeforeStop', iterationsBeforeStop)
	if (retryLimit !== Number.POSITIVE_INFINITY) {
		assertNonNegativeInteger('retryLimit', retryLimit)
	}
	if (typeof retryDelay === 'number') {
		assertTimerDelay('retryDelay', retryDelay)
	}
	if (typeof proxy !== 'function') normalizeProxy(proxy)
	const proxyArguments = getProxyArguments(puppeteerOptions?.args ?? [])
	if (proxy !== undefined && proxyArguments.length > 0) {
		throw new TypeError('proxy cannot be combined with a --proxy-server argument')
	}
	for (const argument of proxyArguments) {
		const parsedProxy = parseProxyServer(argument.slice('--proxy-server='.length))
		if (parsedProxy.username !== undefined || parsedProxy.password !== undefined) {
			throw new TypeError('proxy credentials cannot be used in a --proxy-server argument')
		}
	}
	const idleStopDelay = poolingTime * iterationsBeforeStop
	assertTimerDelay('poolingTime * iterationsBeforeStop', idleStopDelay)

	let state: ClusterState = 'stopped'
	let idleTimer: ReturnType<typeof setTimeout> | undefined
	let stopPromise: Promise<void> | undefined
	const taskQueue: QueuedTask<T>[] = []
	const activeRuns = new Set<Promise<void>>()
	const activeBrowsers = new Set<Browser>()
	const browserClosures = new WeakMap<Browser, Promise<void>>()
	const taskControllers = new Set<AbortController>()
	const retryTimers = new Map<QueuedTask<T>, ReturnType<typeof setTimeout>>()
	const idleWaiters = new Set<() => void>()
	let onErrorCallback:
		| ((error: Error, parameters?: T, context?: TaskErrorContext) => void)
		| undefined

	const clearIdleTimer = () => {
		if (!idleTimer) return
		clearTimeout(idleTimer)
		idleTimer = undefined
	}

	const isIdle = () => taskQueue.length === 0 && activeRuns.size === 0 && retryTimers.size === 0

	const resolveIdleWaiters = () => {
		if (!isIdle()) return
		for (const resolve of idleWaiters) resolve()
		idleWaiters.clear()
	}

	const emitError = (error: Error, parameters: T, context: TaskErrorContext) => {
		if (!onErrorCallback) return
		try {
			onErrorCallback(error, parameters, context)
		} catch (callbackError) {
			if (debug) console.error('Error listener failed:', callbackError)
		}
	}

	const closeBrowser = async (browser: Browser, page?: Page) => {
		const existingClosure = browserClosures.get(browser)
		if (existingClosure) return existingClosure

		const closure = (async () => {
			if (page) {
				try {
					await page.close()
				} catch (error) {
					if (debug) console.error('Error closing page:', error)
				}
			}

			try {
				await browser.close()
			} catch (error) {
				if (debug) console.error('Error closing browser:', error)
			} finally {
				activeBrowsers.delete(browser)
			}
		})()
		browserClosures.set(browser, closure)
		return closure
	}

	const createBrowser = async (usedProxy?: string): Promise<Browser> => {
		if (!puppeteerInstance.launch) {
			throw new Error('puppeteerInstance.launch is required')
		}

		const args = [...(puppeteerOptions?.args ?? [])]
		if (usedProxy) args.unshift(`--proxy-server=${usedProxy}`)

		return puppeteerInstance.launch({
			...puppeteerOptions,
			args,
		})
	}

	const getProxy = async (parameters: T, signal: AbortSignal) => {
		if (typeof proxy === 'function') {
			return normalizeProxy(await proxy(parameters, signal))
		}
		return normalizeProxy(proxy)
	}

	const getRetryDelay = async (context: RetryContext<T>) => {
		let delay: number
		if (typeof retryDelay === 'function') {
			delay = await retryDelay(context)
		} else {
			delay = retryDelay
		}
		assertTimerDelay('retryDelay result', delay)
		return delay
	}

	const executeAttempt = async (queuedTask: QueuedTask<T>) => {
		let browser: Browser | undefined
		let page: Page | undefined
		queuedTask.controller.signal.throwIfAborted()
		const usedProxy = await getProxy(queuedTask.parameters, queuedTask.controller.signal)

		try {
			browser = await createBrowser(usedProxy?.server)
			activeBrowsers.add(browser)
			queuedTask.controller.signal.throwIfAborted()
			const pages = await browser.pages()
			page = pages[0]
			if (!page) page = await browser.newPage()
			if (usedProxy?.username !== undefined || usedProxy?.password !== undefined) {
				await page.authenticate({
					username: usedProxy.username ?? '',
					password: usedProxy.password ?? '',
				})
			}
			await queuedTask.task({
				page,
				props: queuedTask.parameters,
				proxy: usedProxy?.server,
				signal: queuedTask.controller.signal,
			})
		} finally {
			if (browser) await closeBrowser(browser, page)
		}
	}

	const scheduleRetry = (queuedTask: QueuedTask<T>, delay: number) => {
		const timer = setTimeout(() => {
			retryTimers.delete(queuedTask)
			if (state === 'running' && !queuedTask.controller.signal.aborted) {
				queuedTask.attempt++
				taskQueue.push(queuedTask)
			} else {
				taskControllers.delete(queuedTask.controller)
			}
			dispatch()
			resolveIdleWaiters()
			scheduleAutomaticStop()
		}, delay)
		retryTimers.set(queuedTask, timer)
	}

	const runTask = async (queuedTask: QueuedTask<T>) => {
		let retryScheduled = false

		try {
			if (debug) console.debug(`Executing task attempt ${queuedTask.attempt}`)
			await executeAttempt(queuedTask)
		} catch (value) {
			const error = toError(value)
			const retriesLeft = retryLimit - queuedTask.attempt + 1
			let willRetry = state === 'running' && retriesLeft > 0
			let delay = 0

			if (willRetry) {
				try {
					delay = await getRetryDelay({
						attempt: queuedTask.attempt,
						error,
						parameters: queuedTask.parameters,
						signal: queuedTask.controller.signal,
					})
				} catch (retryDelayError) {
					willRetry = false
					emitError(error, queuedTask.parameters, {
						attempt: queuedTask.attempt,
						retriesLeft: Math.max(0, retriesLeft),
						willRetry,
					})
					emitError(toError(retryDelayError), queuedTask.parameters, {
						attempt: queuedTask.attempt,
						retriesLeft: 0,
						willRetry,
					})
					return
				}
			}

			willRetry = willRetry && state === 'running' && !queuedTask.controller.signal.aborted
			if (willRetry) {
				scheduleRetry(queuedTask, delay)
				retryScheduled = true
			}
			emitError(error, queuedTask.parameters, {
				attempt: queuedTask.attempt,
				retriesLeft: Math.max(0, retriesLeft),
				willRetry,
			})
		} finally {
			if (!retryScheduled) taskControllers.delete(queuedTask.controller)
		}
	}

	const scheduleAutomaticStop = () => {
		if (state !== 'running' || !isIdle() || idleTimer) return
		idleTimer = setTimeout(() => {
			idleTimer = undefined
			if (state === 'running' && isIdle()) state = 'stopped'
		}, idleStopDelay)
	}

	function dispatch() {
		if (showStatus) {
			console.debug(
				JSON.stringify({
					state,
					taskQueue: taskQueue.length,
					activeTasks: activeRuns.size,
					activeBrowsers: activeBrowsers.size,
					retryingTasks: retryTimers.size,
				})
			)
		}

		clearIdleTimer()
		while (state === 'running' && activeRuns.size < maxWorkers) {
			const queuedTask = taskQueue.shift()
			if (!queuedTask) break

			const run = runTask(queuedTask)
			activeRuns.add(run)
			void run.finally(() => {
				activeRuns.delete(run)
				dispatch()
				resolveIdleWaiters()
				scheduleAutomaticStop()
			})
		}

		resolveIdleWaiters()
		scheduleAutomaticStop()
	}

	return {
		start() {
			if (state === 'stopping') {
				throw new Error('Cannot start the cluster while it is stopping')
			}
			if (state === 'running') return
			state = 'running'
			dispatch()
		},

		async stop() {
			if (stopPromise) return stopPromise
			state = 'stopping'
			clearIdleTimer()
			taskQueue.length = 0
			for (const timer of retryTimers.values()) clearTimeout(timer)
			retryTimers.clear()
			for (const controller of taskControllers) controller.abort()
			taskControllers.clear()

			stopPromise = (async () => {
				await Promise.allSettled(
					Array.from(activeBrowsers, browser => closeBrowser(browser))
				)
				await Promise.allSettled(activeRuns)
				state = 'stopped'
				stopPromise = undefined
				resolveIdleWaiters()
			})()
			return stopPromise
		},

		addTask<R>(task: TaskFunction<T, R>, parameters: T) {
			if (state === 'stopping') {
				throw new Error('Cannot add a task while the cluster is stopping')
			}
			const controller = new AbortController()
			taskControllers.add(controller)
			taskQueue.push({ attempt: 1, controller, task, parameters })
			if (state === 'running') dispatch()
		},

		idle() {
			if (isIdle()) return Promise.resolve()
			return new Promise<void>(resolve => {
				idleWaiters.add(resolve)
			})
		},

		on: {
			error(callback: (error: Error, parameters?: T, context?: TaskErrorContext) => void) {
				onErrorCallback = callback
			},
		},
	}
}

export default CreateSmartCluster
