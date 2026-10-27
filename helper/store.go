package main

// The shared file every Chrome profile's Leeway reads and writes through this
// helper. Chrome starts a new helper process for each message, so the file is
// the only shared state: it is locked while read-modify-written and replaced
// in one rename, so two profiles writing at once can't lose each other's
// entry or leave a half-written file.
//
// The helper never sees cookies, tokens or page text: each profile sends only
// its already-normalized usage snapshots (remaining percent, reset time, plan).
// It stores them as given, within size limits; the extension checks every
// value again when it reads another profile's entry.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	stateFileName   = "profiles.json"
	lockFileName    = "profiles.lock"
	maxProfiles     = 8
	maxLabelRunes   = 24
	maxSnapshotsLen = 16 * 1024
	profileTTL      = 7 * 24 * time.Hour
	lockStale       = 10 * time.Second
	lockAttempts    = 100
	lockWait        = 20 * time.Millisecond
)

var profileIDPattern = regexp.MustCompile(`^[a-f0-9]{16,32}$`)

type Profile struct {
	ID        string          `json:"id"`
	Label     string          `json:"label"`
	UpdatedAt string          `json:"updated_at"`
	Snapshots json.RawMessage `json:"snapshots"`
}

type State struct {
	V        int       `json:"v"`
	Profiles []Profile `json:"profiles"`
}

type Store struct {
	Dir string
	Now func() time.Time
}

func (s Store) statePath() string { return filepath.Join(s.Dir, stateFileName) }
func (s Store) lockPath() string  { return filepath.Join(s.Dir, lockFileName) }

// cleanLabel keeps a short, printable name for the profile ("업무용").
func cleanLabel(label string) string {
	label = strings.TrimSpace(label)
	var b strings.Builder
	count := 0
	for _, r := range label {
		if unicode.IsControl(r) || r == utf8.RuneError {
			continue
		}
		if count == maxLabelRunes {
			break
		}
		b.WriteRune(r)
		count++
	}
	if b.Len() == 0 {
		return "Chrome"
	}
	return b.String()
}

// checkSnapshots accepts a JSON array up to maxSnapshotsLen bytes, compacted.
func checkSnapshots(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return json.RawMessage("[]"), nil
	}
	if len(raw) > maxSnapshotsLen {
		return nil, fmt.Errorf("snapshots too large (%d bytes, limit %d)", len(raw), maxSnapshotsLen)
	}
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, errors.New("snapshots must be a JSON array")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, errors.New("snapshots are not valid JSON")
	}
	return json.RawMessage(compact.Bytes()), nil
}

func (s Store) lock() (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	for i := 0; i < lockAttempts; i++ {
		f, err := os.OpenFile(s.lockPath(), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.Close()
			return func() { os.Remove(s.lockPath()) }, nil
		}
		// A lock left by a helper that died mid-write.
		if info, statErr := os.Stat(s.lockPath()); statErr == nil && s.Now().Sub(info.ModTime()) > lockStale {
			os.Remove(s.lockPath())
			continue
		}
		time.Sleep(lockWait)
	}
	return nil, errors.New("shared file is busy")
}

// read returns the stored state; a missing or unreadable file is empty.
func (s Store) read() State {
	data, err := os.ReadFile(s.statePath())
	if err != nil {
		return State{V: 1}
	}
	var st State
	if json.Unmarshal(data, &st) != nil {
		return State{V: 1}
	}
	st.V = 1
	return st
}

func (s Store) write(st State) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.Dir, "profiles-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	// On Windows a rename over a file another process has open fails for a
	// moment (readers take the lock too, but a virus scanner may not); retry.
	for i := 0; ; i++ {
		err = os.Rename(tmpName, s.statePath())
		if err == nil || i == 9 {
			break
		}
		time.Sleep(lockWait)
	}
	if err != nil {
		os.Remove(tmpName)
	}
	return err
}

// prune drops entries nobody has refreshed for profileTTL, then keeps the
// maxProfiles most recent.
func (s Store) prune(profiles []Profile) []Profile {
	now := s.Now()
	kept := profiles[:0]
	for _, p := range profiles {
		at, err := time.Parse(time.RFC3339, p.UpdatedAt)
		if err != nil || now.Sub(at) > profileTTL || !profileIDPattern.MatchString(p.ID) {
			continue
		}
		kept = append(kept, p)
	}
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].UpdatedAt > kept[j].UpdatedAt })
	if len(kept) > maxProfiles {
		kept = kept[:maxProfiles]
	}
	return kept
}

// Put stores one profile's entry (replacing its earlier one) and returns all.
func (s Store) Put(id, label string, snapshots json.RawMessage) ([]Profile, error) {
	if !profileIDPattern.MatchString(id) {
		return nil, errors.New("bad profile_id")
	}
	clean, err := checkSnapshots(snapshots)
	if err != nil {
		return nil, err
	}
	unlock, err := s.lock()
	if err != nil {
		return nil, err
	}
	defer unlock()
	st := s.read()
	others := st.Profiles[:0]
	for _, p := range st.Profiles {
		if p.ID != id {
			others = append(others, p)
		}
	}
	entry := Profile{ID: id, Label: cleanLabel(label), UpdatedAt: s.Now().UTC().Format(time.RFC3339), Snapshots: clean}
	st.Profiles = s.prune(append([]Profile{entry}, others...))
	if err := s.write(st); err != nil {
		return nil, err
	}
	return st.Profiles, nil
}

// Remove takes a profile's entry out (it turned the feature off).
func (s Store) Remove(id string) ([]Profile, error) {
	if !profileIDPattern.MatchString(id) {
		return nil, errors.New("bad profile_id")
	}
	unlock, err := s.lock()
	if err != nil {
		return nil, err
	}
	defer unlock()
	st := s.read()
	kept := st.Profiles[:0]
	for _, p := range st.Profiles {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	st.Profiles = s.prune(kept)
	if err := s.write(st); err != nil {
		return nil, err
	}
	return st.Profiles, nil
}

// Get returns every live entry without writing. It takes the lock so it
// never holds the file open while a writer replaces it.
func (s Store) Get() []Profile {
	if unlock, err := s.lock(); err == nil {
		defer unlock()
	}
	st := s.read()
	return s.prune(st.Profiles)
}
