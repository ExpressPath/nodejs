import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_CODE_BYTES = Number(process.env.HELPER_MAX_CODE_BYTES || 200000);
const SERVICE_NAME = String(process.env.SERVICE_NAME || 'ivucx-railway-helper').trim() || 'ivucx-railway-helper';
const SERVICE_VERSION = String(process.env.SERVICE_VERSION || '1.7.0').trim() || '1.7.0';

const HELPER_API_KEY = String(process.env.HELPER_API_KEY || '').trim();
const EXECUTION_SERVER_BASE_URL = String(process.env.EXECUTION_SERVER_BASE_URL || '').trim().replace(/\/+$/, '');
const EXECUTION_SERVER_API_KEY = String(process.env.EXECUTION_SERVER_API_KEY || '').trim();
const EXECUTION_SERVER_TIMEOUT_MS = Number(process.env.EXECUTION_SERVER_TIMEOUT_MS || 180000);
const EXECUTION_SERVER_CONVERT_ROUTE = String(process.env.EXECUTION_SERVER_CONVERT_ROUTE || '/api/proof-convert').trim();
const EXECUTION_SERVER_LEAN_CHECK_ROUTE = String(process.env.EXECUTION_SERVER_LEAN_CHECK_ROUTE || '/api/lean-check').trim();
const EXECUTION_SERVER_COQ_CHECK_ROUTE = String(process.env.EXECUTION_SERVER_COQ_CHECK_ROUTE || '/api/coq-check').trim();

const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed'
};

const PLAN_STATUS = {
  QUEUED: 'queued',
  PLANNING: 'planning',
  READY: 'ready',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed'
};

const jobs = new Map();
let supabaseClient = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!HELPER_API_KEY) {
    next();
    return;
  }
  const auth = String(req.headers.authorization || '');
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) {
    res.status(401).json({ ok: false, error: 'Missing helper authorization.' });
    return;
  }
  const received = Buffer.from(auth.slice(prefix.length));
  const expected = Buffer.from(HELPER_API_KEY);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.status(403).json({ ok: false, error: 'Invalid helper authorization.' });
    return;
  }
  next();
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    supabaseConfigured: !!getSupabaseAdmin().client,
    execution: getExecutionInfo(),
    roles: getRoleInfo()
  });
});

app.get('/api/helper/info', (_req, res) => {
  const supabase = getSupabaseAdmin();
  res.status(200).json({
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    supabaseConfigured: !!supabase.client,
    executionConfigured: !!EXECUTION_SERVER_BASE_URL,
    roles: getRoleInfo(),
    capabilities: {
      proofCheck: true,
      convert: true,
      submit: true,
      cicConvert: true,
      planState: true,
      asyncJobs: true
    },
    routes: [
      'GET /api/helper/info',
      'POST /api/helper/check',
      'POST /api/helper/submit',
      'POST /api/helper/convert',
      'GET /api/helper/jobs',
      'GET /api/helper/jobs/:id',
      'GET /api/helper/jobs/:id/result',
      'DELETE /api/helper/jobs/:id'
    ],
    runtimes: {
      executionModel: {
        stateStore: supabase.client ? 'supabase' : 'memory',
        planning: 'railway',
        proofCheck: EXECUTION_SERVER_BASE_URL ? 'render' : 'unconfigured',
        conversion: EXECUTION_SERVER_BASE_URL ? 'render' : 'unconfigured'
      },
      conversionRuntimes: {
        typedLambda: buildConversionAvailability(),
        cic: buildConversionAvailability()
      }
    },
    execution: getExecutionInfo()
  });
});

app.post('/api/helper/check', async (req, res) => {
  try {
    const payload = normalizeProofPayload(req.body || {});
    const verification = await requestExecutionCheck(payload);
    res.status(statusCodeForVerification(verification)).json({ ok: verification.ok, verification });
  } catch (err) {
    res.status(err && err.statusCode ? err.statusCode : 400).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.post('/api/helper/submit', async (req, res) => {
  await handlePlannedRequest(req, res, 'submit');
});

app.post('/api/helper/convert', async (req, res) => {
  await handlePlannedRequest(req, res, 'convert');
});

app.get('/api/helper/jobs', async (_req, res) => {
  try {
    const list = await listJobs();
    res.status(200).json({ ok: true, jobs: list.map(publicJob) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

app.get('/api/helper/jobs/:id/result', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Helper job not found.' });
    return;
  }
  if (job.status !== JOB_STATUS.SUCCEEDED) {
    res.status(409).json({ ok: false, error: 'Helper job is not finished yet.', job: publicJob(job) });
    return;
  }
  res.status(200).json({ ok: true, result: job.result });
});

app.get('/api/helper/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Helper job not found.' });
    return;
  }
  res.status(200).json({ ok: true, job: publicJob(job) });
});

app.delete('/api/helper/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Helper job not found.' });
    return;
  }
  jobs.delete(job.id);
  const { client } = getSupabaseAdmin();
  if (client) {
    await client.from('helper_jobs').delete().eq('id', job.id);
  }
  res.status(200).json({ ok: true, removed: true, jobId: job.id });
});

startServer().catch((err) => {
  console.error('Failed to start ivucx railway helper', err);
  process.exit(1);
});

function getRoleInfo() {
  return {
    stateStore: 'supabase',
    planner: 'railway',
    executor: 'render'
  };
}

function buildConversionAvailability() {
  return {
    lean: {
      available: !!EXECUTION_SERVER_BASE_URL,
      planner: 'railway',
      executor: EXECUTION_SERVER_BASE_URL ? 'render' : 'unconfigured',
      stateStore: 'supabase'
    },
    coq: {
      available: !!EXECUTION_SERVER_BASE_URL,
      planner: 'railway',
      executor: EXECUTION_SERVER_BASE_URL ? 'render' : 'unconfigured',
      stateStore: 'supabase'
    }
  };
}

function getExecutionInfo() {
  return {
    configured: !!EXECUTION_SERVER_BASE_URL,
    baseUrl: EXECUTION_SERVER_BASE_URL || null,
    convertRoute: EXECUTION_SERVER_CONVERT_ROUTE,
    leanCheckRoute: EXECUTION_SERVER_LEAN_CHECK_ROUTE,
    coqCheckRoute: EXECUTION_SERVER_COQ_CHECK_ROUTE,
    timeoutMs: EXECUTION_SERVER_TIMEOUT_MS
  };
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return { client: null, error: 'Supabase environment variables are missing.' };
  }
  if (!supabaseClient) {
    supabaseClient = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return { client: supabaseClient, error: null };
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function truncateOutput(text, limit = 12000) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `\n...[output truncated ${value.length - limit} chars]`;
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_err) {
    return null;
  }
}
function normalizeProofPayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const language = resolveLanguage(body.language);
  if (language !== 'Lean' && language !== 'Coq') {
    throw new Error('Only Lean and Coq are supported by the helper service.');
  }
  const fileName = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim() : defaultFileName(language);
  const code = typeof body.code === 'string' ? body.code : '';
  const format = typeof body.format === 'string' && body.format.trim() ? body.format.trim() : 'typed-lambda-v1';
  const verify = body.verify !== false;

  if (!code.trim()) {
    throw new Error('Proof code is required.');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new Error('Proof code exceeds helper size limit.');
  }

  return { title, language, fileName, code, format, verify };
}

function resolveLanguage(value) {
  const input = String(value || '').trim().toLowerCase();
  if (input === 'coq') return 'Coq';
  return 'Lean';
}

function defaultFileName(language) {
  return language === 'Coq' ? 'Main.v' : 'Main.lean';
}

function normalizeProofState(value) {
  const proofState = String(value || '').trim().toUpperCase();
  return /^(YY|NY|YN|NN)$/.test(proofState) ? proofState : '';
}

function createProgress(percent, stage, message) {
  return {
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    stage: String(stage || '').trim() || 'working',
    message: String(message || '').trim() || 'Working',
    updatedAt: nowIso()
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    operation: job.operation || 'convert',
    title: job.title,
    language: job.language,
    fileName: job.fileName,
    format: job.format,
    planId: job.planId || null,
    progress: job.progress || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.status === JOB_STATUS.SUCCEEDED ? job.result : null,
    error: job.status === JOB_STATUS.FAILED ? job.error : null,
    problemId: job.problemId || null
  };
}

async function handlePlannedRequest(req, res, operation) {
  try {
    const payload = normalizeProofPayload(req.body || {});
    const wantsAsync = req.body && req.body.async !== false;

    if (!wantsAsync) {
      const plan = await createConversionPlan(payload, operation, null);
      const result = await executePlannedOperation(plan, null);
      res.status(statusCodeForResult(result)).json({ ok: Boolean(result.ok), result });
      return;
    }

    const job = await createPlannedJob(payload, operation);
    res.status(202).json({ ok: true, job: publicJob(job) });

    queueMicrotask(() => {
      executeJob(job.id).catch((err) => {
        console.error('helper job failed', err);
      });
    });
  } catch (err) {
    res.status(err && err.statusCode ? err.statusCode : 400).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function createPlannedJob(payload, operation) {
  const job = {
    id: randomUUID(),
    status: JOB_STATUS.QUEUED,
    operation,
    title: payload.title,
    language: payload.language,
    fileName: payload.fileName,
    format: payload.format,
    sourceSha256: sha256(payload.code),
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    progress: createProgress(10, 'planning', 'Planning'),
    result: null,
    error: null,
    problemId: null,
    planId: null
  };
  const plan = await createConversionPlan(payload, operation, job.id);
  job.planId = plan.id;
  await persistJob(job);
  jobs.set(job.id, job);
  return job;
}

async function createConversionPlan(payload, operation, helperJobId) {
  const { client, error } = getSupabaseAdmin();
  if (!client) {
    throw new Error(error || 'Supabase is not configured on the helper server.');
  }

  const sourceBytes = Buffer.byteLength(payload.code, 'utf8');
  const sourceSha256 = sha256(payload.code);
  const closure = analyzeProofState(payload.language, payload.code);
  const createdAt = nowIso();

  const plan = {
    id: randomUUID(),
    helperJobId,
    operation,
    status: PLAN_STATUS.QUEUED,
    title: payload.title || '',
    language: payload.language,
    fileName: payload.fileName,
    requestedFormat: payload.format || 'typed-lambda-v1',
    verify: payload.verify !== false,
    sourceCode: payload.code,
    sourceSha256,
    proofState: normalizeProofState(closure.proofState) || null,
    verificationStatus: null,
    problemId: null,
    plan: {
      schema: 'ivucx-conversion-plan-v1',
      stateStore: 'supabase',
      planner: 'railway',
      executor: 'render',
      operation,
      requestedFormat: payload.format || 'typed-lambda-v1',
      fallbackFormat: String(payload.format || '').trim().toLowerCase() === 'cic-v1' ? 'typed-lambda-v1' : null,
      sourceBytes,
      sourceSha256,
      language: payload.language.toLowerCase(),
      verify: payload.verify !== false,
      routes: {
        convert: EXECUTION_SERVER_CONVERT_ROUTE,
        leanCheck: EXECUTION_SERVER_LEAN_CHECK_ROUTE,
        coqCheck: EXECUTION_SERVER_COQ_CHECK_ROUTE
      }
    },
    progress: createProgress(12, 'planning', 'Planning'),
    executionPayload: {
      language: payload.language,
      fileName: payload.fileName,
      format: payload.format || 'typed-lambda-v1',
      verify: payload.verify !== false,
      sourceSha256,
      sourceBytes
    },
    executionResult: null,
    executionError: null,
    requestMeta: {
      sourceBytes,
      createdBy: 'railway-helper',
      helperJobId: helperJobId || null
    },
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null
  };

  await persistPlan(plan);
  return plan;
}

async function executeJob(jobId) {
  const job = await getJob(jobId);
  if (!job || job.status !== JOB_STATUS.QUEUED) return;

  job.status = JOB_STATUS.RUNNING;
  job.startedAt = nowIso();
  job.progress = createProgress(18, 'loading', 'Loading plan');
  await persistJob(job);

  try {
    const plan = await getPlan(job.planId);
    if (!plan) {
      throw new Error('Conversion plan not found in Supabase. Run supabase/proof_helper.sql again.');
    }

    const result = await executePlannedOperation(plan, job);
    job.completedAt = nowIso();

    if (result.ok) {
      job.status = JOB_STATUS.SUCCEEDED;
      job.result = result;
      job.problemId = result.problemId || null;
      job.progress = createProgress(100, 'saved', result.problemId ? 'Problem saved' : 'Converted');
    } else {
      job.status = JOB_STATUS.FAILED;
      job.error = buildJobError(result);
      job.progress = createProgress(100, 'failed', job.error.message || 'Conversion failed');
    }

    await persistJob(job);
  } catch (err) {
    job.status = JOB_STATUS.FAILED;
    job.completedAt = nowIso();
    job.error = { message: err && err.message ? err.message : String(err) };
    job.progress = createProgress(100, 'failed', job.error.message);
    await persistJob(job);
    if (job.planId) {
      await markPlanFailed(job.planId, job.error.message, job.progress);
    }
  }
}
async function executePlannedOperation(plan, job) {
  await updatePlanProgress(plan.id, PLAN_STATUS.PLANNING, createProgress(22, 'loading', 'Loading source'));
  if (job) {
    job.progress = createProgress(22, 'loading', 'Loading source');
    await persistJob(job);
  }

  const currentPlan = await getPlan(plan.id);
  if (!currentPlan) {
    throw new Error('Stored conversion plan was not found.');
  }

  await updatePlanProgress(currentPlan.id, PLAN_STATUS.READY, createProgress(34, 'prepared', 'Prepared'));
  if (job) {
    job.progress = createProgress(34, 'prepared', 'Prepared');
    await persistJob(job);
  }

  let execution = await executeRemoteConversion(currentPlan, currentPlan.requestedFormat);
  let finalResult = execution.result;
  let completedFormat = execution.completedFormat;
  let fallbackUsed = false;

  if (!finalResult.ok && shouldRetryWithTypedLambda(currentPlan.requestedFormat, extractResultMessage(finalResult))) {
    fallbackUsed = true;
    await updatePlanProgress(currentPlan.id, PLAN_STATUS.RUNNING, createProgress(56, 'fallback', 'Retrying typed lambda'));
    if (job) {
      job.progress = createProgress(56, 'fallback', 'Retrying typed lambda');
      await persistJob(job);
    }
    execution = await executeRemoteConversion(currentPlan, 'typed-lambda-v1');
    finalResult = execution.result;
    completedFormat = execution.completedFormat;
  }

  const proofState = resolveStoredProofState(currentPlan.language, currentPlan.sourceCode, finalResult);
  finalResult.proofState = proofState;
  finalResult.planning = {
    planId: currentPlan.id,
    operation: currentPlan.operation,
    stateStore: 'supabase',
    planner: 'railway',
    executor: 'render',
    requestedFormat: currentPlan.requestedFormat,
    completedFormat,
    fallbackUsed
  };

  if (!finalResult.ok) {
    await persistExecutionOutcome(currentPlan.id, {
      status: PLAN_STATUS.FAILED,
      progress: createProgress(100, 'failed', extractResultMessage(finalResult)),
      result: finalResult,
      error: buildExecutionErrorObject(finalResult),
      proofState,
      verificationStatus: resolveVerificationStatus(finalResult),
      problemId: null,
      completedAt: nowIso()
    });
    return finalResult;
  }

  let problemId = null;
  if (currentPlan.operation === 'submit') {
    await updatePlanProgress(currentPlan.id, PLAN_STATUS.RUNNING, createProgress(82, 'saving', 'Saving problem'));
    if (job) {
      job.progress = createProgress(82, 'saving', 'Saving problem');
      await persistJob(job);
    }
    const saved = await saveProblemRecord(currentPlan, finalResult, proofState, completedFormat);
    problemId = saved.id || null;
    finalResult.problemId = problemId;
  }

  await persistExecutionOutcome(currentPlan.id, {
    status: PLAN_STATUS.SUCCEEDED,
    progress: createProgress(100, 'saved', problemId ? 'Problem saved' : 'Converted'),
    result: finalResult,
    error: null,
    proofState,
    verificationStatus: resolveVerificationStatus(finalResult),
    problemId,
    completedAt: nowIso()
  });

  return finalResult;
}

async function executeRemoteConversion(plan, format) {
  if (!EXECUTION_SERVER_BASE_URL) {
    const error = new Error('EXECUTION_SERVER_BASE_URL is not configured on the helper server.');
    error.statusCode = 503;
    throw error;
  }

  await updatePlanProgress(plan.id, PLAN_STATUS.RUNNING, createProgress(46, 'running', 'Running on Render'));

  const executionPayload = {
    planId: plan.id,
    format,
    verify: plan.verify
  };

  const upstream = await sendExecutionRequest(EXECUTION_SERVER_CONVERT_ROUTE, executionPayload);
  const payload = upstream.payload && typeof upstream.payload === 'object' ? upstream.payload : null;

  if (payload && payload.result && typeof payload.result === 'object') {
    const result = {
      ...payload.result,
      requestedFormat: plan.requestedFormat,
      completedFormat: format
    };
    return { result, completedFormat: format };
  }

  const message = extractExecutionError(payload, upstream.text, upstream.status);
  return {
    completedFormat: format,
    result: {
      ok: false,
      stage: 'conversion',
      timedOut: upstream.status === 504,
      httpStatus: upstream.status >= 400 ? upstream.status : 502,
      language: plan.language.toLowerCase(),
      verifyBeforeConvert: plan.verify,
      proofCheck: null,
      conversion: {
        ok: false,
        language: plan.language.toLowerCase(),
        targetFamily: String(format || '').trim().toLowerCase() === 'cic-v1' ? 'cic' : 'typed-lambda',
        requestedFormat: plan.requestedFormat,
        exitCode: null,
        signal: null,
        timedOut: upstream.status === 504,
        durationMs: null,
        codeBytes: Buffer.byteLength(plan.sourceCode || '', 'utf8'),
        codeHash: plan.sourceSha256,
        stdout: '',
        stderr: message,
        lambda: {
          format,
          error: message
        }
      }
    }
  };
}

function shouldRetryWithTypedLambda(requestedFormat, message) {
  if (String(requestedFormat || '').trim().toLowerCase() !== 'cic-v1') {
    return false;
  }
  const normalized = String(message || '').trim().toLowerCase();
  return (
    normalized.includes('lean cic exporter failed')
    || normalized.includes('coq cic')
    || normalized.includes('bad gateway')
    || normalized.includes('service unavailable')
    || normalized.includes('gateway timeout')
    || normalized.includes('invalid response')
    || normalized.includes('unknown module prefix')
  );
}

async function requestExecutionCheck(payload) {
  const route = payload.language === 'Coq' ? EXECUTION_SERVER_COQ_CHECK_ROUTE : EXECUTION_SERVER_LEAN_CHECK_ROUTE;
  if (!EXECUTION_SERVER_BASE_URL) {
    const error = new Error('EXECUTION_SERVER_BASE_URL is not configured on the helper server.');
    error.statusCode = 503;
    throw error;
  }
  const upstream = await sendExecutionRequest(route, {
    code: payload.code,
    fileName: payload.fileName
  });
  const body = upstream.payload && typeof upstream.payload === 'object' ? upstream.payload : {};
  return {
    ok: Boolean(body.ok),
    language: payload.language.toLowerCase(),
    fileName: payload.fileName,
    command: body.command || route,
    args: Array.isArray(body.args) ? body.args : [],
    exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
    signal: body.signal || null,
    timedOut: body.status === 'timeout' || upstream.status === 504,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
    codeBytes: Buffer.byteLength(payload.code, 'utf8'),
    stdout: typeof body.stdout === 'string' ? truncateOutput(body.stdout) : '',
    stderr: typeof body.stderr === 'string' ? truncateOutput(body.stderr) : '',
    error: typeof body.error === 'string' ? body.error : '',
    upstreamStatus: upstream.status,
    source: 'render-execution',
    proofState: normalizeProofState(analyzeProofState(payload.language, payload.code).proofState) || 'NN'
  };
}

function statusCodeForVerification(verification) {
  if (verification.ok) return 200;
  if (verification.timedOut) return 504;
  return verification.upstreamStatus >= 400 ? verification.upstreamStatus : 422;
}

async function sendExecutionRequest(targetPath, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTION_SERVER_TIMEOUT_MS);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  if (EXECUTION_SERVER_API_KEY) {
    headers.Authorization = `Bearer ${EXECUTION_SERVER_API_KEY}`;
  }

  try {
    const response = await fetch(EXECUTION_SERVER_BASE_URL + targetPath, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });
    const text = await response.text();
    clearTimeout(timer);
    return {
      ok: response.ok,
      status: response.status,
      text,
      payload: tryParseJson(text)
    };
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    const error = new Error(
      timedOut
        ? 'Execution server timed out while running the requested proof task.'
        : (err && err.message ? err.message : String(err))
    );
    error.statusCode = timedOut ? 504 : 502;
    throw error;
  }
}

function extractExecutionError(payload, rawText, status) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    if (payload.details && typeof payload.details === 'object') {
      if (typeof payload.details.error === 'string' && payload.details.error.trim()) {
        return payload.details.error.trim();
      }
      if (typeof payload.details.stderr === 'string' && payload.details.stderr.trim()) {
        return payload.details.stderr.trim();
      }
    }
  }
  if (typeof rawText === 'string' && rawText.trim()) {
    return truncateOutput(rawText.trim());
  }
  return `Execution server returned ${status || 502}.`;
}
async function saveProblemRecord(plan, result, proofState, completedFormat) {
  const { client, error } = getSupabaseAdmin();
  if (!client) {
    throw new Error(error || 'Supabase is not configured on the helper server.');
  }

  const conversion = result && result.conversion && typeof result.conversion === 'object'
    ? result.conversion
    : {};
  const lambda = conversion.lambda && typeof conversion.lambda === 'object'
    ? conversion.lambda
    : {};

  const record = {
    title: plan.title || '',
    language: plan.language.toLowerCase(),
    file_name: plan.fileName || '',
    source_code: plan.sourceCode,
    source_sha256: plan.sourceSha256,
    proof_state: proofState,
    verification_status: resolveVerificationStatus(result),
    verification_result: {
      proofCheck: result && result.proofCheck ? result.proofCheck : null,
      planning: result && result.planning ? result.planning : null
    },
    normalized_format: lambda.format || completedFormat || plan.requestedFormat,
    normalized_term: lambda.term && typeof lambda.term === 'object' ? lambda.term : (lambda && Object.keys(lambda).length ? lambda : { raw: String(lambda.error || '') }),
    adapter_name: 'render-proof-convert',
    adapter_meta: {
      planner: 'railway',
      executor: 'render',
      planId: plan.id,
      operation: plan.operation,
      targetFamily: conversion.targetFamily || null,
      requestedFormat: plan.requestedFormat,
      completedFormat: lambda.format || completedFormat || plan.requestedFormat,
      fallbackUsed: !!(result && result.planning && result.planning.fallbackUsed),
      context: lambda.context || null,
      declarations: lambda.declarations || null,
      metadata: lambda.metadata || null,
      rawText: typeof lambda.rawText === 'string' ? truncateOutput(lambda.rawText, 24000) : ''
    },
    helper_job_id: plan.helperJobId || null,
    request_meta: {
      sourceLanguage: plan.language,
      fileName: plan.fileName,
      sourceBytes: Buffer.byteLength(plan.sourceCode, 'utf8'),
      planId: plan.id,
      planOperation: plan.operation
    }
  };

  const { data, error: insertError } = await client
    .from('problems')
    .insert(record)
    .select('id, created_at')
    .single();

  if (insertError) {
    throw new Error(insertError.message || 'Failed to save problem row.');
  }

  return data || { id: null, created_at: nowIso() };
}

function resolveVerificationStatus(result) {
  if (!result) return 'failed';
  if (result.verifyBeforeConvert === false) return 'skipped';
  return result.ok ? 'verified' : 'failed';
}

function resolveStoredProofState(language, code, result) {
  const closure = analyzeProofState(language, code);
  const coarse = normalizeProofState(closure.proofState) || 'NN';
  if (result && result.ok) {
    return coarse;
  }
  if (coarse === 'NY') {
    return 'NY';
  }
  return 'NN';
}

function buildJobError(result) {
  return {
    message: extractResultMessage(result),
    stage: result && result.stage ? result.stage : 'conversion',
    httpStatus: result && typeof result.httpStatus === 'number' ? result.httpStatus : 422,
    timedOut: !!(result && result.timedOut)
  };
}

function buildExecutionErrorObject(result) {
  return {
    message: extractResultMessage(result),
    stage: result && result.stage ? result.stage : 'conversion',
    httpStatus: result && typeof result.httpStatus === 'number' ? result.httpStatus : 422,
    timedOut: !!(result && result.timedOut)
  };
}

function extractResultMessage(result) {
  if (!result || typeof result !== 'object') {
    return 'Helper conversion failed.';
  }
  if (result.proofCheck && typeof result.proofCheck.error === 'string' && result.proofCheck.error.trim()) {
    return result.proofCheck.error.trim();
  }
  if (result.conversion && typeof result.conversion === 'object') {
    const lambda = result.conversion.lambda;
    if (lambda && typeof lambda === 'object' && typeof lambda.error === 'string' && lambda.error.trim()) {
      return lambda.error.trim();
    }
    if (typeof result.conversion.stderr === 'string' && result.conversion.stderr.trim()) {
      return result.conversion.stderr.trim();
    }
    if (typeof result.conversion.stdout === 'string' && result.conversion.stdout.trim()) {
      return result.conversion.stdout.trim();
    }
  }
  if (typeof result.error === 'string' && result.error.trim()) {
    return result.error.trim();
  }
  return 'Helper conversion failed.';
}

function statusCodeForResult(result) {
  if (result && typeof result.httpStatus === 'number' && result.httpStatus >= 400) {
    return result.httpStatus;
  }
  if (result && result.ok) {
    return 200;
  }
  if (result && result.timedOut) {
    return 504;
  }
  return 422;
}

async function persistExecutionOutcome(planId, outcome) {
  const plan = await getPlan(planId);
  if (!plan) return;
  plan.status = outcome.status;
  plan.progress = outcome.progress || plan.progress;
  plan.executionResult = outcome.result || null;
  plan.executionError = outcome.error || null;
  plan.proofState = outcome.proofState || null;
  plan.verificationStatus = outcome.verificationStatus || null;
  plan.problemId = outcome.problemId || null;
  plan.completedAt = outcome.completedAt || nowIso();
  if (!plan.startedAt) {
    plan.startedAt = nowIso();
  }
  await persistPlan(plan);
}

async function markPlanFailed(planId, message, progress) {
  const plan = await getPlan(planId);
  if (!plan) return;
  plan.status = PLAN_STATUS.FAILED;
  plan.progress = progress || createProgress(100, 'failed', message || 'Failed');
  plan.executionError = { message: message || 'Failed' };
  plan.completedAt = nowIso();
  await persistPlan(plan);
}

async function updatePlanProgress(planId, status, progress) {
  const plan = await getPlan(planId);
  if (!plan) return;
  plan.status = status;
  plan.progress = progress || plan.progress;
  if (!plan.startedAt && (status === PLAN_STATUS.RUNNING || status === PLAN_STATUS.READY)) {
    plan.startedAt = nowIso();
  }
  await persistPlan(plan);
}

async function getJob(id) {
  const memory = jobs.get(id);
  if (memory) return memory;
  return loadPersistedJob(id);
}

async function listJobs() {
  const { client } = getSupabaseAdmin();
  if (!client) {
    return Array.from(jobs.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  const { data, error } = await client
    .from('helper_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    return Array.from(jobs.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  return Array.isArray(data) ? data.map(hydrateJobRow) : [];
}

async function loadPersistedJob(id) {
  const { client } = getSupabaseAdmin();
  if (!client) return null;
  const { data, error } = await client
    .from('helper_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  const job = hydrateJobRow(data);
  jobs.set(job.id, job);
  return job;
}
function hydrateJobRow(row) {
  return {
    id: row.id,
    status: row.status || JOB_STATUS.FAILED,
    operation: row.operation || 'convert',
    title: row.title || '',
    language: resolveLanguage(row.language || 'Lean'),
    fileName: row.file_name || defaultFileName(resolveLanguage(row.language || 'Lean')),
    format: row.normalized_format || 'typed-lambda-v1',
    sourceSha256: row.source_sha256 || '',
    createdAt: row.created_at || nowIso(),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    progress: row.progress || null,
    result: row.result || null,
    error: row.error || null,
    problemId: row.problem_id || null,
    planId: row.plan_id || null
  };
}

async function persistJob(job) {
  const { client } = getSupabaseAdmin();
  if (!client) return;
  await client.from('helper_jobs').upsert({
    id: job.id,
    status: job.status,
    operation: job.operation || 'convert',
    title: job.title || '',
    language: String(job.language || '').toLowerCase(),
    file_name: job.fileName || '',
    normalized_format: job.format || 'typed-lambda-v1',
    proof_state: job.result && job.result.proofState ? job.result.proofState : null,
    verification_status: job.result ? resolveVerificationStatus(job.result) : null,
    source_sha256: job.sourceSha256 || null,
    progress: job.progress || {},
    result: job.status === JOB_STATUS.SUCCEEDED ? (job.result || null) : null,
    error: job.status === JOB_STATUS.FAILED ? (job.error || null) : null,
    problem_id: job.problemId || null,
    plan_id: job.planId || null,
    created_at: job.createdAt,
    updated_at: nowIso(),
    started_at: job.startedAt,
    completed_at: job.completedAt
  });
}

async function getPlan(id) {
  if (!id) return null;
  return loadPersistedPlan(id);
}

async function loadPersistedPlan(id) {
  const { client } = getSupabaseAdmin();
  if (!client) return null;
  const { data, error } = await client
    .from('helper_conversion_plans')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return hydratePlanRow(data);
}

function hydratePlanRow(row) {
  return {
    id: row.id,
    helperJobId: row.helper_job_id || null,
    operation: row.operation || 'convert',
    status: row.status || PLAN_STATUS.FAILED,
    title: row.title || '',
    language: resolveLanguage(row.language || 'Lean'),
    fileName: row.file_name || defaultFileName(resolveLanguage(row.language || 'Lean')),
    requestedFormat: row.requested_format || 'typed-lambda-v1',
    verify: row.verify !== false,
    sourceCode: row.source_code || '',
    sourceSha256: row.source_sha256 || '',
    plan: row.plan || {},
    progress: row.progress || null,
    executionPayload: row.execution_payload || {},
    executionResult: row.execution_result || null,
    executionError: row.execution_error || null,
    proofState: row.proof_state || null,
    verificationStatus: row.verification_status || null,
    problemId: row.problem_id || null,
    requestMeta: row.request_meta || {},
    createdAt: row.created_at || nowIso(),
    updatedAt: row.updated_at || nowIso(),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null
  };
}

async function persistPlan(plan) {
  const { client } = getSupabaseAdmin();
  if (!client) return;
  await client.from('helper_conversion_plans').upsert({
    id: plan.id,
    helper_job_id: plan.helperJobId || null,
    operation: plan.operation || 'convert',
    status: plan.status || PLAN_STATUS.QUEUED,
    title: plan.title || '',
    language: String(plan.language || '').toLowerCase(),
    file_name: plan.fileName || '',
    requested_format: plan.requestedFormat || 'typed-lambda-v1',
    verify: plan.verify !== false,
    source_code: plan.sourceCode || '',
    source_sha256: plan.sourceSha256 || sha256(plan.sourceCode || ''),
    plan: plan.plan || {},
    progress: plan.progress || {},
    execution_payload: plan.executionPayload || {},
    execution_result: plan.executionResult || null,
    execution_error: plan.executionError || null,
    proof_state: plan.proofState || null,
    verification_status: plan.verificationStatus || null,
    problem_id: plan.problemId || null,
    request_meta: plan.requestMeta || {},
    created_at: plan.createdAt || nowIso(),
    updated_at: nowIso(),
    started_at: plan.startedAt,
    completed_at: plan.completedAt
  });
}

function stripLeanCommentsAndStrings(input) {
  let output = '';
  let i = 0;
  let blockCommentDepth = 0;
  let inString = false;
  let inLineComment = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { inString = false; }
      i += 1;
      continue;
    }

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        output += ch;
      }
      i += 1;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (ch === '/' && next === '-') { blockCommentDepth += 1; i += 2; continue; }
      if (ch === '-' && next === '/') { blockCommentDepth -= 1; i += 2; continue; }
      i += 1;
      continue;
    }

    if (ch === '"') { inString = true; i += 1; continue; }
    if (ch === '-' && next === '-') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '-') { blockCommentDepth = 1; i += 2; continue; }

    output += ch;
    i += 1;
  }

  return output;
}

function analyzeLeanClosure(code) {
  if (!code || typeof code !== 'string') {
    return { proofState: 'NN', reason: 'Code is empty' };
  }
  const normalized = stripLeanCommentsAndStrings(code).trim();
  if (!normalized) {
    return { proofState: 'NN', reason: 'Code is empty' };
  }
  if (/\b(sorry|admit)\b/.test(normalized)) {
    return { proofState: 'NY', closer: 'sorry/admit' };
  }
  if (/(^|\n)\s*(axiom|constant)\b/.test(normalized)) {
    return { proofState: 'NY', closer: 'axiom/constant' };
  }
  return { proofState: 'YY', closer: 'Lean checked' };
}

function stripCoqCommentsAndStrings(input) {
  let output = '';
  let i = 0;
  let commentDepth = 0;
  let inString = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { inString = false; }
      i += 1;
      continue;
    }

    if (commentDepth > 0) {
      if (ch === '(' && next === '*') { commentDepth += 1; i += 2; continue; }
      if (ch === '*' && next === ')') { commentDepth -= 1; i += 2; continue; }
      i += 1;
      continue;
    }

    if (ch === '"') { inString = true; i += 1; continue; }
    if (ch === '(' && next === '*') { commentDepth = 1; i += 2; continue; }

    output += ch;
    i += 1;
  }

  return output;
}
function isConjectureTail(normalized) {
  const matches = Array.from(normalized.matchAll(/\bConjecture\b/g));
  if (matches.length === 0) return false;
  const last = matches[matches.length - 1];
  const idx = typeof last.index === 'number' ? last.index : -1;
  if (idx < 0) return false;
  const tail = normalized.slice(idx).trim();
  if (!tail.endsWith('.')) return false;
  const dotCount = (tail.match(/\./g) || []).length;
  return dotCount === 1;
}

function analyzeCoqClosure(code) {
  if (!code || typeof code !== 'string') {
    return { proofState: 'NN', reason: 'The proof must end with Qed. / Defined. / Admitted. / Conjecture.' };
  }
  const normalized = stripCoqCommentsAndStrings(code).trim();
  if (!normalized) {
    return { proofState: 'NN', reason: 'The proof must end with Qed. / Defined. / Admitted. / Conjecture.' };
  }
  if (/\bAdmitted\./.test(normalized)) return { proofState: 'NY', closer: 'Admitted.' };
  if (/\b(Axiom|Axioms|Parameter|Parameters|Hypothesis|Hypotheses|Variable|Variables|Conjecture)\b/.test(normalized)) {
    return { proofState: 'NY', closer: 'Axiom/Parameter/Conjecture' };
  }
  if (isConjectureTail(normalized)) return { proofState: 'NY', closer: 'Conjecture.' };
  if (/Defined\.\s*$/.test(normalized)) return { proofState: 'YY', closer: 'Defined.' };
  if (/Qed\.\s*$/.test(normalized)) return { proofState: 'YY', closer: 'Qed.' };
  return { proofState: 'NN', reason: 'The proof must end with Qed. / Defined. / Admitted. / Conjecture.' };
}

function analyzeProofState(language, code) {
  return language === 'Coq' ? analyzeCoqClosure(code) : analyzeLeanClosure(code);
}

async function recoverStaleJobs() {
  const { client } = getSupabaseAdmin();
  if (!client) return;
  const now = nowIso();
  const restartMessage = { message: 'Helper server restarted before the job finished.' };
  try {
    await client
      .from('helper_jobs')
      .update({
        status: JOB_STATUS.FAILED,
        error: restartMessage,
        progress: createProgress(100, 'failed', restartMessage.message),
        updated_at: now,
        completed_at: now
      })
      .in('status', [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]);

    await client
      .from('helper_conversion_plans')
      .update({
        status: PLAN_STATUS.FAILED,
        execution_error: restartMessage,
        progress: createProgress(100, 'failed', restartMessage.message),
        updated_at: now,
        completed_at: now
      })
      .in('status', [PLAN_STATUS.QUEUED, PLAN_STATUS.PLANNING, PLAN_STATUS.READY, PLAN_STATUS.RUNNING]);
  } catch (err) {
    console.warn('Failed to recover stale helper jobs', err);
  }
}

async function startServer() {
  await recoverStaleJobs();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`${SERVICE_NAME} ${SERVICE_VERSION} listening on ${PORT}`);
  });
}

