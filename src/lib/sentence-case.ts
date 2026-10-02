/**
 * A capital at the start of each sentence, and "I" as a word. The prompt asks
 * for both; this holds drafts written before it did, and the odd one that
 * still comes back in lowercase. Nothing else is touched - it cannot tell a
 * name from a common word.
 */
export function sentenceCase(text: string): string {
  return text
    .replace(/(^|[.!?]["')]?\s+)([a-z])(?![A-Z])/g, (_, before: string, letter: string) => before + letter.toUpperCase())
    .replace(/(^|[^\w'])i(?=$|[^\w']|'(?:m|d|ve|ll)\b)/g, "$1I");
}
