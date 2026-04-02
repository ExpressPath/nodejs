const path = require('node:path');

function parsePositiveInt(value, fallbackValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function parseBoolean(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }

  switch (String(value).trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fallbackValue;
  }
}

function splitArgs(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return [];
  }

  const args = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < rawValue.length; i += 1) {
    const char = rawValue[i];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && i + 1 < rawValue.length) {
        i += 1;
        current += rawValue[i];
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const jobsDir = process.env.JOBS_DIR || path.join(dataDir, 'jobs');
const toolsDir = path.join(rootDir, 'tools');
const bundledLeanConverter = path.join(toolsDir, 'convert-lean.cjs');
const bundledCoqConverter = path.join(toolsDir, 'convert-coq.cjs');
const bundledLeanCicConverter = path.join(toolsDir, 'convert-lean-cic.cjs');
const bundledCoqCicConverter = path.join(toolsDir, 'convert-coq-cic.cjs');

function readCommand(envValue, fallbackValue) {
  const trimmed = typeof envValue === 'string' ? envValue.trim() : '';
  return trimmed || fallbackValue;
}

function readArgs(envValue, fallbackValue) {
  const trimmed = typeof envValue === 'string' ? envValue.trim() : '';
  return trimmed ? splitArgs(trimmed) : fallbackValue.slice();
}

function normalizeNodeScriptArgs(command, args) {
  const normalizedCommand = path.basename(String(command || '')).toLowerCase();
  const nodeExecutable = path.basename(process.execPath || '').toLowerCase();

  if (normalizedCommand !== 'node' && normalizedCommand !== 'node.exe' && normalizedCommand !== nodeExecutable) {
    return Array.isArray(args) ? args.slice() : [];
  }

  let scriptResolved = false;
  return (Array.isArray(args) ? args : []).map((arg) => {
    const value = String(arg || '');

    if (scriptResolved) {
      return value;
    }

    if (!value || value.startsWith('-')) {
      return value;
    }

    scriptResolved = true;
    if (value.includes('{') || path.isAbsolute(value)) {
      return value;
    }

    return path.resolve(rootDir, value);
  });
}

function buildConverter(command, args, stdoutFormat, resultFormat, extension, defaultFileName) {
  return {
    command,
    args: normalizeNodeScriptArgs(command, args),
    stdoutFormat,
    resultFormat,
    extension,
    defaultFileName
  };
}

const config = {
  port: parsePositiveInt(process.env.PORT, 3000),
  serviceName: process.env.SERVICE_NAME || 'railway-helper-api',
  serviceVersion: process.env.SERVICE_VERSION || '1.4.1',
  nodeEnv: process.env.NODE_ENV || 'development',
  jsonLimit: process.env.JSON_LIMIT || '1mb',
  urlencodedLimit: process.env.URLENCODED_LIMIT || '1mb',
  corsAllowOrigin: process.env.CORS_ALLOW_ORIGIN || '*',
  helperApiKey: process.env.HELPER_API_KEY || '',
  allowAnonymousHelper: parseBoolean(process.env.ALLOW_ANONYMOUS_HELPER, !process.env.HELPER_API_KEY),
  httpRequestTimeoutMs: parsePositiveInt(process.env.HTTP_REQUEST_TIMEOUT_MS, 180000),
  processTimeoutMs: parsePositiveInt(process.env.PROCESS_TIMEOUT_MS, 180000),
  maxCodeBytes: parsePositiveInt(process.env.MAX_CODE_BYTES, 250000),
  maxOutputChars: parsePositiveInt(process.env.MAX_OUTPUT_CHARS, 12000),
  jobsDir,
  jobsRetentionMs: parsePositiveInt(process.env.JOBS_RETENTION_MS, 86400000),
  jobCleanupIntervalMs: parsePositiveInt(process.env.JOB_CLEANUP_INTERVAL_MS, 600000),
  jobConcurrency: parsePositiveInt(process.env.JOB_CONCURRENCY, 2),
  proofRuntimes: {
    lean: {
      command: process.env.LEAN_CMD || 'lean',
      args: splitArgs(process.env.LEAN_ARGS || ''),
      extension: '.lean',
      defaultFileName: 'Main.lean'
    },
    coq: {
      command: process.env.COQ_CMD || 'coqc',
      args: splitArgs(process.env.COQ_ARGS || ''),
      extension: '.v',
      defaultFileName: 'Main.v'
    }
  },
  converters: {
    lean: buildConverter(
      readCommand(process.env.LEAN_LAMBDA_CMD, process.execPath),
      readArgs(process.env.LEAN_LAMBDA_ARGS, [bundledLeanConverter, '--out', '{out}']),
      (process.env.LEAN_LAMBDA_STDOUT_FORMAT || 'json').toLowerCase(),
      process.env.LEAN_LAMBDA_RESULT_FORMAT || 'typed-lambda-v1',
      '.lean',
      'Main.lean'
    ),
    coq: buildConverter(
      readCommand(process.env.COQ_LAMBDA_CMD, process.execPath),
      readArgs(process.env.COQ_LAMBDA_ARGS, [bundledCoqConverter, '--out', '{out}']),
      (process.env.COQ_LAMBDA_STDOUT_FORMAT || 'json').toLowerCase(),
      process.env.COQ_LAMBDA_RESULT_FORMAT || 'typed-lambda-v1',
      '.v',
      'Main.v'
    )
  },
  cicConverters: {
    lean: buildConverter(
      readCommand(process.env.LEAN_CIC_CMD, process.execPath),
      readArgs(process.env.LEAN_CIC_ARGS, [bundledLeanCicConverter, '--out', '{out}']),
      (process.env.LEAN_CIC_STDOUT_FORMAT || 'json').toLowerCase(),
      process.env.LEAN_CIC_RESULT_FORMAT || 'cic-v1',
      '.lean',
      'Main.lean'
    ),
    coq: buildConverter(
      readCommand(process.env.COQ_CIC_CMD, ''),
      readArgs(process.env.COQ_CIC_ARGS, [bundledCoqCicConverter, '--out', '{out}']),
      (process.env.COQ_CIC_STDOUT_FORMAT || 'json').toLowerCase(),
      process.env.COQ_CIC_RESULT_FORMAT || 'cic-v1',
      '.v',
      'Main.v'
    )
  }
};

module.exports = config;
module.exports.parseBoolean = parseBoolean;
