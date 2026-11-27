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
	"strings"
	"sync"
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

// QueueReceive takes the oldest message of a topic. The bool says the topic
// was not empty: an idle poll is not an error, and the caller sleeps
// instead of spinning. The Node runtime drains the same key with LPOP, so
// either side can consume the other side's messages.
func (io *IO) QueueReceive(topic string) (string, bool, error) {
	client := queueConnection()
	if client == nil {
		return "", false, ErrNoQueue
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
