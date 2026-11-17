export async function create(input, io) {
  const text = String(input.text || '').trim();
  if (!text) return { error: 'Invalid' };
  const id = await io.new();
  const note = { id, text };
  await io.save(id, { b: note, h: {} });
  return { result: note };
}
