// A room lives for a day: one short code for the audience, one token for the
// host. The code alphabet skips look-alikes (0/O, 1/I) because it is read
// aloud and typed on phones.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function pickCode() {
  let code = '';
  for (let i = 0; i < 4; i += 1) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

export async function start(input, io) {
  const id = await io.new();
  let code = null;
  for (let attempt = 0; attempt < 20 && !code; attempt += 1) {
    const candidate = pickCode();
    if (!(await io.load('code:' + candidate))) code = candidate;
  }
  if (!code) return { error: 'Unavailable' };

  const session = {
    code,
    token: await io.new(),
    index: 0,
    members: {},
    votes: {},
    ratings: {},
    comments: {},
  };
  await io.save(id, { b: session, h: null });
  await io.save('code:' + code, { b: { id }, h: null });
  return { result: { id, code, token: session.token } };
}
