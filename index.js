const NWLock = require('./lock');
const debug = require('debug');
const md5 = require('./md5');

class NWLoader {

	constructor(name, loader, options) {

		if (!name || !name.match(/^[a-z0-9\:\_\-\.\[\]]+$/i)) {
			throw new Error('NWLoader need first argument to be a valid string');
		}

		this.name = name;
		this.loader = loader;
		this.options = Object.assign({

			// Requires a Redis-like instance
			redis: null,

			//default expiration seconds
			ttl: 30,

			//prefix for every key
			keyPrefix: 'nwloader'

		}, options);

		if (this.options.ttl < 2) throw new Error('NWLoader need ttl greater than 2 seconds');

		// Redis instance is now mandatory
		if (!this.options.redis) {
			throw new Error('NWLoader now requires a Redis-like instance. The `redis` option must be provided.');
		}

		// Store the redis instance directly
		this.redis = this.options.redis;

		this.debug = debug(`nwloader:${this.name}`);
		// Pass the ioredis instance directly to the lock
		this.lock = new NWLock(this.redis);
	}

	/**
	 * generate a cache key used for redis
	 * support object key
	 */
	getKey(key) {
		if (typeof key !== 'string' && typeof key !== 'number') {
			key = md5(JSON.stringify(key));
		}
		return `${this.options.keyPrefix}:${this.name}:${key}`;
	}

	getBaseKey(args) {
		let key = args;
		if (args.length === 1) key = args[0];
		if (typeof key !== 'string' && typeof key !== 'number') {
			key = md5(JSON.stringify(key));
		}
		return key;
	}

	/**
	 * Check if cached data needs to be refreshed using Redis key TTL
	 * This avoids issues with time synchronization between application servers
	 * 
	 * Cache refresh strategy:
	 * - Redis key TTL is set to 2 * user TTL (in prime method) to allow serving stale data
	 * - When Redis TTL < user TTL, it means we're in the second half of the cache lifecycle
	 * - During this time, we should refresh the cache in background while still serving stale data
	 * - This allows for graceful degradation when the loader is slow or failing
	 * 
	 * @param {string} key - The Redis key to check
	 * @returns {Promise<boolean>} - True if cache needs refresh, false otherwise
	 */
	async needsRefresh(key) {
		try {
			// Get Redis key TTL (-1 if key exists but no expire, -2 if key does not exist)
			const ttl = await this.redis.ttl(key);
			debug('check ttl for', key, 'ttl=', ttl, 'options.ttl=', this.options.ttl);	
			// If key doesn't exist or TTL indicates expired, needs refresh
			if (ttl === -2) {
				return true;
			}
			
			// If TTL is less than user-configured TTL, it's time to refresh
			// (Redis TTL is in seconds, user TTL is in seconds)
			return ttl <= this.options.ttl;
		} catch (err) {
			// If we can't get TTL, assume cache needs refresh
			console.warn('Failed to get Redis key TTL, assuming cache needs refresh', err);
			return true;
		}
	}

	

	/**
	 * Load data from cache or loader with smart caching strategy:
	 * 1. Try to get data from cache first
	 * 2. If cache miss or needs refresh, use race lock to ensure only one loader function executes
	 * 3. Other concurrent requests either:
	 *    - Return cached data immediately (if data already retrieved by another request)
	 *    - Get ignored (if ignore=true, default) to avoid unnecessary waiting
	 *    - Wait for lock release then retry cache read (if ignore=false)
	 * 
	 * This design ensures:
	 * - Fast response for cache hits
	 * - Only one loader execution for cache misses
	 * - No unnecessary waiting for requests when data is already available
	 * 
	 * Cache refresh strategy:
	 * - Uses Redis key TTL to determine when to refresh cache
	 * - Redis key TTL is set to 2 * user TTL to allow serving stale data during refresh
	 * - When Redis TTL < user TTL, it's time to refresh in background
	 * - This approach avoids time synchronization issues between application servers
	 * 
	 */
	async load(...args) {
		let origKey = this.getBaseKey(args);
		let key = this.getKey(origKey);

		return new Promise(async (done, reject) => {
			// did flag tracks whether the promise has been resolved (data returned to caller)
			let did = false;
			let v = null;
			this.debug(`try to load ${key} from cache`);

			try {
				// Use this.redis directly and handle JSON parsing
				const rawValue = await this.redis.get(key);
				if (rawValue !== null) {
					try {
						v = JSON.parse(rawValue);
					} catch (parseErr) {
						console.error(`NWLoader: Failed to parse cached value for key ${key}`, parseErr);
						v = null;
					}
				}
				
				// If valid cached data found, return it immediately
				if (v && v.createTime) {
					this.debug(`got ${key} from cache`);
					done(v.value);
					did = true; // Mark that data has been returned to caller
				} else {
					this.debug(`${key} not found in cache`);
				}

				// Check if cache is missing or needs refresh
				// Even if data is returned to caller, we still try to refresh cache in background
				if (!v || await this.needsRefresh(key)) {
					// Use race lock to ensure only one loader function executes
					// Pass 'did' as ignore parameter:
					// - If did=true (data already returned), other requests will be ignored (don't wait)
					// - If did=false (no data returned yet), other requests will be ignored by default (fast fail)
					let { executed } = await this.lock.race(origKey, async () => {
						this.debug(`loading ${key} from loader`);
						try {
							// Execute loader function
							let newData = await this.loader(...args);
							this.debug(`set ${key} to cache`);
							await this.prime(origKey, newData);
							// Only return data if it hasn't been returned yet
							if (!did) {
								done(newData);
								did = true;
							}
						} catch (err) {
							// Cache the error with a shorter TTL to prevent infinite loops
							if (typeof err === 'object') err.nw_loader = 1;
							if (err && err.code) throw err;
							if (typeof err !== 'object') err = new Error(err);
							err.message = `NWLoader ${this.name}:${key} Error: ${err.message}`;
							throw err;
						}
					}, did);


					// no error thrown and cache is primed
					// If current request didn't execute the loader and no data has been returned yet,
					// try to load again (this will read from cache which was just populated)
					if (!executed && !did) {
						this.load(origKey).then(done).catch(reject);
					}
				}
			} catch (err) {
				// Only reject if data hasn't been returned yet
				if (!did) {
					reject(err);
				} else {
					// If data already returned, just log the error (background update)
					if (typeof err !== 'object') err = new Error(err);
					err.message = `NWLoader ${this.name}:${key} Error: ${err.message}`;
					err.code = 'nwloader-background-error';
					console.error(err);
				}
			}
		});
	}

	//clear cache
	async clear(key) {
		const result = await this.redis.del(this.getKey(key));
		return result > 0 ? 1 : 0;
	}

	//prime cache
	async prime(origKey, value) {
		let key = this.getKey(origKey);
		// Use this.redis directly and handle JSON serialization
		const serializedValue = JSON.stringify({
			createTime: Date.now(),
			value
		});
		// 'EX' option for ioredis expects seconds
		const result = await this.redis.set(key, serializedValue, 'EX', this.options.ttl * 2);
		return result === 'OK';
	}

	//prime cache with error
	// async primeError(origKey, error) {
	// 	let key = this.getKey(origKey);
	// 	// Store error with a shorter TTL to avoid infinite error loops
	// 	const errorTTL = Math.min(this.options.ttl, 5); // Use minimum of configured TTL or 5 seconds
	// 	const serializedValue = JSON.stringify({
	// 		createTime: Date.now(),
	// 		error: {
	// 			message: error.message,
	// 			code: error.code,
	// 			stack: error.stack
	// 		}
	// 	});
	// 	// 'EX' option for ioredis expects seconds
	// 	const result = await this.redis.set(key, serializedValue, 'EX', errorTTL);
	// 	return result === 'OK';
	// }
}


module.exports = NWLoader;

module.exports.cacheable = function(name, options) {
	return function(origFunc) {
		// Ensure options always includes redis instance for cacheable
		if (!options || !options.redis) {
			 throw new Error('cacheable decorator requires a Redis-like instance in options.redis');
		}
		let loader = new NWLoader(name, origFunc, options);
		return function(...args) {
			return loader.load(...args);
		};
	};
};