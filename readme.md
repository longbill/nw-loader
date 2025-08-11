nw-loader
==========

cache data resource with smart auto-refresh and lock.

> **Note:** As of v3.0.0, the timeout feature has been removed. If you need timeout functionality, please use v2.1.0 or earlier.

## Usage ##

`const loader = new NWLoader(name, loadFunction, options)`
`await loader.load(key)`

where the `key` could be: `number`, `string` or `object`.

**Note:** As of v2.1.0, `nw-loader` requires a Redis client that implements `set`, `get`, `del`, and `createScript` methods (e.g., [ioredis](https://github.com/luin/ioredis)). Please ensure you provide a compatible instance.

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
	ctx.body = loader.load(ctx.query.user_id);
});

//...

```





### options

```javascript
{
	// Requires a Redis-like instance with set, get, del, and createScript methods
	redis: null, // Redis client instance (mandatory)

	//default expiration seconds
	//if you request data after this time, nw-loader will return cached  
	//data immediately, then request real data to update cache in background
	ttl: 30,

	//prefix for every key
	keyPrefix: 'nwloader'
}
```

### cacheable decorator

`require('nw-loader').cacheable(name, options)(loadFunction)`

**Note:** The `cacheable` decorator also requires a `redis` instance in its options.

example: 

```javascript
const { cacheable } = require('nw-loader');
// You need to install a Redis client library in your project, e.g., ioredis
const Redis = require('ioredis'); 

const redis = new Redis('redis://127.0.0.1:6379');

async function getName(id) {
	console.log('real getting name: ' + id);
	return 'foo' + id;
}
getName = cacheable('name', { redis: redis, ttl: 3 })(getName);

getName(1).then(console.log);
getName(1).then(console.log);
```

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

export const getName = cacheable('redis:key:name', { ttl: 3 })(async (id, language) => {
	console.log('real getting name: ' + id + ' ' + language);
	return language+':' + id;
});

getName(1, 'en').then(console.log); //en:1
getName(1, 'cn').then(console.log); //cn:1
```




