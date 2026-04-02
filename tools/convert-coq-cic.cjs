#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  buildError,
  parseCliArgs,
  runProcess,
  writeJson
} = require('./export-utils.cjs');

function splitArgs(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return [];
  }

  const args = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < rawValue.length; i += 1) {
    const ch = rawValue[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && i + 1 < rawValue.length) {
        i += 1;
        current += rawValue[i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function resolveOutPath(argv, fallback) {
  const outIndex = argv.indexOf('--out');
  if (outIndex >= 0 && argv[outIndex + 1]) {
    return argv[outIndex + 1];
  }
  return fallback;
}

async function runExternalCoqExporter(sourcePath, outPath) {
  const command = String(process.env.IVUCX_COQ_CIC_EXPORT_CMD || process.env.COQ_CIC_EXPORT_CMD || '').trim();
  const rawArgs = String(process.env.IVUCX_COQ_CIC_EXPORT_ARGS || process.env.COQ_CIC_EXPORT_ARGS || '').trim();

  if (!command) {
    throw buildError(
      'No exact Coq CIC exporter is configured. Install a MetaRocq/PCUIC or equivalent exporter and set COQ_CIC_EXPORT_CMD / COQ_CIC_EXPORT_ARGS.'
    );
  }

  const tempOutput = path.join(path.dirname(sourcePath), 'coq-cic-export.json');
  const args = splitArgs(rawArgs).map((arg) => arg
    .replaceAll('{file}', sourcePath)
    .replaceAll('{out}', tempOutput)
    .replaceAll('{dir}', path.dirname(sourcePath))
    .replaceAll('{name}', path.basename(sourcePath)));

  if (!splitArgs(rawArgs).some((arg) => String(arg).includes('{file}'))) {
    args.push(sourcePath);
  }

  const result = await runProcess(command, args, {
    cwd: path.dirname(sourcePath),
    env: process.env,
    timeoutMs: Number(process.env.IVUCX_CONVERTER_TIMEOUT_MS || 180000)
  });

  if (result.timedOut) {
    throw buildError('Coq CIC exporter timed out', result);
  }
  if (result.exitCode !== 0) {
    throw buildError('Coq CIC exporter failed', result);
  }

  let rawJson = String(result.stdout || '').trim();
  if (!rawJson) {
    rawJson = await fs.readFile(tempOutput, 'utf8');
  }

  let structured;
  try {
    structured = JSON.parse(rawJson);
  } catch (error) {
    throw buildError('Coq CIC exporter returned invalid JSON', {
      stdout: result.stdout,
      stderr: result.stderr
    });
  }

  const theoremName = structured.theoremName || structured.name || path.parse(sourcePath).name;
  const term = structured.term || structured.expression || structured.pcuic || structured.cic || structured.ast || null;
  const context = structured.context || (structured.type ? { type: structured.type } : null);

  if (!term) {
    throw buildError('Coq CIC exporter JSON did not contain a term payload');
  }

  await writeJson(outPath, {
    format: 'cic-v1',
    theoremName,
    term,
    context,
    declarations: structured.declarations || null,
    metadata: {
      sourceLanguage: 'Coq',
      extraction: structured.metadata && structured.metadata.extraction
        ? structured.metadata.extraction
        : 'external-coq-cic-exporter',
      exporter: {
        command,
        args
      },
      upstreamMetadata: structured.metadata || null
    }
  });
}

async function main() {
  const { flags, positional } = parseCliArgs(process.argv.slice(2));
  const sourcePath = positional[0];
  const outPath = flags.out;

  if (!sourcePath || !outPath) {
    throw buildError('Usage: convert-coq-cic.cjs --out <path> <source-file>');
  }

  await runExternalCoqExporter(sourcePath, outPath);
}

main().catch(async (error) => {
  const details = error && error.details ? error.details : null;
  await writeJson(resolveOutPath(process.argv, path.join(process.cwd(), 'result.out')), {
    error: error && error.message ? error.message : 'Coq CIC converter failed',
    details
  });
  process.exit(1);
});
