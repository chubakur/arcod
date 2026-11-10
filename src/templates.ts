// v0.1 emitter ships reference implementations for a small set of operations.
// These bodies are templates, not derivations from the model.
export const HANDLER_TEMPLATES: Record<string, string> = {
  create: 'kv.put',
  read: 'kv.take',
};

export function templateFor(opName: string): string | null {
  return HANDLER_TEMPLATES[opName] ?? null;
}
