package main

import (
    "errors"
    "fmt"
    "log"
    "log/slog"
)

func validate(value string) error {
    log.Printf("ordinary output %s", value)
    slog.Warn("Discarded invalid record", "value", value)
    if value == "" { return errors.New("Cannot decode empty record") }
    return fmt.Errorf("Unsupported record %s: invalid type", value)
}
