const { describe, it, beforeEach, afterEach } = require('node:test');
const Redis = require('ioredis');
const assert = require('assert');
const delay = require('delay');
const { cacheable } = require('../index');

describe('cacheable decorator', function() {
  let redisClient;
  
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
  });

  afterEach(async () => {
    // Clean up Redis connection after each test
    if (redisClient) {
      // Clear test keys
      const keys = await redisClient.keys('test-cacheable:*');
      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
      await redisClient.quit();
    }
  });

  it('should create a cacheable function with valid parameters', () => {
    const cachedFunction = cacheable('test-cacheable', { 
      redis: redisClient,
      ttl: 2,
      keyPrefix: 'test-cacheable'
    })(mockLoaderFunction);
    
    assert.ok(typeof cachedFunction === 'function');
  });

  it('should throw error when creating cacheable without redis instance', () => {
    assert.throws(() => {
      cacheable('test-cacheable', {})(mockLoaderFunction);
    }, /cacheable decorator requires a Redis-like instance/);
  });

  it('should load data and cache it using cacheable decorator', async () => {
    const cachedFunction = cacheable('test-cacheable', { 
      redis: redisClient,
      ttl: 2,
      keyPrefix: 'test-cacheable'
    })(mockLoaderFunction);
    
    const result = await cachedFunction('user1');
    assert.deepStrictEqual(result, { ...mockData, id: 'user1' });
    
    // Second call should return cached data
    const cachedResult = await cachedFunction('user1');
    assert.deepStrictEqual(cachedResult, { ...mockData, id: 'user1' });
  });

  it('should handle concurrent requests with cacheable decorator', async () => {
    const cachedFunction = cacheable('test-concurrent', { 
      redis: redisClient,
      ttl: 2,
      keyPrefix: 'test-cacheable'
    })(mockLoaderFunction);
    
    // Start multiple concurrent requests
    const promises = [
      cachedFunction('concurrent1'),
      cachedFunction('concurrent1'),
      cachedFunction('concurrent1')
    ];
    
    const results = await Promise.all(promises);
    
    // All should return the same result
    results.forEach(result => {
      assert.deepStrictEqual(result, { ...mockData, id: 'concurrent1' });
    });
  });

  it('should handle errors in cacheable functions', async () => {
    const cachedFunction = cacheable('test-error', { 
      redis: redisClient,
      ttl: 2,
      keyPrefix: 'test-cacheable'
    })(mockLoaderFunction);
    
    // This test checks that we can catch errors from the cached function
    try {
      await cachedFunction('error');
      // If we reach here, the test should fail
      assert.fail('Expected error was not thrown');
    } catch (err) {
      assert.match(err.message, /Simulated loader error/);
    }
  });

  it('should work with multiple arguments', async () => {
    const multiArgFunction = async (id, lang) => {
      await delay(10);
      return `${id}-${lang}`;
    };
    
    const cachedFunction = cacheable('test-multi-arg', { 
      redis: redisClient,
      ttl: 2,
      keyPrefix: 'test-cacheable'
    })(multiArgFunction);
    
    const result = await cachedFunction('user1', 'en');
    assert.strictEqual(result, 'user1-en');
    
    // Second call should return cached data
    const cachedResult = await cachedFunction('user1', 'en');
    assert.strictEqual(cachedResult, 'user1-en');
  });

  it('should differentiate cache keys for different arguments', async () => {
    const multiArgFunction = async (id, lang) => {
      await delay(10);
      return `${id}-${lang}`;
    };
    
    const cachedFunction = cacheable('test-different-args', { 
      redis: redisClient,
      ttl: 2,
      keyPrefix: 'test-cacheable'
    })(multiArgFunction);
    
    const result1 = await cachedFunction('user1', 'en');
    const result2 = await cachedFunction('user1', 'fr');
    const result3 = await cachedFunction('user2', 'en');
    
    assert.strictEqual(result1, 'user1-en');
    assert.strictEqual(result2, 'user1-fr');
    assert.strictEqual(result3, 'user2-en');
    
    // Verify they are cached separately
    const cached1 = await cachedFunction('user1', 'en');
    const cached2 = await cachedFunction('user1', 'fr');
    const cached3 = await cachedFunction('user2', 'en');
    
    assert.strictEqual(cached1, 'user1-en');
    assert.strictEqual(cached2, 'user1-fr');
    assert.strictEqual(cached3, 'user2-en');
  });
});