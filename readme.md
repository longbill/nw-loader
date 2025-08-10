nw-loader
==========

cache data resource with smart auto-refresh and lock.

## Usage ##

`const loader = new NWLoader(name, loadFunction, options)`
`await loader.load(key)`

where the `key` could be: `number`, `string` or `object`.

```javascript
const NWLoader = require('nw-loader');
const loader = new NWLoader('user', function(user_id) {
	return db.getUser(user_id);
}, {
	useRedis: true,
	redisOptions: 'redis://127.0.0.1:6379' //options passed to ioredis
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
	//if you dont provide redis instance, it will use node-cache(in memory cache)
	redis: null, //ioredis instance

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

example: 

```javascript
const { cacheable } = require('nw-loader');

async function getName(id) {
	console.log('real getting name: ' + id);
	return 'foo' + id;
}
getName = cacheable('name', { ttl: 3 })(getName);

getName(1).then(console.log);
getName(1).then(console.log);
```

```javascript
import { cacheable } from 'nw-loader';

export const getName = cacheable('redis:key:name', { ttl: 3 })(async (id, language) => {
	console.log('real getting name: ' + id + ' ' + language);
	return language+':' + id;
});

getName(1, 'en').then(console.log); //en:1
getName(1, 'cn').then(console.log); //cn:1
```




