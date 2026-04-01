const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');

function truncateOutput(value) {
  if (!value) {
    return '';
  }

  if (value.length <= config.maxOutputChars) {
    return value;
  }

  return `${value.slice(0, config.maxOutputChars)}\n...[truncated]`;
}

function sanitizeFileName(fileName, fallbackFileName, extension) {
  const trimmed = typeof fileName === 'string' ? fileName.trim() : '';
  const baseName = path.basename(trimmed || fallbackFileName);
  const parsed = path.parse(baseName || fallbackFileName);
  const expectedExtension = extension || parsed.ext;
  return `${parsed.name || 'Main'}${expectedExtension}`;
}

function resolveArgs(args, replacements) {
  const templates = Array.isArray(args) ? args : [];
  const resolved = templates.map((arg) => String(arg)
    .replaceAll('{file}', replacements.filePath)
    .replaceAll('{out}', replacements.outputPath)
    .replaceAll('{name}', replacements.fileName)
    .replaceAll('{dir}', replacements.tempDir));

  if (!templates.some((arg) => String(arg).includes('{file}'))) {
    resolved.push(replacements.filePath);
  }

  return resolved;
}

async function runCommandForCode(options) {
  const {
    command,
    args,
    code,
    fileName,
    defaultFileName,
    extension,
    timeoutMs,
    tempPrefix
  } = options;

  if (!command || typeof command !== 'string') {
    const error = new Error('Command is not configured');
    error.statusCode = 503;
    throw error;
  }

  const normalizedCode = typeof code === 'string' ? code : '';
  if (!normalizedCode.trim()) {
    const error = new Error('code must be a non-empty string');
    error.statusCode = 400;
    throw error;
  }

  const codeBytes = Buffer.byteLength(normalizedCode, 'utf8');
  if (codeBytes > config.maxCodeBytes) {
    const error = new Error(`code is too large; max ${config.maxCodeBytes} bytes`);
    error.statusCode = 413;
    throw error;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix || 'helper-'));
  const safeFileName = sanitizeFileName(fileName, defaultFileName, extension);
  const filePath = path.join(tempDir, safeFileName);
  const outputPath = path.join(tempDir, 'result.out');
  const startedAt = Date.now();

  await fs.writeFile(filePath, normalizedCode, 'utf8');

  return new Promise((resolve, reject) => {
    const resolvedArgs = resolveArgs(args, {
      filePath,
      outputPath,
      fileName: safeFileName,
      tempDir
    });

    const child = spawn(command, resolvedArgs, {
      cwd: tempDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs || config.processTimeoutMs);

    const cleanup = async () => {
      clearTimeout(timeout);
      await fs.rm(tempDir, { recursive: true, force: true });
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', async (error) => {
      if (settled) {
        return;
      }

      settled = true;
      await cleanup();

      const wrapped = new Error(`Failed to start command '${command}': ${error.message}`);
      wrapped.statusCode = 500;
      reject(wrapped);
    });

    child.on('close', async (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;

      let outputText = '';
      try {
        outputText = await fs.readFile(outputPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') {
          await cleanup();
          return reject(error);
        }
      }

      await cleanup();

      resolve({
        ok: exitCode === 0 && !timedOut,
        command,
        args: resolvedArgs,
        fileName: safeFileName,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        codeBytes,
        stdout,
        stderr,
        outputText
      });
    });
  });
}

module.exports = {
  runCommandForCode,
  truncateOutput
};