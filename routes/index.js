const express = require('express');
const config = require('../lib/config');
const { requireHelperAuth } = require('../lib/auth');
const { SUPPORTED_OPERATIONS, calculate } = require('../lib/calculator');
const { performProofCheck, performLambdaConversion, getHelperInfo } = require('../lib/helper-service');
const jobManager = require('../lib/job-manager');

const router = express.Router();

function healthPayload() {
  return {
    status: 'ok',
    service: config.serviceName,
    version: config.serviceVersion,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  };
}

function infoPayload() {
  return {
    service: config.serviceName,
    version: config.serviceVersion,
    environment: config.nodeEnv,
    auth: {
      required: !config.allowAnonymousHelper
    },
    capabilities: {
      health: true,
      calculation: true,
      proofCheck: true,
      submit: true,
      lambdaConvert: true,
      jobs: true
    },
    routes: {
      root: '/',
      health: '/healthz',
      ready: '/readyz',
      calculate: '/api/helper/calculate',
      proofCheck: '/api/helper/check',
      submit: '/api/helper/submit',
      lambdaConvert: '/api/helper/convert',
      createJob: '/api/helper/jobs',
      getJob: '/api/helper/jobs/:id',
      getJobResult: '/api/helper/jobs/:id/result',
      deleteJob: '/api/helper/jobs/:id'
    },
    operations: SUPPORTED_OPERATIONS,
    jobs: {
      concurrency: config.jobConcurrency,
      retentionMs: config.jobsRetentionMs
    },
    limits: {
      json: config.jsonLimit,
      urlencoded: config.urlencodedLimit,
      processTimeoutMs: config.processTimeoutMs,
      maxCodeBytes: config.maxCodeBytes,
      maxOutputChars: config.maxOutputChars
    },
    runtimes: getHelperInfo()
  };
}

function shouldRunAsync(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  switch (String(value || '').trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

function summarizePayload(payload) {
  const sourceCode = payload && typeof payload.code === 'string' ? payload.code : '';

  return {
    language: payload && payload.language ? payload.language : null,
    fileName: payload && payload.fileName ? payload.fileName : null,
    title: payload && payload.title ? payload.title : null,
    verify: payload && Object.prototype.hasOwnProperty.call(payload, 'verify') ? payload.verify : true,
    format: payload && payload.format ? payload.format : null,
    hasCode: Boolean(sourceCode),
    codeBytes: Buffer.byteLength(sourceCode, 'utf8')
  };
}

function summarizeJob(job, includeResult) {
  if (!job) {
    return null;
  }

  const summary = {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    attempts: job.attempts,
    metadata: job.metadata || {},
    payload: summarizePayload(job.payload || {}),
    error: job.error || null
  };

  if (includeResult) {
    summary.result = job.result || null;
  }

  return summary;
}

function statusCodeForResult(result) {
  if (result && result.ok) {
    return 200;
  }

  if (result && result.timedOut) {
    return 504;
  }

  return 422;
}

function handleCalculation(req, res, next) {
  try {
    const body = req.body || {};
    const result = calculate(body.operation, body.values);

    res.json({
      success: true,
      requestId: req.id,
      operation: String(body.operation).trim().toLowerCase(),
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
}

router.get('/', (req, res) => {
  res.json({
    success: true,
    requestId: req.id,
    message: 'Railway helper API is running.',
    ...infoPayload()
  });
});

router.get('/health', (req, res) => {
  res.json(healthPayload());
});

router.get('/healthz', (req, res) => {
  res.json(healthPayload());
});

router.get('/readyz', (req, res) => {
  res.json({
    ...healthPayload(),
    ready: true
  });
});

router.post('/calculate', handleCalculation);
router.use('/api/helper', requireHelperAuth);
router.post('/api/helper/calculate', handleCalculation);

router.get('/api/helper/info', (req, res) => {
  res.json({
    success: true,
    requestId: req.id,
    ...infoPayload()
  });
});

router.post('/api/helper/check', async (req, res, next) => {
  try {
    const payload = req.body || {};

    if (shouldRunAsync(payload.async)) {
      const job = await jobManager.createJob('proof-check', payload, {
        requestId: req.id,
        route: req.originalUrl
      });

      return res.status(202).json({
        success: true,
        requestId: req.id,
        job: summarizeJob(job, false)
      });
    }

    const result = await performProofCheck(payload);
    return res.status(statusCodeForResult(result)).json({
      success: result.ok,
      requestId: req.id,
      result
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/helper/convert', async (req, res, next) => {
  try {
    const payload = req.body || {};

    if (shouldRunAsync(payload.async)) {
      const job = await jobManager.createJob('lambda-convert', payload, {
        requestId: req.id,
        route: req.originalUrl
      });

      return res.status(202).json({
        success: true,
        requestId: req.id,
        job: summarizeJob(job, false)
      });
    }

    const result = await performLambdaConversion(payload);
    return res.status(statusCodeForResult(result)).json({
      success: result.ok,
      requestId: req.id,
      result
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/helper/submit', async (req, res, next) => {
  try {
    const payload = req.body || {};

    if (shouldRunAsync(payload.async)) {
      const job = await jobManager.createJob('lambda-convert', payload, {
        requestId: req.id,
        route: req.originalUrl
      });

      return res.status(202).json({
        success: true,
        requestId: req.id,
        job: summarizeJob(job, false)
      });
    }

    const result = await performLambdaConversion(payload);
    return res.status(statusCodeForResult(result)).json({
      success: result.ok,
      requestId: req.id,
      result
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/helper/jobs', async (req, res, next) => {
  try {
    const body = req.body || {};
    const type = body.type;
    const payload = body.payload || {};

    if (!type) {
      const error = new Error('type is required');
      error.statusCode = 400;
      throw error;
    }

    const job = await jobManager.createJob(type, payload, {
      requestId: req.id,
      route: req.originalUrl
    });

    res.status(202).json({
      success: true,
      requestId: req.id,
      job: summarizeJob(job, false)
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api/helper/jobs', async (req, res, next) => {
  try {
    const jobs = await jobManager.listJobs({
      status: req.query.status,
      type: req.query.type,
      limit: req.query.limit
    });

    res.json({
      success: true,
      requestId: req.id,
      jobs: jobs.map((job) => summarizeJob(job, false))
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api/helper/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobManager.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        success: false,
        requestId: req.id,
        error: 'Job not found'
      });
    }

    return res.json({
      success: true,
      requestId: req.id,
      job: summarizeJob(job, true)
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/helper/jobs/:id/result', async (req, res, next) => {
  try {
    const job = await jobManager.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        success: false,
        requestId: req.id,
        error: 'Job not found'
      });
    }

    if (job.status !== 'succeeded') {
      return res.status(409).json({
        success: false,
        requestId: req.id,
        error: 'Job result is not ready',
        job: summarizeJob(job, false)
      });
    }

    return res.json({
      success: true,
      requestId: req.id,
      result: job.result
    });
  } catch (error) {
    return next(error);
  }
});

router.delete('/api/helper/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobManager.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        success: false,
        requestId: req.id,
        error: 'Job not found'
      });
    }

    if (job.status === 'running' || job.status === 'queued') {
      return res.status(409).json({
        success: false,
        requestId: req.id,
        error: 'Cannot delete a queued or running job'
      });
    }

    await jobManager.deleteJob(req.params.id);
    return res.json({
      success: true,
      requestId: req.id,
      deleted: true
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
