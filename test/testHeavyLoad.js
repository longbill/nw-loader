const { describe, it, beforeEach, afterEach } = require('node:test');
const NWLoader = require('../index');
const Redis = require('ioredis');
const assert = require('assert');
const wait = require('delay');


describe('NWLoader', function() {

  it('should load data less than or equals 3 times', async () => {
    const startTime = Date.now();
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const redisClient = new Redis(redisUrl);

    let callCnt = 0;

    // Create a loader instance with a short TTL for testing
    const loader = new NWLoader('test-loader', async (key) => {
      callCnt++;
      console.log((Date.now() - startTime) / 1000, 'getting', key, 'callCnt=', callCnt);
    }, {
      redis: redisClient,
      ttl: 5,
      keyPrefix: 'test-nwloader-heavy'
    });


    //run heavy load for 10 seconds
    for(let i = 0; i < 100; i++) {
      await Promise.all([
        loader.load(1),
        loader.load(1),
        loader.load(1),
        loader.load(1),
        loader.load(1),
        loader.load(1),
        loader.load(1),
        loader.load(1)
      ]);
      await wait(100);
    }

    await redisClient.quit();

    assert(callCnt <= 3);

  });
});