package campaign

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	defaultSenderURL = "http://app:3000/wh/send"
	minCooldown      = 30 * time.Second
	maxCooldown      = 160 * time.Second
	allowedStartHour = 10
	allowedEndHour   = 21
	dailyResetPeriod = 24 * time.Hour
	checkInterval    = 1 * time.Minute
)

type Scheduler struct {
	mu        sync.Mutex
	wg        sync.WaitGroup
	senderURL string
	workers   map[*Campaign]*Worker // Track workers by campaign reference
}

type SendMessageRequest struct {
	PhoneNumber string `json:"phoneNumber"`
	MsgText     string `json:"msgText"`
}

type Worker struct {
	mu        sync.Mutex
	lastSent  time.Time
	currentID int
	cooldown  time.Duration
	startedAt time.Time
	sentCount int
	campaign  *Campaign // Reference to the original campaign
	senderURL string
	stopChan  chan struct{}
}

func NewScheduler() *Scheduler {
	return &Scheduler{
		senderURL: defaultSenderURL,
		workers:   make(map[*Campaign]*Worker),
	}
}

// Start begins processing a campaign - takes a pointer to ensure we modify the original
func (s *Scheduler) Start(c *Campaign) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if this campaign is already being processed
	if _, exists := s.workers[c]; exists {
		log.Printf("Campaign is already being processed")
		return
	}

	worker := NewWorker(c, s.senderURL)
	s.workers[c] = worker

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		worker.Run()

		// Clean up when worker finishes
		s.mu.Lock()
		delete(s.workers, c)
		s.mu.Unlock()
	}()
}

// Stop halts processing for a specific campaign
func (s *Scheduler) Stop(c *Campaign) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if worker, exists := s.workers[c]; exists {
		worker.Stop()
		delete(s.workers, c)
	}
}

// Wait for all campaigns to complete processing
func (s *Scheduler) Wait() {
	s.wg.Wait()
}

func NewWorker(c *Campaign, senderURL string) *Worker {
	return &Worker{
		currentID: 0,
		lastSent:  time.Now(),
		cooldown:  minCooldown,
		startedAt: time.Now(),
		sentCount: 0,
		campaign:  c, // Store reference to original campaign
		senderURL: senderURL,
		stopChan:  make(chan struct{}),
	}
}

func (w *Worker) Run() {
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-w.stopChan:
			return
		case <-ticker.C:
			w.processBatch()

			// Check if we've processed all clients
			if w.currentID >= len(w.campaign.Clients) {
				return
			}
		}
	}
}

func (w *Worker) Stop() {
	close(w.stopChan)
}

func (w *Worker) processBatch() {
	if !w.isWithinAllowedTime() {
		return
	}

	if w.shouldResetDailyCount() {
		w.resetDailyCount()
	}

	if w.hasReachedDailyLimit() {
		return
	}

	if time.Since(w.lastSent) < w.cooldown {
		return
	}

	if !w.isCampaignActive() {
		return
	}

	if err := w.sendMessage(); err != nil {
		log.Printf("Failed to send message: %v", err)
		w.setRandomCooldown()
		return
	}

	// Update the original campaign's Sent count
	w.mu.Lock()
	w.campaign.Sent++ // This modifies the original campaign
	w.sentCount++
	w.currentID++
	w.setRandomCooldown()
	w.lastSent = time.Now()
	w.mu.Unlock()
}

func (w *Worker) isWithinAllowedTime() bool {
	now := time.Now().UTC().Add(time.Duration(w.campaign.Timezone) * time.Hour)
	hour := now.Hour()
	return hour >= allowedStartHour && hour < allowedEndHour
}

func (w *Worker) shouldResetDailyCount() bool {
	return time.Since(w.startedAt) >= dailyResetPeriod
}

func (w *Worker) resetDailyCount() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.sentCount = 0
	w.startedAt = time.Now()
}

func (w *Worker) hasReachedDailyLimit() bool {
	w.mu.Lock()
	defer w.mu.Unlock()

	maxAllowed := w.campaign.MaxMsg
	if maxAllowed > 100 {
		maxAllowed = 100
	}
	return w.sentCount >= maxAllowed
}

func (w *Worker) sendMessage() error {
	w.mu.Lock()
	if w.currentID >= len(w.campaign.Clients) {
		w.mu.Unlock()
		return fmt.Errorf("currentID exceeds client list length")
	}

	client := w.campaign.Clients[w.currentID]
	msgText := strings.Replace(w.campaign.MsgText, "((клиент))", client.Name, -1)
	w.mu.Unlock()

	smrq := SendMessageRequest{
		PhoneNumber: client.PhoneNumber,
		MsgText:     msgText,
	}

	body, err := json.Marshal(smrq)
	if err != nil {
		return fmt.Errorf("marshal failed: %w", err)
	}

	resp, err := http.Post(w.senderURL, "application/json", bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	return nil
}

func (w *Worker) setRandomCooldown() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.cooldown = time.Duration(rand.Intn(int(maxCooldown-minCooldown))) + minCooldown
}

func (w *Worker) isCampaignActive() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.campaign.Status == ACTIVE
}
