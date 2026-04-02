const config = require('./config');

function buildDelegateHeaders(requestId) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (requestId) {
    headers['X-Request-Id'] = requestId;
  }

  if (config.executionDelegate.apiKey) {
    headers.Authorization = `Bearer ${config.executionDelegate.apiKey}`;
    headers['X-Helper-Key'] = config.executionDelegate.apiKey;
  }

  return headers;
}

function getExecutionDelegateInfo() {
  return {
    enabled: config.executionDelegate.enabled,
    baseUrl: config.executionDelegate.baseUrl || null,
    timeoutMs: config.executionDelegate.timeoutMs,
    mode: 'proof-and-conversion'
  };
}

function getExecutionDelegateBaseUrl() {
  return config.executionDelegate.baseUrl;
}

function hasExecutionDelegate() {
  return config.executionDelegate.enabled;
}

async function postToExecutionServer(endpoint, payload, options = {}) {
  if (!config.executionDelegate.enabled) {
    const error = new Error('Execution delegate is not configured');
    error.statusCode = 503;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.executionDelegate.timeoutMs);
  const url = `${config.executionDelegate.baseUrl}${endpoint}`;
  const body = {
    ...(payload || {}),
    async: false
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildDelegateHeaders(options.requestId),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (error) {
      const parseError = new Error(`Execution delegate returned non-JSON response for ${endpoint}`);
      parseError.statusCode = 502;
      parseError.details = {
        endpoint,
        url,
        statusCode: response.status,
        body: rawText.slice(0, 4000)
      };
      throw parseError;
    }

    if (data && data.result) {
      return {
        result: data.result,
        response: data,
        statusCode: response.status
      };
    }

    if (response.ok && data && data.success && data.result) {
      return {
        result: data.result,
        response: data,
        statusCode: response.status
      };
    }

    const error = new Error(
      (data && (data.error || data.message))
      || `Execution delegate request failed for ${endpoint}`
    );
    error.statusCode = response.status >= 400 ? response.status : 502;
    error.details = {
      endpoint,
      url,
      statusCode: response.status,
      response: data
    };
    throw error;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`Execution delegate timed out for ${endpoint}`);
      timeoutError.statusCode = 504;
      timeoutError.details = {
        endpoint,
        url
      };
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function delegateProofCheck(payload, options = {}) {
  const delegated = await postToExecutionServer('/api/helper/check', payload, options);
  return delegated.result;
}

async function delegateLambdaConversion(payload, options = {}) {
  const delegated = await postToExecutionServer('/api/proof-convert', payload, options);
  return delegated.result;
}

module.exports = {
  delegateLambdaConversion,
  delegateProofCheck,
  getExecutionDelegateBaseUrl,
  getExecutionDelegateInfo,
  hasExecutionDelegate
};
