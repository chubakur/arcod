export async function upload(input, io) {
  const actor = await io.actor();
  if (!actor) return { error: 'Unauthorized' };
  const name = String(input.name || '');
  const body = String(input.body || '');
  const visibility = String(input.visibility || '');
  if (!name || !body) return { error: 'Invalid' };
  if (!isVisibility(visibility)) return { error: 'Invalid' };
  const allowed = Array.isArray(input.allowed) ? input.allowed.map(String) : [];
  if (visibility === 'restricted' && allowed.length === 0) return { error: 'Invalid' };

  const id = await io.new();
  const meta = {
    name,
    owner: actor.id,
    ownerName: actor.name,
    visibility,
    allowed,
    size: body.length,
  };
  await io.save(id, { b: meta, h: null });
  await io.blobPut(id, body, 'text/plain; charset=utf-8');
  return { result: id };
}

function isVisibility(value) {
  return value === 'public' || value === 'authenticated' || value === 'restricted';
}

function canRead(actor, meta) {
  if (!actor) return meta.visibility === 'public';
  if (actor.admin) return true;
  if (meta.owner === actor.id) return true;
  if (meta.visibility === 'public' || meta.visibility === 'authenticated') return true;
  return Array.isArray(meta.allowed) && meta.allowed.includes(actor.id);
}
