export async function create(input, io) {
  const { body } = input;
  if (body.length < 1 || body.length > 65536) {
    return { error: "Invalid" };
  }
  const id = await io.new();
  const record = { b: body, h: null };
  await io.save(id, record);
  return { result: id };
}