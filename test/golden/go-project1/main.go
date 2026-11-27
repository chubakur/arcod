// Code generated from main.arc by arcod. DO NOT EDIT.
//
// The routes and the input table come from the contract IR; the bodies
// live in ops.go, one function per operation.
package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"

	arcodio "arcod/onetimemessage/arcodio"
)

// OpError is an error the contract declares by name.
type OpError struct {
	Name    string
	Status  int
	Message string
}

func (e *OpError) Error() string { return e.Name }

var (
	ErrGone = &OpError{Name: "Gone", Status: 410, Message: "already consumed"}
	ErrInvalid = &OpError{Name: "Invalid", Status: 400, Message: "invalid request"}
	ErrNotFound = &OpError{Name: "NotFound", Status: 404, Message: "not found"}
)

var arc = arcodio.Connect()

func main() {
	mux := http.NewServeMux()
	// A probe is a read: POST /healthz stays a 404, as in the Node runtime.
	mux.HandleFunc("GET /healthz", health)
	mux.HandleFunc("POST /v1/api/messages", handleCreate)
	mux.HandleFunc("GET /v1/api/messages/{id}", handleRead)
	log.Printf("arcod go service %s listening on %s", "OneTimeMessage", addr())
	log.Fatal(http.ListenAndServe(addr(), mux))
}

func addr() string {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	return ":" + port
}

func health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "OneTimeMessage"})
}

func handleCreate(w http.ResponseWriter, r *http.Request) {
	in, err := input(r, nil, []string{"author", "body"})
	if err != nil {
		fail(w, err)
		return
	}
	out, err := opCreate(arc, in)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, 201, out)
}

func handleRead(w http.ResponseWriter, r *http.Request) {
	in, err := input(r, nil, []string{"id"})
	if err != nil {
		fail(w, err)
		return
	}
	out, err := opRead(arc, in)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, 200, out)
}

// input reads the path captures, the query string and the JSON body into
// one map, then coerces the scalars a URL carries as text.
func input(r *http.Request, kinds map[string]string, required []string) (map[string]any, error) {
	in := map[string]any{}
	for _, name := range required {
		if value := r.PathValue(name); value != "" {
			in[name] = value
		}
		if values, ok := r.URL.Query()[name]; ok && len(values) > 0 {
			in[name] = values[len(values)-1]
		}
	}
	if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			return nil, &OpError{Name: "Invalid", Status: 400, Message: "invalid JSON body"}
		}
		for name, value := range body {
			if _, taken := in[name]; !taken {
				in[name] = value
			}
		}
	}
	if err := coerce(in, kinds); err != nil {
		return nil, err
	}
	for _, name := range required {
		if _, ok := in[name]; !ok {
			return nil, &OpError{Name: "Invalid", Status: 400, Message: "missing parameter " + name}
		}
	}
	return in, nil
}

func coerce(in map[string]any, kinds map[string]string) error {
	for name, kind := range kinds {
		raw, ok := in[name]
		if !ok {
			continue
		}
		switch kind {
		case "int":
			switch value := raw.(type) {
			case float64:
				in[name] = int64(value)
			case string:
				parsed, err := strconv.ParseInt(value, 10, 64)
				if err != nil {
					return &OpError{Name: "Invalid", Status: 400, Message: name + " must be an int"}
				}
				in[name] = parsed
			}
		case "number", "decimal", "float":
			switch value := raw.(type) {
			case string:
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil {
					return &OpError{Name: "Invalid", Status: 400, Message: name + " must be a number"}
				}
				in[name] = parsed
			}
		case "bool":
			switch value := raw.(type) {
			case string:
				parsed, err := strconv.ParseBool(value)
				if err != nil {
					return &OpError{Name: "Invalid", Status: 400, Message: name + " must be a bool"}
				}
				in[name] = parsed
			}
		}
	}
	return nil
}

// fail answers a declared error by its status and name; anything else is
// Internal, exactly as the Node runtime treats an undeclared error.
func fail(w http.ResponseWriter, err error) {
	var declared *OpError
	if errors.As(err, &declared) {
		writeJSON(w, declared.Status, map[string]any{"error": declared.Name, "message": declared.Message})
		return
	}
	log.Printf("internal error: %v", err)
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if body == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("write response: %v", err)
	}
}
