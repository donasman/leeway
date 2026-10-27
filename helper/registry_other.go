//go:build !windows

package main

import "errors"

// systemRegistry off Windows: Chrome there finds hosts through manifest files,
// not the registry, so every registry check fails with this.
type systemRegistry struct{}

var errNoRegistry = errors.New("the registry exists only on Windows")

func (systemRegistry) String(root, path, name string) (string, error) { return "", errNoRegistry }
func (systemRegistry) DWORD(root, path, name string) (uint32, error)  { return 0, errNoRegistry }
