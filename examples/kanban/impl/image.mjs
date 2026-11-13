// @arcod generated: op image · prompt 8566761257c8 · model qwen2.5-coder:7b
export async function image(input, io) {
  const { id } = input;
  const rec = await io.load(id);
  if (!rec) return { error: 'NotFound' };
  const body = await io.blobGet(id);
  return { result: body };
}