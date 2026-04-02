const { runProofCheck, getRuntimeInfo } = require('./proof-runtime');
const { runLambdaConversion, getConverterInfo } = require('./lambda-runtime');

function toBoolean(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }

  if (typeof value === 'boolean') {
    return value;
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

async function performProofCheck(payload) {
  return runProofCheck(payload || {});
}

async function performLambdaConversion(payload) {
  const normalizedPayload = payload || {};
  const verifyBeforeConvert = toBoolean(normalizedPayload.verify, true);

  let proofCheck = null;
  if (verifyBeforeConvert) {
    proofCheck = await performProofCheck(normalizedPayload);
    if (!proofCheck.ok) {
      return {
        ok: false,
        stage: 'proof-check',
        timedOut: proofCheck.timedOut,
        language: proofCheck.language,
        verifyBeforeConvert,
        proofCheck,
        conversion: null
      };
    }
  }

  const conversion = await runLambdaConversion(normalizedPayload);
  if (!conversion.ok) {
    return {
      ok: false,
      stage: 'conversion',
      timedOut: conversion.timedOut,
      language: conversion.language,
      verifyBeforeConvert,
      proofCheck,
      conversion
    };
  }

  return {
    ok: true,
    stage: 'completed',
    timedOut: false,
    language: conversion.language,
    verifyBeforeConvert,
    proofCheck,
    conversion
  };
}

function getHelperInfo() {
  return {
    proofRuntimes: getRuntimeInfo(),
    conversionRuntimes: getConverterInfo()
  };
}

function extractResultMessage(result, fallbackMessage) {
  if (!result || typeof result !== 'object') {
    return fallbackMessage;
  }

  if (result.stage === 'proof-check' && result.proofCheck) {
    const proofCheck = result.proofCheck;
    if (typeof proofCheck.error === 'string' && proofCheck.error.trim()) {
      return proofCheck.error.trim();
    }
    if (typeof proofCheck.stderr === 'string' && proofCheck.stderr.trim()) {
      return proofCheck.stderr.trim();
    }
    if (typeof proofCheck.stdout === 'string' && proofCheck.stdout.trim()) {
      return proofCheck.stdout.trim();
    }
  }

  if (result.stage === 'conversion' && result.conversion) {
    const conversion = result.conversion;
    if (conversion.lambda && conversion.lambda.term && typeof conversion.lambda.term.error === 'string') {
      return conversion.lambda.term.error;
    }
    if (typeof conversion.stderr === 'string' && conversion.stderr.trim()) {
      return conversion.stderr.trim();
    }
    if (typeof conversion.stdout === 'string' && conversion.stdout.trim()) {
      return conversion.stdout.trim();
    }
  }

  return fallbackMessage;
}

function createResultError(message, result) {
  const error = new Error(extractResultMessage(result, message));
  error.statusCode = result && result.timedOut ? 504 : 422;
  error.details = { result };
  return error;
}

async function executeProofCheckJob(payload) {
  const result = await performProofCheck(payload);
  if (!result.ok) {
    throw createResultError('Proof check failed', result);
  }
  return result;
}

async function executeLambdaConversionJob(payload) {
  const result = await performLambdaConversion(payload);
  if (!result.ok) {
    throw createResultError('Lambda conversion failed', result);
  }
  return result;
}

module.exports = {
  performProofCheck,
  performLambdaConversion,
  executeProofCheckJob,
  executeLambdaConversionJob,
  getHelperInfo
};
