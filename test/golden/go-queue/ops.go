// Operation bodies for Orders. Bodies come from impl/*.go;
// the rest are stubs. Keep the signature and never edit main.go.
package main

import arcodio "arcod/orders/arcodio"

// opPlace implements POST /v1/orders.
// Place the order and announce it.
func opPlace(io *arcodio.IO, in map[string]any) (any, error) {
	id, _ := in["id"].(string)
	sku, _ := in["sku"].(string)
	if sku == "" {
		return nil, ErrInvalid
	}
	if err := io.KV.Set("order:"+id, sku, 0); err != nil {
		return nil, err
	}
	if _, err := io.QueuePublish("orders.created", map[string]any{"id": id, "sku": sku}); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "sku": sku}, nil
}
