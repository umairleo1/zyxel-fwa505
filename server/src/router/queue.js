// One-at-a-time scheduler for router requests. The router's web server is a
// small CGI process: concurrent calls only queue up on the device, and parallel
// logins would race each other. Jobs run strictly in turn, high priority first,
// with a short gap between back-to-back jobs so the router's own admin page
// (and anything else on the device) gets a turn.

import { performance } from 'node:perf_hooks';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Monotonic: a wall-clock step (NTP sync on a Pi without an RTC) must not stall the queue.
const now = () => performance.now();

export class RequestQueue {
  /**
   * gapMs: idle time enforced between the end of one job and the start of the next.
   * onRun({ priority, waitMs }): called as each job starts, for load accounting.
   */
  constructor({ gapMs = 0, onRun = null } = {}) {
    this.gapMs = gapMs;
    this.onRun = onRun;
    this.lanes = { high: [], normal: [] };
    this.running = false;
    this.lastEnd = -Infinity; // monotonic ms; nothing has run yet
  }

  get size() {
    return this.lanes.high.length + this.lanes.normal.length;
  }

  /** Queue fn; resolves or rejects with its result. priority: 'high' | 'normal'. */
  run(fn, { priority = 'normal' } = {}) {
    const lane = this.lanes[priority];
    if (!lane) return Promise.reject(new Error(`Unknown priority ${priority}`));
    return new Promise((resolve, reject) => {
      lane.push({ fn, priority, resolve, reject, queuedAt: now() });
      this.#pump();
    });
  }

  async #pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.size) {
        // Wait out the gap first, then pick: a high-priority job queued meanwhile goes next.
        const wait = this.lastEnd + this.gapMs - now();
        if (wait > 0) await sleep(wait);
        const job = this.lanes.high.shift() ?? this.lanes.normal.shift();
        try {
          this.onRun?.({ priority: job.priority, waitMs: Math.round(now() - job.queuedAt) });
        } catch {
          // accounting must never stall the queue
        }
        try {
          job.resolve(await job.fn());
        } catch (e) {
          job.reject(e);
        } finally {
          this.lastEnd = now();
        }
      }
    } finally {
      this.running = false;
    }
  }
}
