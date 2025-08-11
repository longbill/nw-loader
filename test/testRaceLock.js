const { describe, test, beforeEach, afterEach } = require('node:test');
const Lock = require('../lock');
const Redis = require('ioredis');
const delay = require('delay');
const assert = require('assert');

describe('Lock - race method', function() {
	// Create a new Redis instance and Lock instance for each test run
	// to ensure a clean state.
	let redisClient;
	let lock;

	beforeEach(() => {
		// Use a unique Redis URL if provided, otherwise default to localhost
		const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
		redisClient = new Redis(redisUrl);
		// Create a lock instance with a reasonable default timeout for testing
		lock = new Lock(redisClient, {
			defaultTimeout: 5000,
			checkLockDelay: 20 // Speed up tests a bit
		});
	});

	afterEach(async () => {
		// Clean up Redis connection after each test
		if (redisClient) {
			// Optionally clear any test keys here if needed, though the lock
			// mechanism should handle cleanup.
			// For example: await redisClient.del('nwlock:test-lock-sequential');
			await redisClient.quit();
		}
	});

	test('should execute only one task when multiple tasks race for the same lock key', async () => {
		
		const results = [];
		const lockKey = 'test-race-lock-single-exec';

		// Create tasks that record their execution
		const createTask = (id) => {
			return async () => {
				results.push({ id, status: 'executed', at: Date.now() });
				// Simulate some work
				await delay(100);
				return `result-${id}`;
			};
		};

		// Start multiple tasks concurrently with the same lock key
		const task1 = lock.race(lockKey, createTask('A'));
		const task2 = lock.race(lockKey, createTask('B'));
		const task3 = lock.race(lockKey, createTask('C'));

		const [result1, result2, result3] = await Promise.all([task1, task2, task3]);

		// Assertions for return values
		// Only one task should have executed (executed: true)
		const executedTasks = [result1, result2, result3].filter(res => res.executed);
		assert.strictEqual(executedTasks.length, 1, 'Only one task should have been executed');

		const executedResult = executedTasks[0];
		assert(executedResult.result.startsWith('result-'), 'The executed task should return a proper result');

		// The other tasks should not have been executed (executed: false)
		const nonExecutedTasks = [result1, result2, result3].filter(res => !res.executed);
		assert.strictEqual(nonExecutedTasks.length, 2, 'Two tasks should not have been executed');
		assert.strictEqual(nonExecutedTasks[0].result, null);
		assert.strictEqual(nonExecutedTasks[1].result, null);

		// Verify execution results array
		assert.strictEqual(results.length, 1, 'Only one task should have added to the results array');
		assert(results[0].id === 'A' || results[0].id === 'B' || results[0].id === 'C', 'The executed task ID should be one of A, B, or C');
		console.log('Single execution race test passed with result:', executedResult, 'and non-executed tasks:', nonExecutedTasks);
	});
});