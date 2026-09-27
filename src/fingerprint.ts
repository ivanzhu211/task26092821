const WHITESPACE = /\s+/g;

/**
 * 行指纹：文件按 '\n' 切行，取该行去掉全部空白字符后的文本。
 * 行号为 0、超出文件行数时返回 null（文件不存在的情况由调用方处理）。
 */
export function lineFingerprint(content: string, line: number): string | null {
  if (line <= 0) return null;
  const lines = content.split('\n');
  if (line > lines.length) return null;
  return lines[line - 1].replace(WHITESPACE, '');
}
