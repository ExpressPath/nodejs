const express = require('express');
const config = require('../lib/config');
const { requireHelperAuth } = require('../lib/auth');
const { SUPPORTED_OPERATIONS, calculate } = require('../lib/calculator');
const {
  JOB_TYPE_CONVERT,
  JOB_TYPE_PROOF_CHECK,
  JOB_TYPE_SUBMIT,
  getHelperInfo,
  performLambdaConversion,
  performProofCheck,
  performSubmit
} = require('../lib/helper-service');
const jobManager = require('../lib/job-manager');

const router = express.Router();

const PUBLIC_ROUTES = {
  root: '/',
  health: '/healthz',
  ready: '/readyz'
};

const HELPER_ROUTES = {
  calculate: '/api/helper/calculate',
  proofCheck: '/api/helper/check',
  submit: '/api/helper/submit',
  lambdaConvert: '/api/helper/convert',
  createJob: '/api/helper/jobs',
  getJob: '/api/helper/jobs/:id',
  getJobResult: '/api/helper/jobs/:id/result',
  deleteJob: '/api/helper/jobs/:id'
};

const JOB_TYPES = {
  proofCheck: JOB_TYPE_PROOF_CHECK,
  convert: JOB_TYPE_CONVERT,
  submit: JOB_TYPE_SUBMIT
};

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
      cicConvert: true,
      jobs: true
    },
    routes: {
      ...PUBLIC_ROUTES,
      ...HELPER_ROUTES
    },
    jobTypes: JOB_TYPES,
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

function sendResult(res, req, result) {
  return res.status(statusCodeForResult(result)).json({
    success: Boolean(result && result.ok),
    requestId: req.id,
    result
  });
}

function sendAcceptedJob(res, req, job) {
  return res.status(202).json({
    success: true,
    requestId: req.id,
    job: summarizeJob(job, false)
  });
}

function sendNotFound(res, req, message) {
  return res.status(404).json({
    success: false,
    requestId: req.id,
    error: message || 'Not found'
  });
}

function buildJobMetadata(req) {
  return {
    requestId: req.id,
    route: req.originalUrl
  };
}

function wrapAsync(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function createOperationHandler(options) {
  return wrapAsync(async (req, res) => {
    const payload = req.body || {};

    if (shouldRunAsync(payload.async)) {
      const job = await jobManager.createJob(options.jobType, payload, buildJobMetadata(req));
      return sendAcceptedJob(res, req, job);
    }

    const result = await options.execute(payload);
    return sendResult(res, req, result);
  });
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

router.get(PUBLIC_ROUTES.root, (req, res) => {
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

router.get(PUBLIC_ROUTES.health, (req, res) => {
  res.json(healthPayload());
});

router.get(PUBLIC_ROUTES.ready, (req, res) => {
  res.json({
    ...healthPayload(),
    ready: true
  });
});

router.post('/calculate', handleCalculation);
router.use('/api/helper', requireHelperAuth);
router.post(HELPER_ROUTES.calculate, handleCalculation);

router.get('/api/helper/info', (req, res) => {
  res.json({
    success: true,
    requestId: req.id,
    ...infoPayload()
  });
});

router.post('/api/helper/check', createOperationHandler({
  jobType: JOB_TYPE_PROOF_CHECK,
  execute: performProofCheck
}));

router.post('/api/helper/convert', createOperationHandler({
  jobType: JOB_TYPE_CONVERT,
  execute: performLambdaConversion
}));

router.post('/api/helper/submit', createOperationHandler({
  jobType: JOB_TYPE_SUBMIT,
  execute: performSubmit
}));

router.post('/api/helper/jobs', wrapAsync(async (req, res) => {
  const body = req.body || {};
  const type = body.type;
  const payload = body.payload || {};

  if (!type) {
    const error = new Error('type is required');
    error.statusCode = 400;
    throw error;
  }

  const job = await jobManager.createJob(type, payload, buildJobMetadata(req));
  return sendAcceptedJob(res, req, job);
}));

router.get('/api/helper/jobs', wrapAsync(async (req, res) => {
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
}));

router.get('/api/helper/jobs/:id', wrapAsync(async (req, res) => {
  const job = await jobManager.getJob(req.params.id);
  if (!job) {
    return sendNotFound(res, req, 'Job not found');
  }

  return res.json({
    success: true,
    requestId: req.id,
    job: summarizeJob(job, true)
  });
}));

router.get('/api/helper/jobs/:id/result', wrapAsync(async (req, res) => {
  const job = await jobManager.getJob(req.params.id);
  if (!job) {
    return sendNotFound(res, req, 'Job not found');
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
}));

router.delete('/api/helper/jobs/:id', wrapAsync(async (req, res) => {
  const job = await jobManager.getJob(req.params.id);
  if (!job) {
    return sendNotFound(res, req, 'Job not found');
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
}));

module.exports = router;
