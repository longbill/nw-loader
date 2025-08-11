const { describe, it, beforeEach, afterEach } = require('node:test');
const NWLoader = require('../index');
const Redis = require('ioredis');
const assert = require('assert');
const delay = require('delay');

describe('NWLoader', function() {
  let redisClient;
  let testLoader;
  
  // Mock data for testing
  const mockData = { id: 1, name: 'Test User', email: 'test@example.com' };
  const mockLoaderFunction = async (id) => {
    // Simulate some async work
    await delay(10);
    if (id === 'error') {
      throw new Error('Simulated loader error');
    }
    return { ...mockData, id };
  };

  beforeEach(() => {
    // Use a unique Redis URL if provided, otherwise default to localhost
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = new Redis(redisUrl);
    
    // Create a loader instance with a short TTL for testing
    testLoader = new NWLoader('test-loader', mockLoaderFunction, {
      redis: redisClient,
      ttl: 2, // 2 seconds for faster testing
      keyPrefix: 'test-nwloader'
    });
  });

  afterEach(async () => {
    // Clean up Redis connection after each test
    if (redisClient) {
      // Clear test keys
      const keys = await redisClient.keys('test-nwloader:*');
      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
      await redisClient.quit();
    }
  });

  it('should create a loader instance with valid parameters', () => {
    assert.ok(testLoader instanceof NWLoader);
    assert.strictEqual(testLoader.name, 'test-loader');
    assert.strictEqual(testLoader.loader, mockLoaderFunction);
    assert.strictEqual(testLoader.options.ttl, 2);
    assert.strictEqual(testLoader.options.keyPrefix, 'test-nwloader');
  });

  it('should throw error when creating loader without redis instance', () => {
    assert.throws(() => {
      new NWLoader('test', mockLoaderFunction);
    }, /NWLoader now requires a Redis-like instance/);
  });

  it('should throw error when creating loader with invalid name', () => {
    assert.throws(() => {
      new NWLoader('', mockLoaderFunction, { redis: redisClient });
    }, /NWLoader need first argument to be a valid string/);
    
    assert.throws(() => {
      new NWLoader(null, mockLoaderFunction, { redis: redisClient });
    }, /NWLoader need first argument to be a valid string/);
  });

  it('should generate proper cache keys', () => {
    const key1 = testLoader.getKey('user1');
    const key2 = testLoader.getKey(123);
    const key3 = testLoader.getKey({ id: 1 });
    
    assert.strictEqual(key1, 'test-nwloader:test-loader:user1');
    assert.strictEqual(key2, 'test-nwloader:test-loader:123');
    // Object keys should be hashed - using the actual md5 function to get the correct hash
    const expectedHash = require('../md5')(JSON.stringify({ id: 1 }));
    assert.strictEqual(key3, `test-nwloader:test-loader:${expectedHash}`);
  });

  it('should load data and cache it', async () => {
    const result = await testLoader.load('user1');
    
    assert.deepStrictEqual(result, { ...mockData, id: 'user1' });
    
    // Check that data was cached
    const cachedResult = await testLoader.load('user1');
    assert.deepStrictEqual(cachedResult, { ...mockData, id: 'user1' });
  });

  it('should handle object keys correctly', async () => {
    const objKey = { userId: 1, type: 'profile' };
    const result = await testLoader.load(objKey);
    
    assert.deepStrictEqual(result, { ...mockData, id: objKey });
    
    // Loading with the same object should return cached data
    const cachedResult = await testLoader.load(objKey);
    assert.deepStrictEqual(cachedResult, { ...mockData, id: objKey });
  });

  it('should refresh cache in background after TTL expires', async () => {
    // Load data initially
    const result1 = await testLoader.load('user1');
    assert.deepStrictEqual(result1, { ...mockData, id: 'user1' });
    
    // Wait for cache to expire (TTL is 2 seconds, but we use 2*ttl for storage)
    await delay(2500);
    
    // Load again - should return cached data immediately
    const result2 = await testLoader.load('user1');
    assert.deepStrictEqual(result2, { ...mockData, id: 'user1' });
    
    // Wait a bit more to ensure background refresh happens
    await delay(100);
  });

  it('should handle concurrent requests properly', async () => {
    // Start multiple concurrent requests
    const promises = [
      testLoader.load('concurrent1'),
      testLoader.load('concurrent1'),
      testLoader.load('concurrent1')
    ];
    
    const results = await Promise.all(promises);
    
    // All should return the same result
    results.forEach(result => {
      assert.deepStrictEqual(result, { ...mockData, id: 'concurrent1' });
    });
  });

  it('should only execute loader function once for concurrent requests and respect cache TTL', async () => {
    let callCount = 0;
    const countingLoaderFunction = async (id) => {
      callCount++;
      // console.log('call loader func', callCount);
      await delay(10);
      return { ...mockData, id, callCount };
    };

    const loader = new NWLoader('counting-loader', countingLoaderFunction, {
      redis: redisClient,
      ttl: 2, // 2 seconds TTL for testing
      keyPrefix: 'test-nwloader-counting'
    });

    // First batch of concurrent requests
    const promises1 = [
      loader.load('test-key'),
      loader.load('test-key'),
      loader.load('test-key')
    ];
    
    const results1 = await Promise.all(promises1);
    
    // All should return the same result with callCount = 1
    results1.forEach(result => {
      assert.deepStrictEqual(result, { ...mockData, id: 'test-key', callCount: 1 });
    });
    
    // Loader function should only be called once
    assert.strictEqual(callCount, 1);
    
    // Second batch of concurrent requests (should use cache)
    const promises2 = [
      loader.load('test-key'),
      loader.load('test-key'),
      loader.load('test-key')
    ];
    
    const results2 = await Promise.all(promises2);
    
    // All should return the same result with callCount = 1 (from cache)
    results2.forEach(result => {
      assert.deepStrictEqual(result, { ...mockData, id: 'test-key', callCount: 1 });
    });
    
    // Loader function should still only be called once
    assert.strictEqual(callCount, 1);
    
    // Wait for cache to expire
    await delay(2000); // Wait 2 seconds
    
    // Third batch of concurrent requests (should not call loader)
    const promises3 = [
      loader.load('test-key'),
      loader.load('test-key'),
      loader.load('test-key')
    ];
    
    const results3 = await Promise.all(promises3);
    
    // All should return the same result with callCount = 2
    results3.forEach(result => {
      assert.deepStrictEqual(result, { ...mockData, id: 'test-key', callCount: 1 });
    });

    assert.strictEqual(callCount, 1);

    //wait for background update
    await delay(20);

    assert.strictEqual(callCount, 2);

    const promises4 = [
      loader.load('test-key'),
      loader.load('test-key'),
      loader.load('test-key')
    ];
    
    const results4 = await Promise.all(promises4);

    results4.forEach(result => {
      assert.deepStrictEqual(result, { ...mockData, id: 'test-key', callCount: 2 });
    });

    assert.strictEqual(callCount, 2);
    
  });

  it('should handle loader function errors', async () => {
    // This test checks that we can catch errors from the loader function
    try {
      await testLoader.load('error');
      // If we reach here, the test should fail
      assert.fail('Expected error was not thrown');
    } catch (err) {
      assert.match(err.message, /Simulated loader error/);
    }
  });

  it('should clear cached data', async () => {
    // Load data to cache it
    await testLoader.load('user-to-clear');
    
    // Verify it's in cache
    const result1 = await testLoader.load('user-to-clear');
    assert.ok(result1);
    
    // Clear the cache
    const cleared = await testLoader.clear('user-to-clear');
    assert.strictEqual(cleared, 1);
    
    // Try to load again - should call loader function
    const result2 = await testLoader.load('user-to-clear');
    assert.deepStrictEqual(result2, { ...mockData, id: 'user-to-clear' });
  });

  it('should prime cache with manual data', async () => {
    const manualData = { id: 'manual', custom: true };
    
    // Prime the cache
    const primed = await testLoader.prime('manual-key', manualData);
    assert.strictEqual(primed, true);
    
    // Load should return the primed data
    const result = await testLoader.load('manual-key');
    assert.deepStrictEqual(result, manualData);
  });

  it('should handle numeric keys correctly', async () => {
    const result = await testLoader.load(123);
    assert.deepStrictEqual(result, { ...mockData, id: 123 });
    
    // Second call should return cached data
    const cachedResult = await testLoader.load(123);
    assert.deepStrictEqual(cachedResult, { ...mockData, id: 123 });
  });

  it('should determine if cache needs refresh correctly', async () => {
    const key = testLoader.getKey('refresh-test');
    
    // Initially should need refresh
    let needsRefresh = await testLoader.needsRefresh(key);
    assert.strictEqual(needsRefresh, true);
    
    // Load data to cache it
    await testLoader.load('refresh-test');
    
    // Should not need refresh immediately
    needsRefresh = await testLoader.needsRefresh(key);
    assert.strictEqual(needsRefresh, false);
    
    // Wait for half the TTL (1 second)
    await delay(1000);
    
    // Should still not need refresh (since we use 2*ttl for storage)
    needsRefresh = await testLoader.needsRefresh(key);
    assert.strictEqual(needsRefresh, false);
    
    // Wait for more time to pass TTL
    await delay(1500);
    
    // Should now need refresh
    needsRefresh = await testLoader.needsRefresh(key);
    assert.strictEqual(needsRefresh, true);
  });
});