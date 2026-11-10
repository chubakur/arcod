// v0.1 emitter ships reference implementations for a small set of operations.
// These bodies are templates, not derivations from the model.
export const HANDLER_TEMPLATES: Record<string, string> = {
  create: 'kv.put',
  read: 'kv.take',
};

// Guarded variants: the payload is stored with a password hash and revealed
// only after verification.
export const GUARDED_HANDLER_TEMPLATES: Record<string, string> = {
  create: 'kv.put+scrypt',
  read: 'kv.verify+take',
};

export function templateFor(opName: string, guarded = false): string | null {
  const table = guarded ? GUARDED_HANDLER_TEMPLATES : HANDLER_TEMPLATES;
  return table[opName] ?? null;
}
