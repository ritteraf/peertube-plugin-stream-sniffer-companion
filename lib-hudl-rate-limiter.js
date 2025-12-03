// Centralized HUDL API request queue and rate limiter
// Ensures all HUDL API calls (from all endpoints, jobs, and sniffers) are throttled
// Usage: await hudlLimiter.enqueue(() => hudlApiCall(...))

class HudlRateLimiter {
  constructor({ minDelayMs = 10000, maxRequestsPerDay = 1000 } = {}) {
    this.queue = [];
    this.isProcessing = false;
    this.minDelayMs = minDelayMs;
    this.maxRequestsPerDay = maxRequestsPerDay;
    this.requestCount = 0;
    this.dayStart = Date.now();
  }

  async enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    while (this.queue.length > 0) {
      // Reset daily counter if a new day has started
      if (Date.now() - this.dayStart > 24 * 60 * 60 * 1000) {
        this.requestCount = 0;
        this.dayStart = Date.now();
      }
      if (this.requestCount >= this.maxRequestsPerDay) {
        const err = new Error('Internal HUDL rate limit exceeded');
        this.queue.forEach(({ reject }) => reject(err));
        this.queue = [];
        break;
      }
      const { fn, resolve, reject } = this.queue.shift();
      try {
        const result = await fn();
        this.requestCount++;
        resolve(result);
      } catch (e) {
        reject(e);
      }
      await new Promise(r => setTimeout(r, this.minDelayMs));
    }
    this.isProcessing = false;
  }
}

// Singleton instance (shared across all plugin code)
if (!global.__HUDL_RATE_LIMITER__) {
  global.__HUDL_RATE_LIMITER__ = new HudlRateLimiter({ minDelayMs: 10000, maxRequestsPerDay: 1000 });
}

module.exports = global.__HUDL_RATE_LIMITER__;
