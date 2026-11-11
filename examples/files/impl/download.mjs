export async function download(input, io) {
  const actor = await io.actor();
  const id = String(input.id);
  const rec = await io.load(id);
  if (!rec || !rec.b) return { error: 'NotFound' };
  if (!canRead(actor, rec.b)) return { error: actor ? 'Forbidden' : 'Unauthorized' };
  const body = await io.blobGet('files/' + id);
  if (body == null) return { error: 'NotFound' };
  return { result: { name: rec.b.name, body } };
}
