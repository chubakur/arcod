// Place the order and announce it in one transaction. On the sql driver the
// insert and the publish commit together (the publish lands in the outbox table
// and a dispatcher relays it), so an OrderCreated event is never observed
// without its order — and a crash between the two is retried, not lost.
export async function create(input, io) {
  const sku = String(input.sku || '').trim();
  if (!sku) return { error: 'Invalid' };
  const qty = Number(input.qty);
  const order = {
    id: io.new(),
    sku,
    qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
    placedAt: new Date().toISOString(),
  };
  await io.insert('Order', order);
  await io.queuePublish('orders.created', order);
  return { result: order };
}
