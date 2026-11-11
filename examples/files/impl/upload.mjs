export async function upload(input, io) {
  // The runtime guard already rejected anonymous callers (401): from here on
  // the actor exists. io.actor() is only needed for the owner field.
  const actor = await io.actor();
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

// Resource-level read policy (visibility matrix): not a standard guard, so
// it stays in the body. Standard authN/ownership checks are declarative.
function canRead(actor, meta) {
  if (!actor) return meta.visibility === 'public';
  if (actor.admin) return true;
  if (meta.owner === actor.id) return true;
  if (meta.visibility === 'public' || meta.visibility === 'authenticated') return true;
  return Array.isArray(meta.allowed) && meta.allowed.includes(actor.id);
}
