export type TerminalCommand = {
  command: string;
  args: string[];
};

export function parseTerminalCommand(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): TerminalCommand | null {
  const parts = platform === 'win32'
    ? splitWindowsCommandLine(raw.trim()) ?? []
    : parsePosixCommandParts(raw.trim());
  const command = parts[0];
  return command
    ? { command, args: parts.slice(1) }
    : null;
}

function parsePosixCommandParts(raw: string) {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of raw) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (current) parts.push(current);
  return parts;
}

export function splitWindowsCommandLine(raw: string) {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of raw) {
    if (quote) {
      if (char === quote) {
        quote = null;
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
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (quote) return null;
  if (current) parts.push(current);
  return parts;
}
