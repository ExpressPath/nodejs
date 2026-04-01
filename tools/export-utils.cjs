#!/usr/bin/env node
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');

function parseCliArgs(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) {
      positional.push(current);
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { flags, positional };
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 180000;
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finish(() => reject(error));
    });

    child.on('close', (exitCode, signal) => {
      finish(() => resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr
      }));
    });
  });
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCommonText(value) {
  return collapseWhitespace(value)
    .replace(/∀/g, 'forall ')
    .replace(/Π/g, 'Pi ')
    .replace(/λ/g, 'fun ')
    .replace(/→/g, ' -> ')
    .replace(/↦/g, ' => ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildError(message, details) {
  const error = new Error(message);
  error.details = details || null;
  return error;
}

module.exports = {
  buildError,
  collapseWhitespace,
  normalizeCommonText,
  parseCliArgs,
  runProcess,
  writeJson
};