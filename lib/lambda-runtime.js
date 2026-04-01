const { createHash } = require('node:crypto');
const config = require('./config');
const { runCommandForCode, truncateOutput } = require('./runner');

function normalizeLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized === 'lean' || normalized === 'coq') {
    return normalized;
  }

  const error = new Error('language must be Lean or Coq');
  error.statusCode = 400;
  throw error;
}

function getConverterInfo() {
  return {
    lean: {
      available: Boolean(config.converters.lean.command),
      command: config.converters.lean.command,
      args: config.converters.lean.args,
      stdoutFormat: config.converters.lean.stdoutFormat,
      resultFormat: config.converters.lean.resultFormat,
      extension: config.converters.lean.extension
    },
    coq: {
      available: Boolean(config.converters.coq.command),
      command: config.converters.coq.command,
      args: config.converters.coq.args,
      stdoutFormat: config.converters.coq.stdoutFormat,
      resultFormat: config.converters.coq.resultFormat,
      extension: config.converters.coq.extension
    }
  };
}

function normalizeLambdaPayload(structured, fallbackText, fallbackFormat) {
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const term = structured.term || structured.lambda || structured.expression || structured.normalized || structured.ast || structured;

    return {
      format: structured.format || fallbackFormat || 'typed-lambda-v1',
      term,
      context: structured.context || structured.ctx || null,
      declarations: structured.declarations || null,
      metadata: structured.metadata || null,
      rawText: typeof fallbackText === 'string' ? fallbackText : ''
    };
  }

  return {
    format: fallbackFormat || 'typed-lambda-v1',
    term: typeof fallbackText === 'string' ? fallbackText.trim() : '',
    context: null,
    declarations: null,
    metadata: null,
    rawText: typeof fallbackText === 'string' ? fallbackText : ''
  };
}

async function runLambdaConversion(payload) {
  const normalizedLanguage = normalizeLanguage(payload && payload.language);
  const converter = config.converters[normalizedLanguage];
  const normalizedCode = payload && typeof payload.code === 'string' ? payload.code : '';

  if (!converter.command) {
    const error = new Error(`${normalizedLanguage} lambda converter is not configured`);
    error.statusCode = 503;
    throw error;
  }

  const execution = await runCommandForCode({
    command: converter.command,
    args: converter.args,
    code: normalizedCode,
    fileName: payload && payload.fileName,
    defaultFileName: converter.defaultFileName,
    extension: converter.extension,
    timeoutMs: config.processTimeoutMs,
    tempPrefix: `lambda-${normalizedLanguage}-`
  });

  const rawOutput = execution.outputText || execution.stdout;
  let structured = null;

  if (converter.stdoutFormat === 'json' && rawOutput) {
    try {
      structured = JSON.parse(rawOutput);
    } catch (error) {
      if (execution.ok) {
        const parseError = new Error(`${normalizedLanguage} lambda converter returned invalid JSON`);
        parseError.statusCode = 502;
        parseError.details = {
          stdout: truncateOutput(execution.stdout),
          stderr: truncateOutput(execution.stderr)
        };
        throw parseError;
      }
    }
  }

  return {
    ok: execution.ok,
    language: normalizedLanguage,
    fileName: execution.fileName,
    command: execution.command,
    args: execution.args,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    durationMs: execution.durationMs,
    codeBytes: execution.codeBytes,
    codeHash: createHash('sha256').update(normalizedCode, 'utf8').digest('hex'),
    stdout: truncateOutput(execution.stdout),
    stderr: truncateOutput(execution.stderr),
    lambda: normalizeLambdaPayload(structured, rawOutput, payload && payload.format ? payload.format : converter.resultFormat)
  };
}

module.exports = {
  getConverterInfo,
  runLambdaConversion
};