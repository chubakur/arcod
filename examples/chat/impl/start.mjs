export async function start(input, io) {
  const id = await io.new();
  await io.save(id, { b: JSON.stringify({ messages: [] }), h: null });
  return { result: id };
}
