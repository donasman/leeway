package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testStore(t *testing.T) (Store, *time.Time) {
	t.Helper()
	now := time.Date(2026, 10, 27, 3, 0, 0, 0, time.UTC)
	return Store{Dir: t.TempDir(), Now: func() time.Time { return now }}, &now
}

const idA = "0123456789abcdef"
const idB = "fedcba9876543210"

func TestPutGetRemove(t *testing.T) {
	s, _ := testStore(t)
	if _, err := s.Put(idA, "업무용", json.RawMessage(`[{"provider":"claude"}]`)); err != nil {
		t.Fatal(err)
	}
	got, err := s.Put(idB, "개인", json.RawMessage(`[]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 profiles, got %d", len(got))
	}
	if len(s.Get()) != 2 {
		t.Fatal("get should see both")
	}
	// Putting again replaces, never duplicates.
	s.Put(idA, "업무용", json.RawMessage(`[]`))
	if len(s.Get()) != 2 {
		t.Fatal("a second put must replace the entry")
	}
	left, err := s.Remove(idA)
	if err != nil || len(left) != 1 || left[0].ID != idB {
		t.Fatalf("remove: %v %+v", err, left)
	}
}

func TestValidation(t *testing.T) {
	s, _ := testStore(t)
	if _, err := s.Put("not-an-id", "x", nil); err == nil {
		t.Fatal("bad id accepted")
	}
	if _, err := s.Put(idA, "x", json.RawMessage(`{"not":"array"}`)); err == nil {
		t.Fatal("non-array snapshots accepted")
	}
	big := `["` + strings.Repeat("a", maxSnapshotsLen) + `"]`
	if _, err := s.Put(idA, "x", json.RawMessage(big)); err == nil {
		t.Fatal("oversized snapshots accepted")
	}
	got, _ := s.Put(idA, "  긴이름\x07이름이름이름이름이름이름이름이름이름이름이름이름  ", nil)
	if label := got[0].Label; strings.ContainsRune(label, 7) || len([]rune(label)) > maxLabelRunes {
		t.Fatalf("label not cleaned: %q", label)
	}
	got, _ = s.Put(idA, "   ", nil)
	if got[0].Label != "Chrome" {
		t.Fatalf("empty label → %q", got[0].Label)
	}
}

func TestPruneOldAndMax(t *testing.T) {
	s, now := testStore(t)
	s.Put(idA, "old", nil)
	*now = now.Add(profileTTL + time.Hour)
	got, _ := s.Put(idB, "new", nil)
	if len(got) != 1 || got[0].ID != idB {
		t.Fatalf("entry older than the TTL should be dropped: %+v", got)
	}
	for i := 0; i < maxProfiles+3; i++ {
		*now = now.Add(time.Minute)
		id := strings.Repeat("a", 15) + string("0123456789abcdef"[i])
		s.Put(id, "p", nil)
	}
	if n := len(s.Get()); n != maxProfiles {
		t.Fatalf("want at most %d profiles, got %d", maxProfiles, n)
	}
}

func TestConcurrentPutsKeepEveryEntry(t *testing.T) {
	s, _ := testStore(t)
	s.Now = time.Now
	var wg sync.WaitGroup
	for i := 0; i < maxProfiles; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := strings.Repeat("b", 15) + string("0123456789abcdef"[i])
			if _, err := s.Put(id, "p", nil); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if n := len(s.Get()); n != maxProfiles {
		t.Fatalf("concurrent writers lost entries: %d of %d", n, maxProfiles)
	}
	if _, err := os.Stat(filepath.Join(s.Dir, lockFileName)); !os.IsNotExist(err) {
		t.Fatal("lock file left behind")
	}
}

func TestStaleLockIsTakenOver(t *testing.T) {
	s, now := testStore(t)
	os.MkdirAll(s.Dir, 0o700)
	os.WriteFile(filepath.Join(s.Dir, lockFileName), nil, 0o600)
	old := now.Add(-time.Minute)
	os.Chtimes(filepath.Join(s.Dir, lockFileName), old, old)
	if _, err := s.Put(idA, "x", nil); err != nil {
		t.Fatalf("a stale lock should not block: %v", err)
	}
}

func TestCorruptFileReadsAsEmpty(t *testing.T) {
	s, _ := testStore(t)
	os.MkdirAll(s.Dir, 0o700)
	os.WriteFile(filepath.Join(s.Dir, stateFileName), []byte("{half"), 0o600)
	if len(s.Get()) != 0 {
		t.Fatal("corrupt file should read as empty")
	}
	if _, err := s.Put(idA, "x", nil); err != nil {
		t.Fatal(err)
	}
}

func frame(t *testing.T, v any) []byte {
	body, _ := json.Marshal(v)
	var b bytes.Buffer
	binary.Write(&b, binary.LittleEndian, uint32(len(body)))
	b.Write(body)
	return b.Bytes()
}

func TestServeProtocol(t *testing.T) {
	s, _ := testStore(t)
	in := bytes.NewBuffer(nil)
	in.Write(frame(t, map[string]any{"type": "put", "profile_id": idA, "label": "A", "snapshots": []any{}}))
	in.Write(frame(t, map[string]any{"type": "get"}))
	in.Write(frame(t, map[string]any{"type": "nope"}))
	var out bytes.Buffer
	if err := serve(in, &out, s); err != nil {
		t.Fatal(err)
	}
	var replies []response
	for out.Len() > 0 {
		var n uint32
		binary.Read(&out, binary.LittleEndian, &n)
		var r response
		json.Unmarshal(out.Next(int(n)), &r)
		replies = append(replies, r)
	}
	if len(replies) != 3 || !replies[0].OK || len(replies[1].Profiles) != 1 || replies[2].OK {
		t.Fatalf("replies: %+v", replies)
	}
}

func TestOversizedMessageRefused(t *testing.T) {
	s, _ := testStore(t)
	var in bytes.Buffer
	binary.Write(&in, binary.LittleEndian, uint32(maxMessageSize+1))
	var out bytes.Buffer
	if err := serve(&in, &out, s); err == nil {
		t.Fatal("oversized message accepted")
	}
}

func TestManifestOrigins(t *testing.T) {
	m := manifestFor(`C:\x\leeway-helper.exe`, []string{"nnknbbnoekgbalackpaekkemnjibicia", "nnknbbnoekgbalackpaekkemnjibicia", "bad"})
	if len(m.AllowedOrigins) != 1 || m.AllowedOrigins[0] != "chrome-extension://nnknbbnoekgbalackpaekkemnjibicia/" {
		t.Fatalf("origins: %v", m.AllowedOrigins)
	}
	if _, err := extensionIDs([]string{"install", "--extension-id", "BAD"}); err == nil {
		t.Fatal("bad --extension-id accepted")
	}
	ids, _ := extensionIDs([]string{"install", "--extension-id", "afbogabboncojngbpakppghnjmbmhpph"})
	if len(ids) != len(defaultExtensionIDs)+1 {
		t.Fatalf("ids: %v", ids)
	}
}

func TestLaunchedByChrome(t *testing.T) {
	if !launchedByChrome([]string{"chrome-extension://abc/", "--parent-window=0"}) || launchedByChrome([]string{"install"}) {
		t.Fatal("launch detection")
	}
}
