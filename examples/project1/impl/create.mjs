export async function create(input, io) {
  const { body } = input;
  if (typeof body !== 'string' || body.length < 1 || body.length > 65536) {
    return { error: "Invalid" };
  }
  const id = await io.new();
  await io.save(id, { b: body, h: null });
  return { result: id };
}