// One text in, one vector out. The width is whatever the binding declared
// (dim in the spec); the body does not know the model or its size.
export async function add(input, io) {
  const text = String(input.text || '').trim();
  if (!text) return { error: 'Invalid' };

  const vectors = await io.embed([text]);
  const vector = vectors && vectors[0];
  if (!vector || vector.length === 0) return { error: 'Invalid' };

  const record = { id: await io.new(), text, vector };
  await io.insert('Note', record);
  return { result: { id: record.id, dim: vector.length } };
}
