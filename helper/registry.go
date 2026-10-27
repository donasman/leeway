package main

import "errors"

// registry reads the values "check" looks at. The Windows build reads the
// real registry (registry_windows.go); tests use a map, so they run anywhere.
// root is "HKCU" or "HKLM"; name "" is the key's default value.
type registry interface {
	String(root, path, name string) (string, error)
	DWORD(root, path, name string) (uint32, error)
}

// errNoValue: the key or the value does not exist.
var errNoValue = errors.New("not in the registry")
