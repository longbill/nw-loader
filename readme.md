nw-loader
==========

A smart data caching library with automatic refresh and race condition handling for Node.js applications. nw-loader ensures efficient data loading with minimal redundant requests while maintaining data freshness.

## Use Cases

On high-concurrency web servers, there are two common scenarios that can cause multiple requests to be passed to the backend:

- Cold start: When there is no cached data in Redis
- Cache expiration

When either of these scenarios occurs, if multiple requests arrive simultaneously, a poorly designed caching service will cause each request to check the cache, find no cached data, and then all request the backend data. This causes a sudden spike in backend pressure.

When using `NWLoader`, you get:

- During cold start, only the first request that fetches data will call the backend data service. Other requests wait for the result of the first request. Once the first request gets the data, other requests will directly use the data obtained by the first request.
- When cache expires, all requests will immediately get the just-expired data version directly from Redis. Then `NWLoader` will request backend data in the background to update the cache.

The final effect is that if the TTL is set to 30 seconds, using `NWLoader` will ensure that backend data requests occur only once within 30 seconds.

## Installation

```bash
npm install nw-loader
```

**Note**: You need to install a Redis client library in your project (e.g., ioredis or node-redis).

## Usage

### Basic Usage with NWLoader Class

```javascript
const NWLoader = require('nw-loader');
// You need to install a Redis client library in your project, e.g., ioredis
const Redis = require('ioredis'); 

const redis = new Redis('redis://127.0.0.1:6379'); // Create your Redis client instance

const loader = new NWLoader('user', function(user_id) {
	return db.getUser(user_id);
}, {
	redis: redis // Pass the Redis client instance
});

//...

router.get('/getUser', async ctx => {
	ctx.body = await loader.load(ctx.query.user_id);
});

//...
```

### Using the cacheable Decorator

```javascript
import { cacheable } from 'nw-loader';
// You need to install a Redis client library in your project, e.g., ioredis
import Redis from 'ioredis';

const redis = new Redis('redis://127.0.0.1:6379');

export const getName = cacheable('redis:key:name', { redis: redis, ttl: 3 })(async (id, language) => {
	console.log('real getting name: ' + id + ' ' + language);
	return language+':' + id;
});

getName(1, 'en').then(console.log); //en:1
getName(1, 'cn').then(console.log); //cn:1
```

## API Reference

### NWLoader Class

#### Constructor
```javascript
const loader = new NWLoader(name, loadFunction, options)
```

#### Parameters
- `name` (string): Unique identifier for this loader instance
- `loadFunction` (function): Async function that loads data when not in cache
- `options` (object): Configuration options

#### Options

```javascript
{
	// Requires a Redis-like instance with set, get, del, and createScript methods
	redis: null, // Redis client instance (mandatory)

	// Default expiration seconds
	// If you request data after this time, nw-loader will return cached  
	// data immediately, then request real data to update cache in background
	// ttl should greater than 3 seconds for best practice
	ttl: 30,

	// Prefix for every key
	keyPrefix: 'nwloader'
}
```

#### Methods

- `load(...args)`: Load data using the loader function, with caching
- `clear(key)`: Clear cached data for a specific key
- `prime(key, value)`: Manually populate cache with data

### cacheable Decorator

```javascript
require('nw-loader').cacheable(name, options)(loadFunction)
```

**Note:** The `cacheable` decorator also requires a `redis` instance in its options.

## Cache Refresh Strategy

nw-loader implements a sophisticated cache refresh strategy:

1. **Double TTL Storage**: Data is stored with a TTL of `2 * userTTL` in Redis
2. **Background Refresh**: When Redis TTL drops below user TTL, data is refreshed in background
3. **Stale Data Serving**: During refresh, stale data continues to be served
4. **Race Condition Prevention**: Only one refresh operation occurs even with concurrent requests

This approach ensures:
- No downtime during data refresh
- Minimal impact on user experience
- Reduced load on data sources
- Consistent performance under varying loads

## Error Handling

You need to ensure your Redis server is available. `NWLoader` has no ability to handle extreme situations. You need to handle Redis errors yourself. If the Redis server fails, an error will be thrown when calling the `loader.load()` method.

If your data fetching method has errors, there are two scenarios:

- If there is an error from the beginning, you can directly catch the error when calling the `loader.load()` method.
- If there is no error initially, but `NWLoader` encounters an error when updating in the background, `NWLoader` will call `console.error` to log the error. In this case, your program will continue running for another TTL seconds, and only then will the `loader.load()` method catch the error.

## Test

`npm i --dev`
`npm test`

## Requirements

- Node.js >= 20
- Redis server
- Redis client library (ioredis or node-redis recommended)
- debug package

## License

MIT