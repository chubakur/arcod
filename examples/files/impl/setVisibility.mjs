export async function setVisibility(input, io) {
  const actor = await io.actor();
  if (!actor) return { error: 'Unauthorized' };
  const id = String(input.id);
  const rec = await io.load(id);
  if (!rec || !rec.b) return { error: 'NotFound' };
  if (rec.b.owner !== actor.id && !actor.admin) return { error: 'Forbidden' };
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
