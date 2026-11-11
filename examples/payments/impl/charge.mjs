export async function charge(input, io) {
  const amount = Number(input.amount);
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'Invalid' };

  const id = await io.new();
  await io.save(id, { b: JSON.stringify({ amount, status: 'pending' }), h: null });

  let receipt;
  try {
    const out = await io.remote('Ledger', 'record', { order: id, amount });
    receipt = out.body;
  } catch (error) {
    // The order stays pending; the caller may retry.
    return { error: 'Unavailable' };
  }

  await io.save(id, { b: JSON.stringify({ amount, status: 'charged', receipt }), h: null });
  return { result: { id, accepted: Boolean(receipt && receipt.accepted) } };
}
