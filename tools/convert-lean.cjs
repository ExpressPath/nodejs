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

const PRINT_MARKER = 'IVUCX_LEAN_PRINT_START';
const CHECK_MARKER = 'IVUCX_LEAN_CHECK_START';
const END_MARKER = 'IVUCX_LEAN_EXPORT_END';

function stripLeanCommentsAndStrings(source) {
  let output = '';
  let index = 0;
  let blockDepth = 0;
  let inLineComment = false;
  let inString = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1] || '';

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
        output += '\n';
      } else {
        output += ' ';
      }
      index += 1;
      continue;
    }

    if (blockDepth > 0) {
      if (current === '/' && next === '-') {
        blockDepth += 1;
        output += '  ';
        index += 2;
        continue;
      }
      if (current === '-' && next === '/') {
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

    if (current === '-' && next === '-') {
      inLineComment = true;
      output += '  ';
      index += 2;
      continue;
    }

    if (current === '/' && next === '-') {
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
    const fullName = entry.parts.join('.');
    if (entry.rawName === name || fullName === name || entry.parts[entry.parts.length - 1] === name) {
      stack.splice(index, 1);
      return;
    }
  }

  stack.pop();
}

function detectLeanDeclarations(source) {
  const cleaned = stripLeanCommentsAndStrings(source);
  const lines = cleaned.split(/\r?\n/);
  const namespaceStack = [];
  const declarations = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const namespaceMatch = trimmed.match(/^namespace\s+([A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*)\b/);
    if (namespaceMatch) {
      namespaceStack.push({ rawName: namespaceMatch[1], parts: namespaceMatch[1].split('.') });
      continue;
    }

    const sectionMatch = trimmed.match(/^section(?:\s+([A-Za-z_][A-Za-z0-9_']*))?\b/);
    if (sectionMatch) {
      namespaceStack.push({ rawName: sectionMatch[1] || '', parts: [] });
      continue;
    }

    const endMatch = trimmed.match(/^end(?:\s+([A-Za-z_][A-Za-z0-9_'.]*))?\b/);
    if (endMatch) {
      popStack(namespaceStack, endMatch[1] || '');
      continue;
    }

    const declarationMatch = trimmed.match(/^(?:@[A-Za-z0-9_.]+\s+)*(?:(?:private|protected|noncomputable|unsafe|partial|local|scoped)\s+)*(theorem|lemma|def|abbrev|opaque)\s+([A-Za-z_][A-Za-z0-9_']*)\b/);
    if (!declarationMatch) {
      continue;
    }

    const namespaceParts = namespaceStack
      .filter((entry) => Array.isArray(entry.parts) && entry.parts.length > 0)
      .flatMap((entry) => entry.parts);

    declarations.push({
      kind: declarationMatch[1],
      name: declarationMatch[2],
      fullName: namespaceParts.length ? `${namespaceParts.join('.')}.${declarationMatch[2]}` : declarationMatch[2]
    });
  }

  return declarations;
}

function getSectionBetween(source, startMarker, endMarker) {
  const startIndex = source.indexOf(startMarker);
  if (startIndex < 0) {
    return '';
  }
  const fromIndex = startIndex + startMarker.length;
  const endIndex = source.indexOf(endMarker, fromIndex);
  if (endIndex < 0) {
    return source.slice(fromIndex).trim();
  }
  return source.slice(fromIndex, endIndex).trim();
}

function extractLeanType(checkText) {
  const compact = String(checkText || '').trim();
  const colonIndex = compact.indexOf(':');
  if (colonIndex < 0) {
    return compact;
  }
  return compact.slice(colonIndex + 1).trim();
}

function extractLeanBody(printText) {
  const compact = String(printText || '').trim();
  const assignIndex = compact.indexOf(':=');
  if (assignIndex < 0) {
    return compact;
  }
  return compact.slice(assignIndex + 2).trim();
}

async function main() {
  const { flags, positional } = parseCliArgs(process.argv.slice(2));
  const sourcePath = positional[0];
  const outPath = flags.out;

  if (!sourcePath || !outPath) {
    throw buildError('Usage: convert-lean.cjs --out <path> <source-file>');
  }

  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const declarations = detectLeanDeclarations(sourceText);
  const target = declarations[declarations.length - 1];

  if (!target) {
    throw buildError('Could not find a named Lean declaration to export', {
      supported: ['theorem', 'lemma', 'def', 'abbrev', 'opaque']
    });
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ivucx-lean-export-'));
  const exportPath = path.join(tempDir, path.basename(sourcePath));
  const exportSource = [
    sourceText,
    '',
    'set_option pp.universes true',
    'set_option pp.explicit true',
    'set_option pp.fullNames true',
    `#eval IO.println "${PRINT_MARKER}"`,
    `#print ${target.fullName}`,
    `#eval IO.println "${CHECK_MARKER}"`,
    `#check ${target.fullName}`,
    `#eval IO.println "${END_MARKER}"`,
    ''
  ].join('\n');

  try {
    await fs.writeFile(exportPath, exportSource, 'utf8');
    const leanCommand = process.env.IVUCX_LEAN_CMD || process.env.LEAN_CMD || 'lean';
    const result = await runProcess(leanCommand, [exportPath], {
      cwd: path.dirname(sourcePath),
      timeoutMs: Number(process.env.IVUCX_CONVERTER_TIMEOUT_MS || 180000)
    });

    if (result.timedOut) {
      throw buildError('Lean converter timed out', result);
    }
    if (result.exitCode !== 0) {
      throw buildError('Lean converter failed', result);
    }

    const printText = getSectionBetween(result.stdout, PRINT_MARKER, CHECK_MARKER);
    const checkText = getSectionBetween(result.stdout, CHECK_MARKER, END_MARKER);

    if (!printText || !checkText) {
      throw buildError('Lean converter did not emit the expected proof markers', result);
    }

    const typeText = extractLeanType(checkText);
    const bodyText = extractLeanBody(printText);

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
        sourceLanguage: 'Lean',
        declarationKind: target.kind,
        extraction: 'lean-print',
        rawPrint: printText,
        rawCheck: checkText
      }
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  const details = error && error.details ? error.details : null;
  const payload = {
    error: error && error.message ? error.message : 'Lean converter failed',
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