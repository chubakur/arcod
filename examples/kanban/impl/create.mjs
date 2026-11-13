// @arcod generated: op create · prompt c76d4d38b2ec · model qwen2.5-coder:7b
export async function create(input, io) {
  const { text, image } = input;
  const actor = await io.actor();
  if (!actor) return { error: 'Unauthorized' };

  if (!text) return { error: 'Invalid' };

  const id = await io.new();
  const record = {
    id,
    owner: actor.id,
    text,
    status: null,
    createdAt: new Date().toISOString(),
    imageId: image ? id : null
  };

  await io.save(id, { b: record, h: null });
  if (image) await io.blobPut(id, image);

  return { result: record };
}