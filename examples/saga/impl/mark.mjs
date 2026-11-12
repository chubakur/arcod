// The saga's first step: leave a durable side effect. If a later step fails,
// the runtime runs the compensation (unmark) to undo it.
export async function mark(input, io) {
  const label = String(input.label || '').trim();
  if (!label) return { error: 'Invalid' };
  const marker = await io.insert('Marker', { id: io.new(), label });
  return { result: marker };
}
