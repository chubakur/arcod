// @arcod generated: op move · prompt b72f7e1117cb · model qwen2.5-coder:7b
export async function move(input, io) {
  const { id, status } = input;
  if (!status) return { error: 'Invalid' };

  const rec = await io.load(id);
  if (!rec) return { error: 'NotFound' };

  rec.b = { ...rec.b, status: status };
  await io.save(id, { b: rec.b, h: rec.h });

  return { result: rec.b };
}