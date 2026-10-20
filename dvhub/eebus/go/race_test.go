package main

import (
	"fmt"
	"sync"
	"testing"
)

// Codex-Review 20.10.: syncRemotes las die neue Entitäten-Map nach dem Entsperren weiter,
// während dropSki (Verbindungsabbau, eigene Goroutine von spine-go) sie unter dem Mutex
// änderte → gleichzeitiger Map-Zugriff. Mit -race prüfen.
func TestApplyRemotesConcurrentWithDropSki(t *testing.T) {
	tb := newTestBridge(t, "race1")
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			cur := map[string]remoteEntry{}
			for j := 0; j < 20; j++ {
				cur[fmt.Sprintf("k%d-%d", i, j)] = remoteEntry{ski: "abc"}
			}
			tb.b.applyRemotes(tagEgLPC, cur)
		}(i)
		go func() {
			defer wg.Done()
			tb.b.dropSki("abc")
		}()
	}
	wg.Wait()
}
