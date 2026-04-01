#!/usr/bin/env node
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  buildError,
  normalizeCommonText,
  parseCliArgs,
  runProcess,
  writeJson
} = require('./export-utils.cjs');

function stripCoqCommentsAndStrings(source) {
  let output = '';
  let index = 0;
  let blockDepth = 0;
  let inString = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1] || '';

    if (blockDepth > 0) {
      if (current === '(' && next === '*') {
        blockDepth += 1;
        output += '  ';
        index += 2;
        continue;
      }
      if (current === '*' && next === ')') {
        blockDepth -= 1;
        output += '  ';
        index += 2;
        continue;
      }
      output += current === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (inString) {
      if (current === '"' && source[index - 1] !== '\\') {
        inString = false;
      }
      output += current === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (current === '(' && next === '*') {
      blockDepth = 1;
      output += '  ';
      index += 2;
      continue;
    }

    if (current === '"') {
      inString = true;
      output += ' ';
      index += 1;
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}

function popStack(stack, name) {
  if (!stack.length) {
    return;
  }

  if (!name) {
    stack.pop();
    return;
  }

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (entry === name) {
      stack.splice(index, 1);
      return;
    }
  }

  stack.pop();
}

function detectCoqDeclarations(source) {
  const cleaned = stripCoqCommentsAndStrings(source);
  const lines = cleaned.split(/\r?\n/);
  const moduleStack = [];
  const declarations = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const moduleMatch = trimmed.match(/^Module(?:\s+Type)?\s+([A-Za-z_][A-Za-z0-9_']*)\b/);
    if (moduleMatch) {
      moduleStack.push(moduleMatch[1]);
      continue;
    }

    const endMatch = trimmed.match(/^End\s+([A-Za-z_][A-Za-z0-9_']*)\s*\./);
    if (endMatch) {
      popStack(moduleStack, endMatch[1]);
      continue;
    }

    const declarationMatch = trimmed.match(/^(?:Local\s+|Global\s+|Program\s+|Polymorphic\s+|Monomorphic\s+|Cumulative\s+|NonCumulative\s+)*(Theorem|Lemma|Fact|Remark|Corollary|Proposition|Definition|Fixpoint|Let)\s+([A-Za-z_][A-Za-z0-9_']*)\b/);
    if (!declarationMatch) {
      continue;
    }

    const name = declarationMatch[2];
    declarations.push({
      kind: declarationMatch[1],
      name,
      fullName: moduleStack.length ? `${moduleStack.join('.')}.${name}` : name
    });
  }

  return declarations;
}

function extractCoqType(checkText) {
  const compact = String(checkText || '').trim();
  const colonIndex = compact.indexOf(':');
  if (colonIndex < 0) {
    return compact;
  }
  return compact.slice(colonIndex + 1).trim();
}

function extractCoqBody(printText) {
  const compact = String(printText || '').trim();
  const assignIndex = compact.indexOf(':=');
  if (assignIndex >= 0) {
    return compact.slice(assignIndex + 2).trim();
  }
  const equalIndex = compact.indexOf('=');
  if (equalIndex >= 0) {
    return compact.slice(equalIndex + 1).trim();
  }
  return compact;
}

async function main() {
  const { flags, positional } = parseCliArgs(process.argv.slice(2));
  const sourcePath = positional[0];
  const outPath = flags.out;

  if (!sourcePath || !outPath) {
    throw buildError('Usage: convert-coq.cjs --out <path> <source-file>');
  }

  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const declarations = detectCoqDeclarations(sourceText);
  const target = declarations[declarations.length - 1];

  if (!target) {
    throw buildError('Could not find a named Coq declaration to export', {
      supported: ['Theorem', 'Lemma', 'Fact', 'Remark', 'Corollary', 'Proposition', 'Definition', 'Fixpoint', 'Let']
    });
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ivucx-coq-export-'));
  const exportPath = path.join(tempDir, path.basename(sourcePath));
  const exportSource = [
    sourceText,
    '',
    'Set Printing All.',
    'Set Printing Universes.',
    'Set Printing Width 1000000.',
    `Print ${target.fullName}.`,
    `Check ${target.fullName}.`,
    ''
  ].join('\n');

  try {
    await fs.writeFile(exportPath, exportSource, 'utf8');
    const coqCommand = process.env.IVUCX_COQ_CMD || process.env.COQ_CMD || 'coqc';
    const result = await runProcess(coqCommand, [exportPath], {
      cwd: path.dirname(sourcePath),
      timeoutMs: Number(process.env.IVUCX_CONVERTER_TIMEOUT_MS || 180000)
    });

    if (result.timedOut) {
      throw buildError('Coq converter timed out', result);
    }
    if (result.exitCode !== 0) {
      throw buildError('Coq converter failed', result);
    }

    const stdout = String(result.stdout || '').trim();
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const checkLine = [...lines].reverse().find((line) => line.startsWith(`${target.name} :`) || line.startsWith(`${target.fullName} :`));

    if (!checkLine) {
      throw buildError('Coq converter did not emit a recognizable Check line', result);
    }

    const checkIndex = stdout.lastIndexOf(checkLine);
    const printText = stdout.slice(0, checkIndex).trim();
    const bodyText = extractCoqBody(printText);
    const typeText = extractCoqType(checkLine);

    await writeJson(outPath, {
      format: 'typed-lambda-v1',
      theoremName: target.fullName,
      term: {
        text: normalizeCommonText(bodyText),
        sourceText: bodyText
      },
      context: {
        typeText: normalizeCommonText(typeText),
        sourceTypeText: typeText
      },
      metadata: {
        sourceLanguage: 'Coq',
        declarationKind: target.kind,
        extraction: 'coq-print',
        rawPrint: printText,
        rawCheck: checkLine
      }
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  const details = error && error.details ? error.details : null;
  const payload = {
    error: error && error.message ? error.message : 'Coq converter failed',
    details
  };

  try {
    const { flags } = parseCliArgs(process.argv.slice(2));
    if (flags.out) {
      await writeJson(flags.out, payload);
    }
  } catch (writeError) {
    // ignore secondary write failures
  }

  console.error(payload.error);
  if (details) {
    console.error(JSON.stringify(details, null, 2));
  }
  process.exit(1);
});