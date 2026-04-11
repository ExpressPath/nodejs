import { createHash, createPrivateKey, sign as signWithKey } from 'crypto';
import { readFile } from 'fs/promises';
import { isAbsolute, resolve as resolvePath } from 'path';

export const EXECUTION_SIGNATURE_HEADERS = Object.freeze({
  algorithm: 'x-ivucx-execution-signature-algorithm',
  keyId: 'x-ivucx-execution-key-id',
  signature: 'x-ivucx-execution-signature',
  timestamp: 'x-ivucx-execution-timestamp'
});

const PRIVATE_KEY_ENV_NAMES = Object.freeze([
  'EXECUTION_API_PRIVATE_KEY',
  'EXECUTION_SERVER_PRIVATE_KEY',
  'ORACLE_SERVER_PRIVATE_KEY',
  'EXECUTION_PRIVATE_KEY'
]);
const PRIVATE_KEY_PATH_ENV_NAMES = Object.freeze([
  'EXECUTION_API_PRIVATE_KEY_PATH',
  'EXECUTION_SERVER_PRIVATE_KEY_PATH',
  'ORACLE_SERVER_PRIVATE_KEY_PATH',
  'EXECUTION_PRIVATE_KEY_PATH'
]);
const KEY_ID_ENV_NAMES = Object.freeze([
  'EXECUTION_API_KEY_ID',
  'EXECUTION_SERVER_KEY_ID',
  'ORACLE_SERVER_KEY_ID',
  'EXECUTION_KEY_ID'
]);
const SIGNATURE_ENABLED_ENV_NAMES = Object.freeze([
  'EXECUTION_SIGNATURE_ENABLED',
  'EXECUTION_API_SIGNATURE_ENABLED',
  'EXECUTION_SERVER_SIGNATURE_ENABLED',
  'ORACLE_SERVER_SIGNATURE_ENABLED'
]);

let cachedPrivateKeyPromise = null;

function firstConfiguredEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
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

function normalizePem(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
}

function resolveKeyPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return isAbsolute(normalized) ? normalized : resolvePath(process.cwd(), normalized);
}

async function loadPrivateKeyPem() {
  const inlinePem = normalizePem(firstConfiguredEnv(PRIVATE_KEY_ENV_NAMES));
  if (inlinePem) {
    return inlinePem;
  }

  const filePath = resolveKeyPath(firstConfiguredEnv(PRIVATE_KEY_PATH_ENV_NAMES));
  if (!filePath) {
    return '';
  }

  const fileText = await readFile(filePath, 'utf8');
  return normalizePem(fileText);
}

async function getPrivateKeyPem() {
  if (!cachedPrivateKeyPromise) {
    cachedPrivateKeyPromise = loadPrivateKeyPem().catch((error) => {
      cachedPrivateKeyPromise = null;
      throw error;
    });
  }
  return cachedPrivateKeyPromise;
}

function normalizeTargetPath(targetPath) {
  const raw = String(targetPath || '').trim();
  if (!raw) {
    return '/';
  }

  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    return `${parsed.pathname || '/'}${parsed.search || ''}`;
  }

  return raw.startsWith('/') ? raw : `/${raw}`;
}

function buildBodyDigest(bodyText) {
  return createHash('sha256').update(String(bodyText || ''), 'utf8').digest('hex');
}

function buildSigningMessage({ bodyText, method, targetPath, timestamp }) {
  return [
    String(timestamp || '').trim(),
    String(method || 'GET').trim().toUpperCase(),
    normalizeTargetPath(targetPath),
    buildBodyDigest(bodyText)
  ].join('\n');
}

function deriveKeyId(privateKeyPem) {
  const configuredKeyId = firstConfiguredEnv(KEY_ID_ENV_NAMES);
  if (configuredKeyId) {
    return configuredKeyId;
  }

  if (!privateKeyPem) {
    return '';
  }

  try {
    const keyObject = createPrivateKey(privateKeyPem);
    const publicKeyDer = keyObject.export({ format: 'der', type: 'spki' });
    return createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 24);
  } catch (_error) {
    return createHash('sha256').update(privateKeyPem, 'utf8').digest('hex').slice(0, 24);
  }
}

async function getExecutionSigningConfig() {
  const privateKeyPem = await getPrivateKeyPem();
  const explicitSetting = firstConfiguredEnv(SIGNATURE_ENABLED_ENV_NAMES);
  const enabled = parseBoolean(explicitSetting, !!privateKeyPem);

  if (!enabled) {
    return {
      enabled: false,
      keyId: ''
    };
  }

  if (!privateKeyPem) {
    const error = new Error(
      'Execution request signing is enabled but no private key is configured. Set EXECUTION_SERVER_PRIVATE_KEY or EXECUTION_SERVER_PRIVATE_KEY_PATH.'
    );
    error.statusCode = 500;
    throw error;
  }

  return {
    enabled: true,
    keyId: deriveKeyId(privateKeyPem),
    privateKeyPem
  };
}

export async function attachExecutionRequestAuthHeaders({ bodyText = '', headers = {}, method = 'GET', targetPath = '/' }) {
  const signing = await getExecutionSigningConfig();
  if (!signing.enabled) {
    return headers;
  }

  const timestamp = new Date().toISOString();
  const message = buildSigningMessage({
    bodyText,
    method,
    targetPath,
    timestamp
  });

  const signature = signWithKey('RSA-SHA256', Buffer.from(message, 'utf8'), signing.privateKeyPem).toString('base64');
  return {
    ...headers,
    [EXECUTION_SIGNATURE_HEADERS.algorithm]: 'rsa-sha256',
    [EXECUTION_SIGNATURE_HEADERS.keyId]: signing.keyId,
    [EXECUTION_SIGNATURE_HEADERS.signature]: signature,
    [EXECUTION_SIGNATURE_HEADERS.timestamp]: timestamp
  };
}

export function isLikelyOracleControlPlaneUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim();
  if (!normalized) {
    return false;
  }
  return /^https:\/\/iaas\.[^.]+-\d+\.oraclecloud\.com\/?$/i.test(normalized);
}
