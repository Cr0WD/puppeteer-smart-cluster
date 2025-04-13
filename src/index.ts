// noinspection OverlyNestedFunctionJS

import puppeteer, { Browser, LaunchOptions, Page } from 'puppeteer'

/**
 * Type definition for a proxy function that returns a proxy URL as a string based on input parameters.
 */
export type ProxyFunction<T> = string | ((parameters: T) => string | Promise<string>)

/**
 * Type definition for the scraping task function.
 * - page: Puppeteer Page instance.
 * - props: Parameters passed to the task.
 * - proxy: Optional proxy string used for the browser session.
 */
export type TaskFunction<T, R = void> = ({
	page,
	props,
	proxy,
}: {
	page: Page
	props: T
	proxy?: string
}) => Promise<R>

/**
 * Configuration options for creating a smart Puppeteer cluster.
 */
export interface ClusterOptions<T> {
	/** Optional proxy string or a function returning a proxy URL based on task parameters */
	proxy?: ProxyFunction<T> | string

	/** Maximum number of browser instances to run in parallel */
	maxWorkers: number

	/** Delay (in ms) between polling for new tasks when the queue is empty */
	poolingTime?: number

	/** Options passed directly to puppeteer.launch() */
	puppeteerOptions?: LaunchOptions

	/** Custom Puppeteer instance (useful for mocking or custom-builds) */
	puppeteerInstance?: Partial<typeof puppeteer>

	/** Number of empty polling iterations before the cluster automatically shuts down */
	iterationsBeforeStop?: number

	/** Enable debug logging */
	debug?: boolean

	/** Show task queue and browser status in logs */
	showStatus?: boolean
}

const defaultPoolingTime = 500

/**
 * Main factory function to create a smart puppeteer cluster with concurrency, task retries, and proxy support.
 */
const CreateSmartCluster = <T>({
	proxy,
	maxWorkers,
	puppeteerOptions,
	puppeteerInstance = puppeteer,
	poolingTime = defaultPoolingTime,
	iterationsBeforeStop = 1,
	debug,
	showStatus,
}: ClusterOptions<T>) => {
	let isRunning = true

	// Queue to hold pending tasks
	const taskQueue: {
		task: TaskFunction<T>
		params: T
	}[] = []

	/**
	 * Count of currently executing tasks
	 */
	let activeTasks = 0

	/**
	 * Array to track active browser instances
	 */
	const activeBrowsers: Browser[] = []

	/**
	 * Hook to notify when all tasks are completed
	 */
	let resolveTasksCompleted: () => void
	const tasksCompleted = new Promise<void>(resolve => {
		resolveTasksCompleted = resolve
	})

	/**
	 * Worker loop that keeps polling for tasks and executing them.
	 */
	async function worker() {
		try {
			let emptyQueueIteration = 0

			while (isRunning) {
				if (showStatus)
					console.debug(
						JSON.stringify({
							taskQueue: taskQueue.length,
							activeTasks,
							activeBrowsers: activeBrowsers.length,
						})
					)

				/**
				 * Check if we can process a new task
				 */
				if (
					taskQueue.length > 0 &&
					activeTasks < maxWorkers &&
					activeBrowsers.length < maxWorkers
				) {
					emptyQueueIteration = 0
					try {
						const { task, params } = taskQueue.shift()!

						/**
						 * Execute the task asynchronously
						 */
						;(async () => {
							try {
								let usedProxy: string | undefined
								if (typeof proxy === 'string') {
									usedProxy = proxy
								} else if (typeof proxy === 'function') {
									usedProxy = await proxy(params)
								}

								const browser = await createWorker(usedProxy)
								if (!browser) {
									activeTasks--
									return
								}
								activeBrowsers.push(browser)

								/**
								 * Execute the task and cleanup after completion
								 */
								// eslint-disable-next-line promise/catch-or-return
								executeTask(browser, task, params, usedProxy).finally(() => {
									const index = activeBrowsers.indexOf(browser)
									if (index === -1) return
									activeTasks--
									activeBrowsers.splice(index, 1)
								})
							} catch (error) {
								activeTasks--
								if (debug) console.error('Error caught inside worker:', error)
								if (isRunning) taskQueue.unshift({ task, params })
								onErrorCallback?.(error as Error, params)
							}
						})()
						activeTasks++
					} catch {
						/**
						 * Ignore minor synchronous failures
						 */
					}
				} else {
					const noActiveTasks = activeTasks === 0
					const noBrowsersRunning = activeBrowsers.length === 0
					const noTasksQueued = taskQueue.length === 0
					const reachedStopThreshold = emptyQueueIteration >= iterationsBeforeStop

					// noinspection OverlyComplexBooleanExpressionJS
					if (
						noActiveTasks &&
						noBrowsersRunning &&
						noTasksQueued &&
						reachedStopThreshold
					) {
						isRunning = false
					}

					/**
					 * Nothing to do, wait a bit before polling again
					 */
					emptyQueueIteration++
					await new Promise(resolve => {
						setTimeout(resolve, poolingTime)
					})
				}
			}

			/**
			 * All tasks finished
			 */
			resolveTasksCompleted()
			if (debug) console.error('All tasks completed')

			/**
			 * Close any remaining browsers
			 */
			await Promise.all(activeBrowsers.map(browser => browser.close()))
		} catch (error) {
			if (debug) console.error('Global worker error caught:', error)
			onErrorCallback?.(error as Error)
		}
	}

	/**
	 * Create a Puppeteer browser instance with an optional proxy.
	 */
	async function createWorker(usedProxy?: string): Promise<Browser | undefined> {
		if (!puppeteerInstance.launch) return
		return puppeteerInstance.launch({
			...puppeteerOptions,
			args: [
				...(usedProxy ? [`--proxy-server=${usedProxy}`] : []),
				...(puppeteerOptions?.args || []),
			],
		})
	}

	/**
	 * Error callback hook
	 */
	let onErrorCallback: ((error: Error, parameters?: T) => void) | null = null

	/**
	 * Executes the given task inside a browser and page context.
	 */
	async function executeTask(
		browser: Browser,
		task: TaskFunction<T>,
		parameters: T,
		usedProxy?: string
	): Promise<void> {
		const [page] = await browser.pages()
		try {
			if (debug) console.log('Executing task...')
			await task({ page, props: parameters, proxy: usedProxy })
			if (debug) console.log('Task executed successfully.')
		} catch (error) {
			if (debug) console.error('Error caught inside executeTask:', error)
			if (isRunning) taskQueue.unshift({ task, params: parameters })
			onErrorCallback?.(error as Error, parameters)
		} finally {
			try {
				await page.close()
				await browser.close()
			} catch {
				/**
				 * Ignore cleanup errors
				 */
			}
		}
	}

	/**
	 * Public API of the cluster
	 */
	return {
		/**
		 * Starts the worker loop
		 */
		start() {
			isRunning = true
			worker()
		},

		/**
		 * Stops the cluster and clears the queue
		 */
		async stop() {
			isRunning = false
			taskQueue.length = 0

			for (const browser of activeBrowsers) {
				try {
					await browser.close()
				} catch (error) {
					if (debug) console.error('Error closing browser:', error)
				}
			}

			activeBrowsers.length = 0
			activeTasks = 0
		},

		/**
		 * Adds a new task to the queue
		 */
		addTask(task: TaskFunction<T>, parameters: T) {
			taskQueue.push({ task, params: parameters })
		},

		/**
		 * Returns a promise that resolves when all tasks are completed
		 */
		idle: () => tasksCompleted,

		/**
		 * Register an error listener
		 */
		on: {
			error(callback: (error: Error, parameters?: T) => void) {
				onErrorCallback = callback
			},
		},
	}
}

export default CreateSmartCluster
