// The corpus is small enough for a scan: the store returns notes, the body
// only compares. Cosine similarity keeps the score between -1 and 1, so a
// caller can threshold without knowing the model.
function cosine(left, right) {
  let dot = 0;
  let lnorm = 0;
  let rnorm = 0;
  const size = Math.min(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    lnorm += a * a;
    rnorm += b * b;
  }
  if (lnorm === 0 || rnorm === 0) return 0;
  return dot / (Math.sqrt(lnorm) * Math.sqrt(rnorm));
}

export async function search(input, io) {
  const q = String(input.q || '').trim();
  if (!q) return { error: 'Invalid' };
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 10;

  const vectors = await io.embed([q]);
  const query = vectors && vectors[0];
  if (!query || query.length === 0) return { error: 'Invalid' };

  const page = await io.find('Note', {});
  const notes = page && Array.isArray(page.items) ? page.items : [];
  const items = notes
    .filter((note) => note && Array.isArray(note.vector) && typeof note.text === 'string')
    .map((note) => ({ id: note.id, text: note.text, score: cosine(query, note.vector) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  return { result: { items } };
}
