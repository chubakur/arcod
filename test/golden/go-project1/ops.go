// Operation bodies for OneTimeMessage. Bodies come from impl/*.go;
// the rest are stubs. Keep the signature and never edit main.go.
package main

import arcodio "arcod/onetimemessage/arcodio"

// opCreate implements POST /v1/api/messages.
func opCreate(io *arcodio.IO, in map[string]any) (any, error) {
	return nil, &OpError{Name: "NotImplemented", Status: 501, Message: "implement create according to the .arc contract"}
}

// opRead implements GET /v1/api/messages/:id.
func opRead(io *arcodio.IO, in map[string]any) (any, error) {
	return nil, &OpError{Name: "NotImplemented", Status: 501, Message: "implement read according to the .arc contract"}
}
