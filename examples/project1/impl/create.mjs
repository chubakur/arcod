export async function create(input, io) {
  const { author, body } = input;
  if (author.length < 1 || author.length > 255) return { error: "Invalid" };
  if (body.length < 1 || body.length > 65536) return { error: "Invalid" };
  const id = await io.new();
  await io.save(id, { b: { author, body }, h: null });
  return { result: id };
}