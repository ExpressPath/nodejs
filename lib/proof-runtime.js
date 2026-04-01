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

function getRuntimeInfo() {
  return {
    lean: {
      available: Boolean(config.proofRuntimes.lean.command),
      command: config.proofRuntimes.lean.command,
      args: config.proofRuntimes.lean.args,
      extension: config.proofRuntimes.lean.extension
    },
    coq: {
      available: Boolean(config.proofRuntimes.coq.command),
      command: config.proofRuntimes.coq.command,
      args: config.proofRuntimes.coq.args,
      extension: config.proofRuntimes.coq.extension
    }
  };
}

async function runProofCheck(payload) {
  const normalizedLanguage = normalizeLanguage(payload && payload.language);
  const runtime = config.proofRuntimes[normalizedLanguage];
  const execution = await runCommandForCode({
    command: runtime.command,
    args: runtime.args,
    code: payload && payload.code,
    fileName: payload && payload.fileName,
    defaultFileName: runtime.defaultFileName,
    extension: runtime.extension,
    timeoutMs: config.processTimeoutMs,
    tempPrefix: `proof-${normalizedLanguage}-`
  });

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
    stdout: truncateOutput(execution.stdout),
    stderr: truncateOutput(execution.stderr)
  };
}

module.exports = {
  getRuntimeInfo,
  runProofCheck
};