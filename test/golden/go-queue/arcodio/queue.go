// Code generated from the .arc model by arcod. DO NOT EDIT.
//
// The publish half of the queue: a body calls io.QueuePublish(topic,
// message) and the message lands where the Node runtime consumer
// already listens. The consumer side is a job operation, which the Go
// kit does not carry yet, so publishing is the whole of the queue here.
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
