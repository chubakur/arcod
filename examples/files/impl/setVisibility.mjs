export async function setVisibility(input, io) {
  // The runtime guard already checked auth (401) and ownership (403, admin
  // bypasses); a missing record came back as NotFound before this body ran.
  const id = String(input.id);
  const rec = await io.load(id);
  if (!rec || !rec.b) return { error: 'NotFound' };
  const visibility = String(input.visibility || '');
  if (!isVisibility(visibility)) return { error: 'Invalid' };
  const allowed = Array.isArray(input.allowed) ? input.allowed.map(String) : [];
  if (visibility === 'restricted' && allowed.length === 0) return { error: 'Invalid' };
  const meta = rec.b;
  meta.visibility = visibility;
  meta.allowed = allowed;
  await io.save(id, { b: meta, h: rec.h });
  return { result: true };
}
