package campaign

import (
	"bytes"
	"context"
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
	defaultSenderURL   = "http://app:3000/wh/send"
	minCooldown        = 30 * time.Second
	maxCooldown        = 160 * time.Second
	allowedStartHour   = 10
	allowedEndHour     = 21
	dailyResetPeriod   = 24 * time.Hour
	checkInterval      = 5 * time.Second
	minDailyMessages   = 25
	maxDailyMessages   = 100
	successStatusRange = 200
	conflictStatus     = 409
)

type Scheduler struct {
	mu        sync.RWMutex
	wg        sync.WaitGroup
	senderURL string
	workers   map[int]*Worker // Use campaign ID as key for easier lookup
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
	ctx       context.Context
	cancel    context.CancelFunc
	logger    *log.Logger
}

type SendingError struct {
	Success string `json:"success"`
	Message string `json:"message"`
	Retries uint   `json:"retries"`
}

func (s SendingError) Error() string {
	return fmt.Sprintf("sending error (success: %s, retries: %d): %s",
		s.Success, s.Retries, s.Message)
}

func NewScheduler(logger *log.Logger) *Scheduler {
	if logger == nil {
		logger = log.Default()
	}
	return &Scheduler{
		senderURL: defaultSenderURL,
		workers:   make(map[int]*Worker),
		logger:    logger,
	}
}

// Start begins processing a campaign
func (s *Scheduler) Start(c *Campaign) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.workers[c.ID]; exists {
		s.logger.Printf("warn: campaign %d is already being processed", c.ID)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	worker := &Worker{
		currentID: 0,
		lastSent:  time.Now(),
		cooldown:  minCooldown,
		startedAt: time.Now(),
		sentCount: 0,
		campaign:  c,
		senderURL: s.senderURL,
		ctx:       ctx,
		cancel:    cancel,
		logger:    s.logger,
	}

	s.workers[c.ID] = worker
	s.wg.Add(1)

	go func() {
		defer s.wg.Done()
		defer s.cleanupWorker(c.ID)

		s.logger.Printf("info: starting worker for campaign %d", c.ID)
		worker.Run()
		s.logger.Printf("info: worker for campaign %d completed", c.ID)
	}()
}

// Stop halts processing for a specific campaign
func (s *Scheduler) Stop(campaignID int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if worker, exists := s.workers[campaignID]; exists {
		s.logger.Printf("info: stopping worker for campaign %d", campaignID)
		worker.Stop()
	} else {
		s.logger.Printf("warn: attempted to stop non-existent worker for campaign %d", campaignID)
	}
}

// Wait for all campaigns to complete processing
func (s *Scheduler) Wait() {
	s.wg.Wait()
}

func (s *Scheduler) cleanupWorker(campaignID int) {
	s.mu.Lock()
	delete(s.workers, campaignID)
	s.mu.Unlock()
}

func (w *Worker) Run() {
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	w.logger.Printf("info: starting processing for campaign %d (%d clients)",
		w.campaign.ID, len(w.campaign.Clients))

	for {
		select {
		case <-w.ctx.Done():
			return
		case <-ticker.C:
			w.processBatch()

			if w.isCompleted() {
				w.logger.Printf("info: campaign %d completed. total messages sent: %d",
					w.campaign.ID, w.sentCount)
				w.setCampaignStatus(COMPLETED)
				return
			}
		}
	}
}

func (w *Worker) Stop() {
	w.cancel()
}

func (w *Worker) processBatch() {
	if !w.isWithinAllowedTime() {
		return
	}

	w.checkDailyReset()

	if w.hasReachedLimits() {
		return
	}

	if time.Since(w.lastSent) < w.cooldown {
		return
	}

	if !w.isCampaignActive() {
		return
	}

	if err := w.sendMessage(); err != nil {
		w.logger.Printf("error: failed to send message for campaign %d: %v", w.campaign.ID, err)
		w.setRandomCooldown()
		return
	}

	w.incrementCounters()
	w.setRandomCooldown()

	w.logger.Printf("info: sent message %d/%d for campaign %d",
		w.currentID, len(w.campaign.Clients), w.campaign.ID)
}

func (w *Worker) isCompleted() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.currentID >= len(w.campaign.Clients)
}

func (w *Worker) setCampaignStatus(status Status) {
	w.mu.Lock()
	w.campaign.Status = status
	w.mu.Unlock()
}

func (w *Worker) checkDailyReset() {
	w.mu.Lock()
	defer w.mu.Unlock()

	if time.Since(w.startedAt) >= dailyResetPeriod {
		w.logger.Printf("info: resetting daily count for campaign %d", w.campaign.ID)
		w.sentCount = 0
		w.startedAt = time.Now()
	}
}

func (w *Worker) hasReachedLimits() bool {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Check max messages per campaign
	if w.campaign.MaxMsg > 0 && w.campaign.Sent >= w.campaign.MaxMsg {
		return true
	}

	// Check daily limit
	maxDaily := clamp(w.campaign.MaxDaily, minDailyMessages, maxDailyMessages)
	return w.sentCount >= maxDaily
}

func clamp(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func (w *Worker) isWithinAllowedTime() bool {
	now := time.Now().UTC().Add(time.Duration(w.campaign.Timezone) * time.Hour)
	hour := now.Hour()
	return hour >= allowedStartHour && hour < allowedEndHour
}

func (w *Worker) sendMessage() error {
	w.mu.Lock()
	if w.currentID >= len(w.campaign.Clients) {
		w.mu.Unlock()
		return fmt.Errorf("current id %d exceeds client list length %d",
			w.currentID, len(w.campaign.Clients))
	}

	client := w.campaign.Clients[w.currentID]
	msgText := strings.ReplaceAll(w.campaign.MsgText, "((клиент))", client.Name)
	w.mu.Unlock()

	request := SendMessageRequestPausingState{
		SendMessageRequest: SendMessageRequest{
			CampaignID:  w.campaign.ID,
			PhoneNumber: client.PhoneNumber,
			MsgText:     msgText,
		},
		Pausing: w.hasReachedLimits(),
	}

	body, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("marshal failed: %w", err)
	}

	resp, err := http.Post(w.senderURL, "application/json", bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("http request failed: %w", err)
	}
	defer resp.Body.Close()

	return w.handleResponse(resp)
}

func (w *Worker) handleResponse(resp *http.Response) error {
	if resp.StatusCode >= successStatusRange && resp.StatusCode < successStatusRange+100 {
		return nil
	}

	if resp.StatusCode == conflictStatus {
		return w.decodeSendingError(resp)
	}

	body, _ := io.ReadAll(resp.Body)
	return fmt.Errorf("message sending failed. code: %d, reason: %s",
		resp.StatusCode, string(body))
}

func (w *Worker) decodeSendingError(resp *http.Response) error {
	var sendingError SendingError
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response body: %w", err)
	}

	if err := json.Unmarshal(body, &sendingError); err != nil {
		return fmt.Errorf("failed to unmarshal error response: %w", err)
	}

	return sendingError
}

func (w *Worker) incrementCounters() {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.campaign.Sent++
	w.sentCount++
	w.currentID++
	w.lastSent = time.Now()
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
