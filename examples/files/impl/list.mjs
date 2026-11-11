export async function list(input, io) {
  // Anonymous callers are allowed: they only ever see public files.
  const actor = await io.actor();
  const items = await io.scan();
  const out = [];
  for (const item of items) {
    const meta = item.b;
    if (!meta || typeof meta !== 'object' || !meta.name) continue;
    if (!canRead(actor, meta)) continue;
    out.push({
      id: item.id,
      name: meta.name,
      owner: meta.owner,
      ownerName: meta.ownerName,
      visibility: meta.visibility,
      allowed: meta.allowed || [],
      size: meta.size || 0,
    });
  }
  out.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return { result: out };
}
