//go:build !linux

package main

import "errors"

func diskPercent(string) (float64, error) { return 0, errors.New("disk metrics require Linux") }
