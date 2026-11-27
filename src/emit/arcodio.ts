// arcodio for Go services (B107.5): the generated facade over the resources a
// .arc service declares. The first slice carries the kv store — get/set/del/has
// over RESP — because kv is the one store the kit can serve without a dialect
// layer. Everything unsupported stays a build error, never a silent stub.
import type { ServiceNode } from '../ast.ts';

export function goModulePath(svc: ServiceNode): string {
  return 'arcod/' + svc.name.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
}

// The facade is emitted for every Go service: the operation signature names
// *arcodio.IO even when the service declares no store, so a body keeps one
// shape and a later store declaration does not rewrite every signature.
export function arcodioSource(): string {
  return `// Code generated from the .arc model by arcod. DO NOT EDIT.
//
// Package arcodio is the facade an operation body receives. It carries the
// kv store: Get/Set/Del/Has over RESP, one connection per service guarded by a
// mutex. A service without a bound store gets IO{} and a method call says so
// instead of panicking on a nil receiver.
package arcodio

import (
	"bufio"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// IO is what a handler passes to an operation body.
type IO struct {
	KV *KV
}

// ErrNoStore is returned by a store method on a service that declares no
// store; it is a wiring mistake, not a client error.
var ErrNoStore = errors.New("arcodio: no kv store is bound to this service")

// Connect builds the facade from the environment the deployment provides:
// KV_HOST/KV_PORT (compose writes both) or REDIS_URL. The connection opens on
// the first command, so a service boots even while the store is starting.
func Connect() *IO {
	if address := os.Getenv("KV_URL"); address != "" {
		return &IO{KV: NewKV(address)}
	}
	host, port := os.Getenv("KV_HOST"), os.Getenv("KV_PORT")
	if host != "" && port != "" {
		return &IO{KV: NewKV(host + ":" + port)}
	}
	if url := os.Getenv("REDIS_URL"); url != "" {
		return &IO{KV: NewKV(strings.TrimPrefix(strings.TrimPrefix(url, "redis://"), "tcp://"))}
	}
	return &IO{}
}

// KV is the kv store of the service.
type KV struct {
	mu   sync.Mutex
	addr string
	conn net.Conn
	r    *bufio.Reader
	w    *bufio.Writer
}

// NewKV points a client at "host:port"; the socket opens lazily.
func NewKV(addr string) *KV { return &KV{addr: addr} }

func (kv *KV) dial() error {
	if kv.conn != nil {
		return nil
	}
	conn, err := net.DialTimeout("tcp", kv.addr, 5*time.Second)
	if err != nil {
		return err
	}
	kv.conn = conn
	kv.r = bufio.NewReader(conn)
	kv.w = bufio.NewWriter(conn)
	return nil
}

// call writes one command and reads one reply. A transport error drops the
// socket so the next call reconnects instead of reading a stale stream.
func (kv *KV) call(args ...string) (any, error) {
	if kv == nil {
		return nil, ErrNoStore
	}
	kv.mu.Lock()
	defer kv.mu.Unlock()
	if err := kv.dial(); err != nil {
		return nil, err
	}
	_ = kv.conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := kv.w.WriteString("*" + strconv.Itoa(len(args)) + "\r\n"); err != nil {
		kv.reset()
		return nil, err
	}
	for _, arg := range args {
		if _, err := kv.w.WriteString("$" + strconv.Itoa(len(arg)) + "\r\n" + arg + "\r\n"); err != nil {
			kv.reset()
			return nil, err
		}
	}
	if err := kv.w.Flush(); err != nil {
		kv.reset()
		return nil, err
	}
	reply, err := readReply(kv.r)
	if err != nil {
		var netErr *net.OpError
		if errors.As(err, &netErr) {
			kv.reset()
		}
		return nil, err
	}
	return reply, nil
}

func (kv *KV) reset() {
	if kv.conn != nil {
		_ = kv.conn.Close()
	}
	kv.conn, kv.r, kv.w = nil, nil, nil
}

// Close drops the connection; a service usually lives until it is killed.
func (kv *KV) Close() error {
	if kv == nil {
		return nil
	}
	kv.mu.Lock()
	defer kv.mu.Unlock()
	kv.reset()
	return nil
}

func readReply(r *bufio.Reader) (any, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	if line == "" {
		return nil, errors.New("arcodio: empty reply")
	}
	switch line[0] {
	case '+':
		return strings.TrimRight(line[1:], "\r\n"), nil
	case '-':
		return nil, errors.New(strings.TrimRight(line[1:], "\r\n"))
	case ':':
		value, err := strconv.ParseInt(strings.TrimRight(line[1:], "\r\n"), 10, 64)
		if err != nil {
			return nil, err
		}
		return value, nil
	case '$':
		size, err := strconv.Atoi(strings.TrimRight(line[1:], "\r\n"))
		if err != nil {
			return nil, err
		}
		if size < 0 {
			return nil, nil
		}
		buf := make([]byte, size+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		return string(buf[:size]), nil
	case '*':
		size, err := strconv.Atoi(strings.TrimRight(line[1:], "\r\n"))
		if err != nil {
			return nil, err
		}
		if size < 0 {
			return nil, nil
		}
		items := make([]any, size)
		for index := range items {
			item, err := readReply(r)
			if err != nil {
				return nil, err
			}
			items[index] = item
		}
		return items, nil
	}
	return nil, errors.New("arcodio: unsupported reply")
}

// Get reads a key; the bool says whether it existed.
func (kv *KV) Get(key string) (string, bool, error) {
	reply, err := kv.call("GET", key)
	if err != nil {
		return "", false, err
	}
	text, ok := reply.(string)
	if !ok {
		return "", false, nil
	}
	return text, true, nil
}

// Set writes a key, with a TTL when ttl > 0.
func (kv *KV) Set(key, value string, ttl time.Duration) error {
	args := []string{"SET", key, value}
	if ttl > 0 {
		args = append(args, "PX", strconv.FormatInt(ttl.Milliseconds(), 10))
	}
	_, err := kv.call(args...)
	return err
}

// Del removes a key; the bool says whether it was there.
func (kv *KV) Del(key string) (bool, error) {
	reply, err := kv.call("DEL", key)
	if err != nil {
		return false, err
	}
	removed, ok := reply.(int64)
	return ok && removed > 0, nil
}

// Has answers whether the key exists.
func (kv *KV) Has(key string) (bool, error) {
	reply, err := kv.call("EXISTS", key)
	if err != nil {
		return false, err
	}
	count, ok := reply.(int64)
	return ok && count > 0, nil
}
`;
}
