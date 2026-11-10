export async function create(input, io) {
  const { body, password } = input;
  if (body.length < 1 || body.length > 65536) return { error: "Invalid" };
  if (password && (password.length < 1 || password.length > 128)) return { error: "Invalid" };

  const id = await io.new();
  const record = { b: body, h: password ? await io.hash(password) : null };
  await io.save(id, record);

  return { result: id };
}