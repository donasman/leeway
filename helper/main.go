// Leeway helper: lets Leeway in several Chrome profiles show each other's
// remaining usage. Chrome starts it through Native Messaging; run on its own
// (double-click) it registers itself for the current Windows user.
//
//	leeway-helper.exe                 register (same as "install")
//	leeway-helper.exe install [--extension-id ID]...
//	leeway-helper.exe uninstall
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	hostName       = "com.leeway.helper"
	version        = "0.1.0"
	maxMessageSize = 64 * 1024
)

// Extensions allowed to talk to the helper. The unpacked development build
// (its manifest "key") is listed; the Chrome Web Store ID is added at release.
var defaultExtensionIDs = []string{
	"nnknbbnoekgbalackpaekkemnjibicia", // development key
}

type request struct {
	Type      string          `json:"type"`
	ProfileID string          `json:"profile_id"`
	Label     string          `json:"label"`
	Snapshots json.RawMessage `json:"snapshots"`
}

type response struct {
	OK       bool      `json:"ok"`
	Version  string    `json:"version"`
	Error    string    `json:"error,omitempty"`
	Profiles []Profile `json:"profiles"`
}

func dataDir() string {
	if dir := os.Getenv("LEEWAY_HELPER_DIR"); dir != "" {
		return dir
	}
	if base := os.Getenv("LOCALAPPDATA"); base != "" {
		return filepath.Join(base, "Leeway")
	}
	if base, err := os.UserCacheDir(); err == nil {
		return filepath.Join(base, "Leeway")
	}
	return "Leeway"
}

func readMessage(r io.Reader) ([]byte, error) {
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return nil, err
	}
	if size > maxMessageSize {
		return nil, fmt.Errorf("message too large (%d bytes)", size)
	}
	body := make([]byte, size)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return body, nil
}

func writeMessage(w io.Writer, v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(len(body))); err != nil {
		return err
	}
	_, err = w.Write(body)
	return err
}

func handle(store Store, body []byte) response {
	var req request
	if err := json.Unmarshal(body, &req); err != nil {
		return response{OK: false, Version: version, Error: "bad request", Profiles: []Profile{}}
	}
	var profiles []Profile
	var err error
	switch req.Type {
	case "put":
		profiles, err = store.Put(req.ProfileID, req.Label, req.Snapshots)
	case "remove":
		profiles, err = store.Remove(req.ProfileID)
	case "get", "hello":
		profiles = store.Get()
	default:
		err = errors.New("unknown type")
	}
	if err != nil {
		return response{OK: false, Version: version, Error: err.Error(), Profiles: []Profile{}}
	}
	if profiles == nil {
		profiles = []Profile{}
	}
	return response{OK: true, Version: version, Profiles: profiles}
}

// serve answers messages until Chrome closes stdin.
func serve(in io.Reader, out io.Writer, store Store) error {
	reader := bufio.NewReader(in)
	for {
		body, err := readMessage(reader)
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil
		}
		if err != nil {
			writeMessage(out, response{OK: false, Version: version, Error: err.Error(), Profiles: []Profile{}})
			return err
		}
		if err := writeMessage(out, handle(store, body)); err != nil {
			return err
		}
	}
}

// launchedByChrome: Chrome passes the caller origin ("chrome-extension://<id>/")
// as an argument.
func launchedByChrome(args []string) bool {
	for _, a := range args {
		if strings.HasPrefix(a, "chrome-extension://") {
			return true
		}
	}
	return false
}

func extensionIDs(args []string) ([]string, error) {
	ids := append([]string{}, defaultExtensionIDs...)
	for i := 0; i < len(args); i++ {
		if args[i] != "--extension-id" {
			continue
		}
		if i+1 >= len(args) || !extensionIDPattern.MatchString(args[i+1]) {
			return nil, errors.New("--extension-id needs a 32-letter extension ID (a-p)")
		}
		ids = append(ids, args[i+1])
		i++
	}
	return ids, nil
}

func pause() {
	fmt.Print("\nPress Enter to close.")
	bufio.NewReader(os.Stdin).ReadString('\n')
}

func main() {
	args := os.Args[1:]
	if launchedByChrome(args) {
		if err := serve(os.Stdin, os.Stdout, Store{Dir: dataDir(), Now: time.Now}); err != nil {
			os.Exit(1)
		}
		return
	}
	interactive := len(args) == 0
	command := "install"
	if len(args) > 0 {
		command = args[0]
	}
	var err error
	switch command {
	case "install":
		var ids []string
		if ids, err = extensionIDs(args); err == nil {
			err = install(ids)
		}
	case "uninstall":
		err = uninstall()
	case "version", "--version":
		fmt.Println("leeway-helper", version)
	default:
		err = fmt.Errorf("unknown command %q (install, uninstall)", command)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
	}
	if interactive && runtime.GOOS == "windows" {
		pause()
	}
	if err != nil {
		os.Exit(1)
	}
}
