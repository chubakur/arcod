// Code generated from the .arc model by arcod. DO NOT EDIT.
//
// The queue: a body calls io.QueuePublish(topic, message) and the message
// lands where the Node runtime consumer already listens. A job operation
// is run by the consumer loop in main.go, which uses QueueReceive,
// QueueRequeue and QueueDead below — the same three calls the Node
// runtime makes, in the same order.
package arcodio

import (
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// queuePrefix is the namespace the Node queue runtime writes under.
const queuePrefix = "arcod:q:"

// ErrNoQueue says the service bound no queue: a wiring mistake, not a
// client error.
var ErrNoQueue = errors.New("arcodio: no queue is bound to this service")

var (
	queueOnce   sync.Once
	queueClient *KV
)

// queueAddress names the broker. compose writes QUEUE_REDIS_URL for a
// redis bound as queue; the kv address is the fallback, because one
// redis may carry both stores.
func queueAddress() string {
	if url := os.Getenv("QUEUE_REDIS_URL"); url != "" {
		return trimQueueScheme(url)
	}
	if address := os.Getenv("KV_URL"); address != "" {
		return address
	}
	host, port := os.Getenv("KV_HOST"), os.Getenv("KV_PORT")
	if host != "" && port != "" {
		return host + ":" + port
	}
	if url := os.Getenv("REDIS_URL"); url != "" {
		return trimQueueScheme(url)
	}
	return ""
}

func trimQueueScheme(url string) string {
	return strings.TrimPrefix(strings.TrimPrefix(url, "redis://"), "tcp://")
}

// queueConnection opens the broker on first use, so a service boots even
// while the store is starting.
func queueConnection() *KV {
	queueOnce.Do(func() {
		if address := queueAddress(); address != "" {
			queueClient = NewKV(address)
		}
	})
	return queueClient
}

// QueuePublish appends a message to a topic. The envelope is the Node
// runtime one, so one broker serves both languages; Go sorts map keys,
// and JSON makes the order irrelevant. The bool is the Node receipt:
// true once the broker accepted the message.
func (io *IO) QueuePublish(topic string, message any) (bool, error) {
	client := queueConnection()
	if client == nil {
		return false, ErrNoQueue
	}
	text, err := json.Marshal(map[string]any{"payload": message, "attempts": 0})
	if err != nil {
		return false, err
	}
	if _, err := client.call("RPUSH", queuePrefix+topic, string(text)); err != nil {
		return false, err
	}
	return true, nil
}

// queueLaterSeq keeps sorted-set members apart: a set holds a member once,
// so two identical payloads would collapse into one. The nonce is stripped
// when the member is promoted.
var queueLaterSeq int64

// QueueLater parks a message until its due moment. The wire is the Node
// runtime one (B25): the member waits in "arcod:q:<topic>:later" scored by
// the moment, and QueueReceive promotes what is due.
func (io *IO) QueueLater(topic string, message any, delay time.Duration) (bool, error) {
	client := queueConnection()
	if client == nil {
		return false, ErrNoQueue
	}
	if delay < 0 {
		return false, errors.New("arcodio: QueueLater needs a non-negative delay")
	}
	text, err := json.Marshal(map[string]any{"payload": message, "attempts": 0})
	if err != nil {
		return false, err
	}
	now := time.Now()
	nonce := strconv.FormatInt(now.UnixNano(), 36) + "-" + strconv.FormatInt(atomic.AddInt64(&queueLaterSeq, 1), 36)
	due := strconv.FormatInt(now.Add(delay).UnixMilli(), 10)
	if _, err := client.call("ZADD", queuePrefix+topic+":later", due, nonce+" "+string(text)); err != nil {
		return false, err
	}
	return true, nil
}

// queuePromote moves the due members of a topic into its list. ZREM is the
// claim: two replicas polling one topic race here and only the one that
// removed the member pushes it, so a delayed message is delivered once.
func queuePromote(topic string) error {
	client := queueConnection()
	reply, err := client.call("ZRANGEBYSCORE", queuePrefix+topic+":later", "-inf", strconv.FormatInt(time.Now().UnixMilli(), 10), "LIMIT", "0", "100")
	if err != nil {
		return err
	}
	items, ok := reply.([]any)
	if !ok {
		return nil
	}
	for _, item := range items {
		member, ok := item.(string)
		if !ok {
			continue
		}
		claimed, err := client.call("ZREM", queuePrefix+topic+":later", member)
		if err != nil {
			return err
		}
		if count, ok := claimed.(int64); !ok || count <= 0 {
			continue
		}
		text := member
		if index := strings.Index(member, " "); index >= 0 {
			text = member[index+1:]
		}
		if _, err := client.call("RPUSH", queuePrefix+topic, text); err != nil {
			return err
		}
	}
	return nil
}

// QueueReceive takes the oldest message of a topic. The bool says the topic
// was not empty: an idle poll is not an error, and the caller sleeps
// instead of spinning. The Node runtime drains the same key with LPOP, so
// either side can consume the other side's messages.
func (io *IO) QueueReceive(topic string) (string, bool, error) {
	client := queueConnection()
	if client == nil {
		return "", false, ErrNoQueue
	}
	if err := queuePromote(topic); err != nil {
		return "", false, err
	}
	reply, err := client.call("LPOP", queuePrefix+topic)
	if err != nil {
		return "", false, err
	}
	text, ok := reply.(string)
	if !ok {
		return "", false, nil
	}
	return text, true, nil
}

// QueueRequeue puts a failed attempt back at the head of the topic: the
// retry is the next message the loop sees, as LPUSH is in the Node runtime.
func (io *IO) QueueRequeue(topic, text string) error {
	client := queueConnection()
	if client == nil {
		return ErrNoQueue
	}
	_, err := client.call("LPUSH", queuePrefix+topic, text)
	return err
}

// QueueDead appends a message to the topic's dead letter, where
// io.queueDead reads it in both runtimes.
func (io *IO) QueueDead(topic, text string) error {
	client := queueConnection()
	if client == nil {
		return ErrNoQueue
	}
	_, err := client.call("RPUSH", queuePrefix+topic+":dead", text)
	return err
}
