// The author's Go body for create. It is spliced into ops.go verbatim, so it
// has no package clause and no import block: the kit adds the stdlib imports
// whose identifiers the body spells (encoding/json, strconv here).
func opCreate(io *arcodio.IO, in map[string]any) (any, error) {
	author, _ := in["author"].(string)
	body, _ := in["body"].(string)
	if len(author) < 1 || len(author) > 255 {
		return nil, ErrInvalid
	}
	if len(body) < 1 || len(body) > 65536 {
		return nil, ErrInvalid
	}
	id := newMessageId(io)
	record := map[string]any{
		"b": map[string]any{"author": author, "body": body},
		"h": nil,
	}
	raw, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	if err := io.KV.Set("msg:"+id, string(raw), 0); err != nil {
		return nil, err
	}
	return id, nil
}

// newMessageId counts in the store instead of asking for a uuid capability:
// the first Go kit carries kv only.
func newMessageId(io *arcodio.IO) string {
	next := 0
	if raw, ok, err := io.KV.Get("counter"); err == nil && ok {
		next, _ = strconv.Atoi(raw)
	}
	next++
	_ = io.KV.Set("counter", strconv.Itoa(next), 0)
	return "id-" + strconv.Itoa(next)
}
