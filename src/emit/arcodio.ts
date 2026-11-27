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
	if _, err := kv.w.WriteString("*" + strconv.Itoa(len(args)) + "\\r\\n"); err != nil {
		kv.reset()
		return nil, err
	}
	for _, arg := range args {
		if _, err := kv.w.WriteString("$" + strconv.Itoa(len(arg)) + "\\r\\n" + arg + "\\r\\n"); err != nil {
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
	line, err := r.ReadString('\\n')
	if err != nil {
		return nil, err
	}
	if line == "" {
		return nil, errors.New("arcodio: empty reply")
	}
	switch line[0] {
	case '+':
		return strings.TrimRight(line[1:], "\\r\\n"), nil
	case '-':
		return nil, errors.New(strings.TrimRight(line[1:], "\\r\\n"))
	case ':':
		value, err := strconv.ParseInt(strings.TrimRight(line[1:], "\\r\\n"), 10, 64)
		if err != nil {
			return nil, err
		}
		return value, nil
	case '$':
		size, err := strconv.Atoi(strings.TrimRight(line[1:], "\\r\\n"))
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
		size, err := strconv.Atoi(strings.TrimRight(line[1:], "\\r\\n"))
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

// The queue (B107.5b, consumer half B111.2), generated as its own file in the
// arcodio package: a service that binds no queue carries no queue code, and
// the kv facade stays byte for byte as it was. The wire is the Node runtime's
// — RPUSH on 'arcod:q:<topic>' with the envelope {"payload":…,"attempts":0},
// LPOP to receive, and '<topic>:dead' for messages out of retries — so a Go
// publisher feeds a Node consumer and a Go consumer drains a Node publisher.
export function arcodioQueueSource(): string {
  return [
    '// Code generated from the .arc model by arcod. DO NOT EDIT.',
    '//',
    '// The queue: a body calls io.QueuePublish(topic, message) and the message',
    '// lands where the Node runtime consumer already listens. A job operation',
    '// is run by the consumer loop in main.go, which uses QueueReceive,',
    '// QueueRequeue and QueueDead below — the same three calls the Node',
    '// runtime makes, in the same order.',
    'package arcodio',
    '',
    'import (',
    '\t"encoding/json"',
    '\t"errors"',
    '\t"os"',
    '\t"strconv"',
    '\t"strings"',
    '\t"sync"',
    '\t"sync/atomic"',
    '\t"time"',
    ')',
    '',
    '// queuePrefix is the namespace the Node queue runtime writes under.',
    'const queuePrefix = "arcod:q:"',
    '',
    '// ErrNoQueue says the service bound no queue: a wiring mistake, not a',
    '// client error.',
    'var ErrNoQueue = errors.New("arcodio: no queue is bound to this service")',
    '',
    'var (',
    '\tqueueOnce   sync.Once',
    '\tqueueClient *KV',
    ')',
    '',
    '// queueAddress names the broker. compose writes QUEUE_REDIS_URL for a',
    '// redis bound as queue; the kv address is the fallback, because one',
    '// redis may carry both stores.',
    'func queueAddress() string {',
    '\tif url := os.Getenv("QUEUE_REDIS_URL"); url != "" {',
    '\t\treturn trimQueueScheme(url)',
    '\t}',
    '\tif address := os.Getenv("KV_URL"); address != "" {',
    '\t\treturn address',
    '\t}',
    '\thost, port := os.Getenv("KV_HOST"), os.Getenv("KV_PORT")',
    '\tif host != "" && port != "" {',
    '\t\treturn host + ":" + port',
    '\t}',
    '\tif url := os.Getenv("REDIS_URL"); url != "" {',
    '\t\treturn trimQueueScheme(url)',
    '\t}',
    '\treturn ""',
    '}',
    '',
    'func trimQueueScheme(url string) string {',
    '\treturn strings.TrimPrefix(strings.TrimPrefix(url, "redis://"), "tcp://")',
    '}',
    '',
    '// queueConnection opens the broker on first use, so a service boots even',
    '// while the store is starting.',
    'func queueConnection() *KV {',
    '\tqueueOnce.Do(func() {',
    '\t\tif address := queueAddress(); address != "" {',
    '\t\t\tqueueClient = NewKV(address)',
    '\t\t}',
    '\t})',
    '\treturn queueClient',
    '}',
    '',
    '// QueuePublish appends a message to a topic. The envelope is the Node',
    '// runtime one, so one broker serves both languages; Go sorts map keys,',
    '// and JSON makes the order irrelevant. The bool is the Node receipt:',
    '// true once the broker accepted the message.',
    'func (io *IO) QueuePublish(topic string, message any) (bool, error) {',
    '\tclient := queueConnection()',
    '\tif client == nil {',
    '\t\treturn false, ErrNoQueue',
    '\t}',
    '\ttext, err := json.Marshal(map[string]any{"payload": message, "attempts": 0})',
    '\tif err != nil {',
    '\t\treturn false, err',
    '\t}',
    '\tif _, err := client.call("RPUSH", queuePrefix+topic, string(text)); err != nil {',
    '\t\treturn false, err',
    '\t}',
    '\treturn true, nil',
    '}',
    '',
    '// queueLaterSeq keeps sorted-set members apart: a set holds a member once,',
    '// so two identical payloads would collapse into one. The nonce is stripped',
    '// when the member is promoted.',
    'var queueLaterSeq int64',
    '',
    '// QueueLater parks a message until its due moment. The wire is the Node',
    '// runtime one (B25): the member waits in "arcod:q:<topic>:later" scored by',
    '// the moment, and QueueReceive promotes what is due.',
    'func (io *IO) QueueLater(topic string, message any, delay time.Duration) (bool, error) {',
    '\tclient := queueConnection()',
    '\tif client == nil {',
    '\t\treturn false, ErrNoQueue',
    '\t}',
    '\tif delay < 0 {',
    '\t\treturn false, errors.New("arcodio: QueueLater needs a non-negative delay")',
    '\t}',
    '\ttext, err := json.Marshal(map[string]any{"payload": message, "attempts": 0})',
    '\tif err != nil {',
    '\t\treturn false, err',
    '\t}',
    '\tnow := time.Now()',
    '\tnonce := strconv.FormatInt(now.UnixNano(), 36) + "-" + strconv.FormatInt(atomic.AddInt64(&queueLaterSeq, 1), 36)',
    '\tdue := strconv.FormatInt(now.Add(delay).UnixMilli(), 10)',
    '\tif _, err := client.call("ZADD", queuePrefix+topic+":later", due, nonce+" "+string(text)); err != nil {',
    '\t\treturn false, err',
    '\t}',
    '\treturn true, nil',
    '}',
    '',
    '// queuePromote moves the due members of a topic into its list. ZREM is the',
    '// claim: two replicas polling one topic race here and only the one that',
    '// removed the member pushes it, so a delayed message is delivered once.',
    'func queuePromote(topic string) error {',
    '\tclient := queueConnection()',
    '\treply, err := client.call("ZRANGEBYSCORE", queuePrefix+topic+":later", "-inf", strconv.FormatInt(time.Now().UnixMilli(), 10), "LIMIT", "0", "100")',
    '\tif err != nil {',
    '\t\treturn err',
    '\t}',
    '\titems, ok := reply.([]any)',
    '\tif !ok {',
    '\t\treturn nil',
    '\t}',
    '\tfor _, item := range items {',
    '\t\tmember, ok := item.(string)',
    '\t\tif !ok {',
    '\t\t\tcontinue',
    '\t\t}',
    '\t\tclaimed, err := client.call("ZREM", queuePrefix+topic+":later", member)',
    '\t\tif err != nil {',
    '\t\t\treturn err',
    '\t\t}',
    '\t\tif count, ok := claimed.(int64); !ok || count <= 0 {',
    '\t\t\tcontinue',
    '\t\t}',
    '\t\ttext := member',
    '\t\tif index := strings.Index(member, " "); index >= 0 {',
    '\t\t\ttext = member[index+1:]',
    '\t\t}',
    '\t\tif _, err := client.call("RPUSH", queuePrefix+topic, text); err != nil {',
    '\t\t\treturn err',
    '\t\t}',
    '\t}',
    '\treturn nil',
    '}',
    '',
    '// QueueReceive takes the oldest message of a topic. The bool says the topic',
    '// was not empty: an idle poll is not an error, and the caller sleeps',
    '// instead of spinning. The Node runtime drains the same key with LPOP, so',
    '// either side can consume the other side\'s messages.',
    'func (io *IO) QueueReceive(topic string) (string, bool, error) {',
    '\tclient := queueConnection()',
    '\tif client == nil {',
    '\t\treturn "", false, ErrNoQueue',
    '\t}',
    '\tif err := queuePromote(topic); err != nil {',
    '\t\treturn "", false, err',
    '\t}',
    '\treply, err := client.call("LPOP", queuePrefix+topic)',
    '\tif err != nil {',
    '\t\treturn "", false, err',
    '\t}',
    '\ttext, ok := reply.(string)',
    '\tif !ok {',
    '\t\treturn "", false, nil',
    '\t}',
    '\treturn text, true, nil',
    '}',
    '',
    '// QueueRequeue puts a failed attempt back at the head of the topic: the',
    '// retry is the next message the loop sees, as LPUSH is in the Node runtime.',
    'func (io *IO) QueueRequeue(topic, text string) error {',
    '\tclient := queueConnection()',
    '\tif client == nil {',
    '\t\treturn ErrNoQueue',
    '\t}',
    '\t_, err := client.call("LPUSH", queuePrefix+topic, text)',
    '\treturn err',
    '}',
    '',
    '// QueueDead appends a message to the topic\'s dead letter, where',
    '// io.queueDead reads it in both runtimes.',
    'func (io *IO) QueueDead(topic, text string) error {',
    '\tclient := queueConnection()',
    '\tif client == nil {',
    '\t\treturn ErrNoQueue',
    '\t}',
    '\t_, err := client.call("RPUSH", queuePrefix+topic+":dead", text)',
    '\treturn err',
    '}',
    '',
  ].join('\n');
}
