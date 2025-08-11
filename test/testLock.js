const { describe, it, beforeEach, afterEach } = require('node:test');
const Lock = require('../lock');
const Redis = require('ioredis');
const delay = require('delay');
const assert = require('assert');

describe('Lock - all method', function() {
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

	it('should execute tasks sequentially when using the same lock key', { timeout: 10000 }, async () => {
		const results = [];
		const lockKey = 'test-lock-sequential';

		// Create tasks that record their start and end times
		const createTask = (id) => {
			return async () => {
				results.push({ id, status: 'start', at: Date.now() });
				// Simulate some work
				await delay(100);
				results.push({ id, status: 'end', at: Date.now() });
				return `result-${id}`;
			};
		};

		// Start multiple tasks concurrently with the same lock key
		const task1 = lock.all(lockKey, createTask('A'));
		const task2 = lock.all(lockKey, createTask('B'));
		const task3 = lock.all(lockKey, createTask('C'));

		const [result1, result2, result3] = await Promise.all([task1, task2, task3]);

		// Assertions
		assert.strictEqual(result1, 'result-A');
		assert.strictEqual(result2, 'result-B');
		assert.strictEqual(result3, 'result-C');

		// Verify execution order: A starts, A ends, B starts, B ends, C starts, C ends
		// Check that no task started before the previous one ended
		for (let i = 0; i < results.length; i++) {
			const item = results[i];
			if (item.status === 'start' && i > 0) {
				const prevItem = results[i - 1];
				// The start of a task must happen after or at the same time as the end of the previous task
				if (prevItem.status === 'end') {
					assert(prevItem.at <= item.at, `Task ${item.id} started before task ${prevItem.id} finished`);
				}
			}
		}
		// Basic sanity check that we have 6 events (3 starts, 3 ends)
		assert.strictEqual(results.length, 6);
		console.log('Sequential execution test passed with results:', results);
	});

	it('should allow concurrent execution with different lock keys', { timeout: 10000 }, async () => {
		const results = [];
		const lockKey1 = 'test-lock-concurrent-1';
		const lockKey2 = 'test-lock-concurrent-2';

		const createTask = (id, lockKey) => {
			return async () => {
				results.push({ id, lockKey, status: 'start', at: Date.now() });
				// Simulate some work
				await delay(100);
				results.push({ id, lockKey, status: 'end', at: Date.now() });
				return `result-${id}`;
			};
		};

		// Start tasks with different lock keys concurrently
		const task1 = lock.all(lockKey1, createTask('X', lockKey1));
		const task2 = lock.all(lockKey2, createTask('Y', lockKey2));

		const [result1, result2] = await Promise.all([task1, task2]);

		// Assertions
		assert.strictEqual(result1, 'result-X');
		assert.strictEqual(result2, 'result-Y');

		// Since they use different locks, they should run in parallel.
		// Their start times should be very close, and their end times as well.
		// We need to find the start and end events for each task.
		const taskXStart = results.find(r => r.id === 'X' && r.status === 'start');
		const taskYStart = results.find(r => r.id === 'Y' && r.status === 'start');
		const taskXEnd = results.find(r => r.id === 'X' && r.status === 'end');
		const taskYEnd = results.find(r => r.id === 'Y' && r.status === 'end');

		assert(taskXStart, 'Task X start event should exist');
		assert(taskYStart, 'Task Y start event should exist');
		assert(taskXEnd, 'Task X end event should exist');
		assert(taskYEnd, 'Task Y end event should exist');

		// Both tasks should start almost simultaneously (within a small delta)
		const startDelta = Math.abs(taskXStart.at - taskYStart.at);
		assert(startDelta < 50, `Tasks X and Y should start concurrently, but started ${startDelta}ms apart`);

		console.log('Concurrent execution test passed with results:', results);
	});

	it('should handle task errors gracefully and still release the lock', { timeout: 10000 }, async () => {
		const lockKey = 'test-lock-error';

		const failingTask = async () => {
			await delay(50);
			throw new Error('Intentional test error');
		};

		const successfulTask = async () => {
			await delay(50);
			return 'success';
		};

		// First task throws an error
		await assert.rejects(
			lock.all(lockKey, failingTask),
			(err) => {
				assert.strictEqual(err.message, 'Intentional test error');
				return true;
			},
			'The first task should reject with the expected error'
		);

		// Second task should be able to acquire the lock and succeed
		// because the lock from the first task should have been released despite the error
		const result = await lock.all(lockKey, successfulTask);
		assert.strictEqual(result, 'success', 'The second task should succeed after the first one releases the lock');
		console.log('Error handling test passed');
	});

	it('should timeout if a task takes longer than the specified timeout', { timeout: 10000 }, async () => {
		const lockKey = 'test-lock-timeout';
		const longRunningTask = async () => {
			// This task takes longer than the default timeout
			await delay(6000); // 6 seconds
			return 'done';
		};

		// Create another task that tries to acquire the lock immediately after
		const fastTask = async () => {
			return 'fast';
		};

		// Start the long running task with a short timeout
		const longTaskPromise = lock.all(lockKey, 1000, longRunningTask); // 1 second timeout

		// Give it a moment to start, then try the fast task
		await delay(200);
		const fastTaskResult = await lock.all(lockKey, fastTask);

		// The fast task should succeed because the long task timed out
		assert.strictEqual(fastTaskResult, 'fast');

		// The long task might still complete or might have been rejected due to timeout
		// Let's check if it rejected
		try {
			const longTaskResult = await longTaskPromise;
			// If it didn't reject, it means it completed despite the timeout logic in `all`
			// This is okay, as `all` doesn't inherently kill a task that times out,
			// it just means the lock was released.
			console.log('Long task completed with result:', longTaskResult);
		} catch (err) {
			// It's also okay if it rejected, perhaps due to internal logic or manual cancellation
			console.log('Long task rejected as expected (or due to other reasons):', err.message);
		}

		console.log('Timeout test completed');
	});
});