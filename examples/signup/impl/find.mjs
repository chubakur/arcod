// Reading one account back by id: the kv store answers with the record
// `insert` stored, defaults already applied. A miss is the declared NotFound.
export async function find(input, io) {
  const account = await io.fetch('Account', input.id);
  if (!account) return { error: 'NotFound' };
  return { result: account };
}
