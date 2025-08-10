const NodeCache = require('node-cache');
const NWCache = require('./cache');
const NWLock = require('./lock');
const debug = require('debug');
const md5 = require('./md5');

class NWLoader {

	constructor(name, loader, options) {

		if (!name || !name.match(/^[a-z0-9\:\_\-\.]+$/i)) {
			throw new Error('NWLoader need first argument to be a valid string');
		}

		this.name = name;
		this.loader = loader;
		this.options = Object.assign({

			//give the ioredis instance, or it will use in-memory cache(node-cache)
			redis: null,

			//default expiration seconds
			ttl: 30,

			//prefix for every key
			keyPrefix: 'nwloader'

		}, options);

		//create cache instance
		if (this.options.redis) {
			this.cache = new NWCache(this.options.redis);
		} else {
			this.cache = new NWCache(new NodeCache({
				stdTTL: this.options.ttl * 2  //default ttl of node-cache
			}));
		}

		this.debug = debug(`nwloader:${this.name}`);
		this.timeouts = {};
		this.lock = new NWLock(this.cache);
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
	 * load data from cache or loader
	 */
	async load(...args) {
		let origKey = this.getBaseKey(args);
		let key = this.getKey(origKey);

		return new Promise(async (done, reject) => {
			let did = false;
			let v = null;
			this.debug(`try to load ${key} from cache`);

			try {
				v = await this.cache.get(key);
				if (v && v.createTime) {
					this.debug(`got ${key} from cache`);
					done(v.value);
					did = true;
				} else {
					this.debug(`${key} not found in cache`);
				}

				if (!v || (v && v.createTime && Date.now() - v.createTime > this.options.ttl * 1000)) {
					let { executed } = await this.lock.race(origKey, async () => {
						this.debug(`loading ${key} from loader`);
						try {
							let newData = await this.loader(...args);
							this.debug(`set ${key} to cache`);
							await this.prime(origKey, newData);
							if (!did) {
								done(newData);
								did = true;
							}
						} catch (err) {
							if (typeof err === 'object') err.nw_loader = 1;
							if (err && err.code) throw err;
							if (typeof err !== 'object') err = new Error(err);
							err.message = `NWLoader ${this.name}:${key} Error: ${err.message}`;
							throw err;
						}
					}, did);

					if (!executed && !did) {
						this.load(origKey).then(done).catch(reject);
					}
				}
			} catch (err) {
				if (!did) {
					reject(err);
				} else {
					if (typeof err !== 'object') err = new Error(err);
					err.message = `NWLoader ${this.name}:${key} Error: ${err.message}`;
					console.error(err);
				}
			}
		});
	}

	//清除缓存
	clear(key) {
		return this.cache.del(this.getKey(key)).then(r => r * 1);
	}

	//设置缓存
	async prime(origKey, value) {
		let key = this.getKey(origKey);
		await this.cache.set(key, {
			createTime: Date.now(),
			value
		}, 'EX', this.options.ttl * 2);
	}
}


module.exports = NWLoader;

module.exports.cacheable = function(name, options) {
	return function(origFunc) {
		let loader = new NWLoader(name, origFunc, options);
		return function(...args) {
			return loader.load(...args);
		};
	};
};