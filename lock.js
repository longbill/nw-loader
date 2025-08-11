const debug = require('debug')('nwlock');
const md5 = require('./md5');
const delay = require('delay');
const crypto = require('crypto'); // 引入 crypto 模块生成 token

class Lock {

	constructor(redisInstance, options) {
		// Check if redisInstance has the required methods
		if (!redisInstance) {
			 throw new Error('Lock requires a Redis-like instance with set, get, del, and createScript methods');
		}

		this.redis = redisInstance;

		// Prepare the Lua script for safe lock release
		// This script checks if the lock value matches the provided token before deleting it.
		this.releaseScript = `
			if redis.call("GET", KEYS[1]) == ARGV[1] then
				return redis.call("DEL", KEYS[1])
			else
				return 0
			end
		`;

		this.options = Object.assign({
			//prefix for every key
			keyPrefix: 'nwlock',

			//the check delay in ms
			checkLockDelay: 100,

			//default timeout
			defaultTimeout: 10000 //10 seconds
		}, options || {});

		debug('new instance with options', this.options);
	}

	getKey(key) {
		if (typeof key !== 'string' && typeof key !== 'number') {
			key = md5(JSON.stringify(key));
		}
		return `${this.options.keyPrefix}:${key}`;
	}

	// Helper function to generate a unique token
	_generateToken() {
		return crypto.randomBytes(20).toString('hex');
	}

	async getAllLock(lockName, timeout) {
		debug(`getting all lock for ${lockName}`);
		let delayed = false;
		const key = this.getKey(lockName) + ':all';
		const token = this._generateToken(); // Generate a unique token for this lock attempt
		
		do {
			// Set the lock key with an expiration. Value is the unique token.
			let r = await this.redis.set(key, token, 'PX', timeout, 'NX');
			if (r === 'OK') break; // Got the lock (ioredis returns 'OK' on success for NX)
			debug(`locked, wait ${this.options.checkLockDelay}ms for ${lockName}`);
			delayed = true;
			await delay(this.options.checkLockDelay);
		} while (true);
		if (delayed) debug(`unlocked for ${lockName}`);
		// Return the token along with delayed status so it can be used for unlocking
		return { delayed, token, key };
	}

	async getRaceLock(lockName, timeout, ignore) {
		debug(`getting race lock for ${lockName}`);
		let delayed = false, ignored = false;
		const key = this.getKey(lockName) + ':race';
		const token = this._generateToken(); // Generate a unique token for this lock attempt

		// Try to get the lock
		let r = await this.redis.set(key, token, 'PX', timeout, 'NX');

		if (r === 'OK') {
			debug(`${lockName} not locked`);
			return { delayed, ignored, token, key };
		}

		if (ignore) {
			debug(`ignore race lock for ${lockName}`);
			ignored = true;
			return { delayed, ignored, token: null, key }; // No token if ignored
		}

		// Wait until lock is released or expires
		while (true) {
			debug(`race locked, wait ${this.options.checkLockDelay}ms for ${lockName}`);
			delayed = true;
			await delay(this.options.checkLockDelay);
			// Check if key still exists in cache (i.e., is locked)
			// If key is null, it means it expired or was deleted.
			const currentValue = await this.redis.get(key);
			if (currentValue === null) break;
		}

		debug(`race unlocked for ${lockName}`);
		// Note: Even though it's unlocked, we don't have the token for the new holder.
		// The caller needs to be aware of this.
		return { delayed, ignored, token: null, key };
	}

	async all(lockName, timeout, task) {
		if (!lockName) throw new Error('need lockName');
		if (!task && typeof timeout === 'function') {
			task = timeout;
			timeout = this.options.defaultTimeout;
		}
		if (typeof task !== 'function') throw new Error('task should be function returns Promise');

		let { delayed, token, key } = await this.getAllLock(lockName, timeout);
		let err = null, result = undefined;

		debug(`executing task for ${lockName}`);
		try {
			result = await task(delayed);
		} catch (_err) {
			console.error(`NWLock: task throws error for ${lockName}: `, _err);
			err = _err;
		}

		debug(`task executed for ${lockName}`);
		// Safely release the lock using the token
		if (token) {
			try {
				const releaseResult = await this.redis.eval(this.releaseScript, 1, key, token);
				debug(`Lock release result for ${lockName}: ${releaseResult}`);
			} catch (releaseErr) {
				console.error(`NWLock: failed to release lock for ${lockName}: `, releaseErr);
			}
		} else {
			debug(`No token to release lock for ${lockName}`);
		}

		if (err) throw err;
		return result;
	}

	async race(lockName, timeout, task, ignore) {
		if (!lockName) throw new Error('need lockName');
		// Store the original ignore value to preserve default
		const originalIgnore = ignore;
		if (typeof timeout === 'function') {
			ignore = task;
			task = timeout;
			timeout = this.options.defaultTimeout;
		}
		
		// Set default value for ignore parameter if not provided
		if (originalIgnore === undefined && ignore === undefined) {
			ignore = true;
		}

		if (typeof task !== 'function') throw new Error('task should be function returns Promise');

		let { delayed, ignored, token, key } = await this.getRaceLock(lockName, timeout, ignore);
		let err = null, result = undefined;
		
		// If ignored or delayed (and thus didn't get the lock after waiting), return immediately
		if (ignored || delayed) {
			return {
				executed: false,
				result: null
			};
		}

		debug(`executing race task for ${lockName}`);
		try {
			result = await task(delayed);
		} catch (_err) {
			if (!_err || !_err.nw_loader) console.error(`Lock: task throws error for ${lockName}: `, _err);
			// For race method, if the task fails, we still consider it "executed" but with an error
			// The caller can check the result to see if it's an error
			err = _err;
		}
		debug(`task executed for ${lockName}`);
		
		// Safely release the lock using the token.
		// The token is only present if this call was the one that initially acquired the lock.
		if (token) {
			try {
				const releaseResult = await this.redis.eval(this.releaseScript, 1, key, token);
				debug(`Lock release result for ${lockName} (race): ${releaseResult}`);
			} catch (releaseErr) {
				console.error(`NWLock: failed to release race lock for ${lockName}: `, releaseErr);
			}
		} else {
			// This branch is for the case where the lock was acquired by waiting,
			// but by the time the task finished, we couldn't guarantee we hold the lock anymore.
			// This is a limitation of the current 'race' design where waiting parties don't get a new token.
			// A more robust solution might involve re-checking or a different locking pattern for race.
			debug(`No token to release race lock for ${lockName}, or lock might have been taken by another waiter.`);
		}

		// If there was an error, return executed: false
		if (err) throw err;
		
		return {
			executed: true,
			result
		};
	}
}


module.exports = Lock;