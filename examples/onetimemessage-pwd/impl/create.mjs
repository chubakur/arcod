export async function create(input, io) {
  const { body, password } = input;
  if (typeof body !== 'string' || body.length < 1 || body.length > 65536) {
    return { error: "Invalid" };
  }
  if (password !== null && (typeof password !== 'string' || password.length < 1 || password.length > 128)) {
    return { error: "Invalid" };
  }
  const id = await io.new();
  await io.save(id, { b: body, h: password ? await io.hash(password) : null });
  return { result: id };
}