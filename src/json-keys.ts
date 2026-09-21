/** Reject duplicate decoded keys in JSON whose syntax and size were checked by
 * the caller. Scan strings atomically so braces/colons inside values stay data. */
export function assertUniqueJsonKeys(text: string): void {
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  const stack: Array<Set<string> | null> = [];
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(text)) !== null) {
    const token = match[0];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else {
      let next = tokens.lastIndex;
      while (next < text.length && /[ \t\r\n]/.test(text[next])) next++;
      if (text[next] !== ":") continue;
      const key = JSON.parse(token) as string;
      const keys = stack[stack.length - 1];
      if (!keys || keys.has(key)) throw new Error("Duplicate JSON key");
      keys.add(key);
    }
  }
}
