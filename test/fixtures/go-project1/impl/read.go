// The author's Go body for read: at-most-once lives here, because the kit
// emits no invariant code (the Node runtime does not either — the body is the
// promise). A missing key plus a 'seen' marker is Gone; without the marker it
// was never issued, which is NotFound.
func opRead(io *arcodio.IO, in map[string]any) (any, error) {
	id, _ := in["id"].(string)
	key := "msg:" + id
	raw, ok, err := io.KV.Get(key)
	if err != nil {
		return nil, err
	}
	if !ok {
		if seen, err := io.KV.Has("seen:" + id); err == nil && seen {
			return nil, ErrGone
		}
		return nil, ErrNotFound
	}
	var record struct {
		B map[string]any `json:"b"`
	}
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		return nil, err
	}
	if _, err := io.KV.Del(key); err != nil {
		return nil, err
	}
	if err := io.KV.Set("seen:"+id, "1", 0); err != nil {
		return nil, err
	}
	return record.B, nil
}
