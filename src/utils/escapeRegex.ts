/**
 * Escapes every regex metacharacter so user input can be used inside a
 * MongoDB `$regex` as a LITERAL string. Raw patterns let a caller run a
 * catastrophic-backtracking expression on the database server (ReDoS).
 */
export const escapeRegex = (input: string): string =>
  input.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
