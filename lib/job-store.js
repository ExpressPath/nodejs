const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('./config');

class FileJobStore {
  constructor(dirPath) {
    this.dirPath = dirPath;
    this.readyPromise = null;
  }

  async ensureReady() {
    if (!this.readyPromise) {
      this.readyPromise = fs.mkdir(this.dirPath, { recursive: true });
    }

    await this.readyPromise;
  }

  getJobPath(jobId) {
    return path.join(this.dirPath, `${jobId}.json`);
  }

  async createJob(type, payload, metadata) {
    await this.ensureReady();

    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      type,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      payload,
      metadata: metadata || {},
      result: null,
      error: null
    };

    await fs.writeFile(this.getJobPath(job.id), JSON.stringify(job, null, 2), 'utf8');
    return job;
  }

  async getJob(jobId) {
    await this.ensureReady();

    try {
      const raw = await fs.readFile(this.getJobPath(jobId), 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async updateJob(jobId, patch) {
    const current = await this.getJob(jobId);
    if (!current) {
      return null;
    }

    const nextJob = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    await fs.writeFile(this.getJobPath(jobId), JSON.stringify(nextJob, null, 2), 'utf8');
    return nextJob;
  }

  async listJobs(query) {
    await this.ensureReady();

    const options = query || {};
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(100, Number(options.limit))) : 50;
    const dirEntries = await fs.readdir(this.dirPath);
    const jobs = [];

    for (const entry of dirEntries) {
      if (!entry.endsWith('.json')) {
        continue;
      }

      const raw = await fs.readFile(path.join(this.dirPath, entry), 'utf8');
      const job = JSON.parse(raw);

      if (options.status && job.status !== options.status) {
        continue;
      }

      if (options.type && job.type !== options.type) {
        continue;
      }

      jobs.push(job);
    }

    jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return jobs.slice(0, limit);
  }

  async deleteJob(jobId) {
    await this.ensureReady();

    try {
      await fs.unlink(this.getJobPath(jobId));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async cleanupExpiredJobs() {
    await this.ensureReady();

    const threshold = Date.now() - config.jobsRetentionMs;
    const dirEntries = await fs.readdir(this.dirPath);

    await Promise.all(dirEntries.map(async (entry) => {
      if (!entry.endsWith('.json')) {
        return;
      }

      const fullPath = path.join(this.dirPath, entry);
      const raw = await fs.readFile(fullPath, 'utf8');
      const job = JSON.parse(raw);
      const referenceTime = Date.parse(job.updatedAt || job.createdAt || new Date().toISOString());

      if (Number.isFinite(referenceTime) && referenceTime < threshold) {
        await fs.unlink(fullPath);
      }
    }));
  }
}

module.exports = new FileJobStore(config.jobsDir);