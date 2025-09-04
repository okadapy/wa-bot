package campaign

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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
	checkInterval    = 5 * time.Second
)

type Scheduler struct {
	mu        sync.Mutex
	wg        sync.WaitGroup
	senderURL string
	workers   map[*Campaign]*Worker
	logger    *log.Logger
}

type SendMessageRequest struct {
	CampaignID  int    `json:"campaign_id"`
	PhoneNumber string `json:"phoneNumber"`
	MsgText     string `json:"msgText"`
}

type SendMessageRequestPausingState struct {
	SendMessageRequest
	Pausing bool `json:"pausing"`
}

type Worker struct {
	mu        sync.Mutex
	lastSent  time.Time
	currentID int
	cooldown  time.Duration
	startedAt time.Time
	sentCount int
	campaign  *Campaign
	senderURL string
	stopChan  chan struct{}
	logger    *log.Logger
}

func NewScheduler(logger *log.Logger) *Scheduler {
	if logger == nil {
		logger = log.Default()
	}
	return &Scheduler{
		senderURL: defaultSenderURL,
		workers:   make(map[*Campaign]*Worker),
		logger:    logger,
	}
}

// Start begins processing a campaign - takes a pointer to ensure we modify the original
func (s *Scheduler) Start(c *Campaign) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if this campaign is already being processed
	if _, exists := s.workers[c]; exists {
		s.logger.Printf("WARN: Campaign %d is already being processed", c.ID)
		return
	}

	worker := NewWorker(c, s.senderURL, s.logger)
	s.workers[c] = worker

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.logger.Printf("INFO: Starting worker for campaign %d", c.ID)
		worker.Run()

		// Clean up when worker finishes
		s.mu.Lock()
		delete(s.workers, c)
		s.mu.Unlock()
		s.logger.Printf("INFO: Worker for campaign %d completed", c.ID)
	}()
}

// Stop halts processing for a specific campaign
func (s *Scheduler) Stop(c *Campaign) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if worker, exists := s.workers[c]; exists {
		s.logger.Printf("INFO: Stopping worker for campaign %d", c.ID)
		worker.Stop()
		delete(s.workers, c)
	} else {
		s.logger.Printf("WARN: Attempted to stop non-existent worker for campaign %d", c.ID)
	}
}

// Wait for all campaigns to complete processing
func (s *Scheduler) Wait() {
	s.wg.Wait()
}

func NewWorker(c *Campaign, senderURL string, logger *log.Logger) *Worker {
	return &Worker{
		currentID: 0,
		lastSent:  time.Now(),
		cooldown:  minCooldown,
		startedAt: time.Now(),
		sentCount: 0,
		campaign:  c,
		senderURL: senderURL,
		stopChan:  make(chan struct{}),
		logger:    logger,
	}
}

func (w *Worker) Run() {
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	w.logger.Printf("INFO: Starting processing for campaign %d (%d clients)", w.campaign.ID, len(w.campaign.Clients))

	for {
		select {
		case <-w.stopChan:
			w.logger.Printf("INFO: Received stop signal for campaign %d", w.campaign.ID)
			return
		case <-ticker.C:
			w.processBatch()

			// Check if we've processed all clients
			if w.currentID >= len(w.campaign.Clients) {
				w.logger.Printf("INFO: Campaign %d completed. Total messages sent: %d", w.campaign.ID, w.sentCount)
				w.mu.Lock()
				w.campaign.Status = COMPLETED
				w.mu.Unlock()
				w.stopChan <- struct{}{}
				return
			}
		}
	}
}

func (w *Worker) Stop() {
	close(w.stopChan)
}

func (w *Worker) hasReachedMaxCount() bool {
	if w.campaign.MaxMsg == 0 {
		return false
	}
	return w.campaign.Sent-w.campaign.MaxMsg == 0
}

func (w *Worker) processBatch() {
	campaign, err := json.Marshal(w.campaign)
	if err == nil {
		w.logger.Printf("DEBUG: %s\n", campaign)
	}
	if !w.isWithinAllowedTime() {
		w.logger.Printf("DEBUG: Outside allowed time window for campaign %d", w.campaign.ID)
		return
	}

	if w.shouldResetDailyCount() {
		w.logger.Printf("INFO: Resetting daily count for campaign %d", w.campaign.ID)
		w.resetDailyCount()
	}

	if w.hasReachedDailyLimit() {
		w.logger.Printf("DEBUG: Daily limit reached for campaign %d", w.campaign.ID)
		return
	}

	if w.hasReachedMaxCount() {
		w.logger.Printf("DEBUG: Max count reached for campaign %d", w.campaign.ID)
		return
	}

	if time.Since(w.lastSent) < w.cooldown {
		return
	}

	if !w.isCampaignActive() {
		w.logger.Printf("DEBUG: Campaign %d is not active", w.campaign.ID)
		return
	}

	if err := w.sendMessage(); err != nil {
		w.logger.Printf("ERROR: Failed to send message for campaign %d: %v", w.campaign.ID, err.Error())
		w.setRandomCooldown()
		return
	}

	w.mu.Lock()
	w.campaign.Sent++
	w.sentCount++
	w.currentID++
	w.lastSent = time.Now()
	w.mu.Unlock()
	w.setRandomCooldown()
	w.logger.Printf("INFO: Sent message %d/%d for campaign %d", w.currentID, len(w.campaign.Clients), w.campaign.ID)
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

	maxAllowed := w.campaign.MaxDaily
	if maxAllowed > 100 {
		maxAllowed = 100
	}

	if maxAllowed < 25 {
		maxAllowed = 25
	}

	return w.sentCount >= maxAllowed
}

func (w *Worker) sendMessage() error {
	w.mu.Lock()
	if w.currentID >= len(w.campaign.Clients) {
		w.mu.Unlock()
		return fmt.Errorf("currentID %d exceeds client list length %d", w.currentID, len(w.campaign.Clients))
	}

	client := w.campaign.Clients[w.currentID]
	msgText := strings.Replace(w.campaign.MsgText, "((клиент))", client.Name, -1)
	w.mu.Unlock()

	smrq := SendMessageRequestPausingState{
		SendMessageRequest: SendMessageRequest{
			CampaignID:  w.campaign.ID,
			PhoneNumber: client.PhoneNumber,
			MsgText:     msgText,
		},
		Pausing: w.hasReachedDailyLimit(),
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

	resp_body, err := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("unexpected status code: %d, message: %s", resp.StatusCode, resp_body)
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
