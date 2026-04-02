const config = require('./config');
const store = require('./job-store');
const {
  JOB_TYPE_CONVERT,
  JOB_TYPE_PROOF_CHECK,
  JOB_TYPE_SUBMIT,
  executeProofCheckJob,
  executeLambdaConversionJob,
  executeSubmitJob
} = require('./helper-service');

function serializeError(error) {
  return {
    message: error && error.message ? error.message : 'Unknown error',
    statusCode: error && error.statusCode ? error.statusCode : 500,
    details: error && error.details ? error.details : null
  };
}

class JobManager {
  constructor() {
    this.runningCount = 0;
    this.queue = [];
    this.handlers = new Map();
    this.cleanupTimer = null;
  }

  register(type, handler) {
    this.handlers.set(type, handler);
  }

  async bootstrap() {
    await store.ensureReady();
    await store.cleanupExpiredJobs();
  }

  startMaintenance() {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      store.cleanupExpiredJobs().catch((error) => {
        console.error(JSON.stringify({
          level: 'error',
          message: 'Failed to cleanup expired jobs',
          error: error.message,
          stack: error.stack
        }));
      });
    }, config.jobCleanupIntervalMs);

    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  async createJob(type, payload, metadata) {
    if (!this.handlers.has(type)) {
      const error = new Error(`Unsupported job type: ${type}`);
      error.statusCode = 400;
      throw error;
    }

    const job = await store.createJob(type, payload, metadata);
    this.queue.push(job.id);
    this.drainQueue();
    return job;
  }

  async getJob(jobId) {
    return store.getJob(jobId);
  }

  async listJobs(query) {
    return store.listJobs(query);
  }

  async deleteJob(jobId) {
    return store.deleteJob(jobId);
  }

  drainQueue() {
    while (this.runningCount < config.jobConcurrency && this.queue.length > 0) {
      const nextJobId = this.queue.shift();
      this.runningCount += 1;

      this.runJob(nextJobId)
        .catch((error) => {
          console.error(JSON.stringify({
            level: 'error',
            message: 'Job execution crashed',
            jobId: nextJobId,
            error: error.message,
            stack: error.stack
          }));
        })
        .finally(() => {
          this.runningCount -= 1;
          this.drainQueue();
        });
    }
  }

  async runJob(jobId) {
    const job = await store.getJob(jobId);
    if (!job) {
      return null;
    }

    const handler = this.handlers.get(job.type);
    if (!handler) {
      await store.updateJob(jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: serializeError(new Error(`Missing job handler for ${job.type}`))
      });
      return null;
    }

    await store.updateJob(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      attempts: (job.attempts || 0) + 1,
      error: null
    });

    try {
      const result = await handler(job.payload, job.metadata || {});
      return store.updateJob(jobId, {
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        result,
        error: null
      });
    } catch (error) {
      return store.updateJob(jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: serializeError(error)
      });
    }
  }
}

const jobManager = new JobManager();
jobManager.register(JOB_TYPE_PROOF_CHECK, executeProofCheckJob);
jobManager.register(JOB_TYPE_CONVERT, executeLambdaConversionJob);
jobManager.register(JOB_TYPE_SUBMIT, executeSubmitJob);

module.exports = jobManager;
