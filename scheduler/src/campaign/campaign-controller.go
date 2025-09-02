package campaign

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"

	"github.com/gin-gonic/gin"
)

type Status int

const (
	ACTIVE Status = iota
	PAUSED
	COMPLETED
)

func (s Status) String() string {
	switch s {
	case ACTIVE:
		return "active"
	case PAUSED:
		return "paused"
	case COMPLETED:
		return "completed"
	default:
		return "unknown"
	}
}

type ClientDTO struct {
	Name        string `json:"name"`
	PhoneNumber string `json:"phone_number"`
}

type DTO struct {
	CustomerID int         `json:"customer_id"`
	Timezone   int         `json:"timezone"`
	Clients    []ClientDTO `json:"clients"`
	MaxMsg     int         `json:"max_msg"`
	MsgText    string      `json:"msg_text"`
}

type Campaign struct {
	DTO
	ID     int
	Sent   int
	Status Status
}

type Cache struct {
	sync.RWMutex
	campaigns map[int]*Campaign
	nextID    int
	scheduler *Scheduler
}

type Controller struct {
	cache *Cache
}

// NewCache creates a new campaign cache with scheduler integration
func NewCache(scheduler *Scheduler) *Cache {
	return &Cache{
		campaigns: make(map[int]*Campaign),
		nextID:    1,
		scheduler: scheduler,
	}
}

// AddCampaign adds a new campaign to the cache and starts the scheduler
func (c *Cache) AddCampaign(dto DTO) (*Campaign, error) {
	c.Lock()
	defer c.Unlock()

	if len(dto.Clients) == 0 {
		return nil, errors.New("campaign must have at least one client")
	}

	id := c.nextID
	c.nextID++

	campaign := &Campaign{
		DTO:    dto,
		ID:     id,
		Sent:   0,
		Status: ACTIVE,
	}

	c.campaigns[id] = campaign

	// Start the scheduler for this campaign
	c.scheduler.Start(campaign)

	return campaign, nil
}

// GetCampaign retrieves a campaign by ID
func (c *Cache) GetCampaign(id int) (*Campaign, error) {
	c.RLock()
	defer c.RUnlock()

	campaign, exists := c.campaigns[id]
	if !exists {
		return nil, fmt.Errorf("campaign with ID %d not found", id)
	}

	return campaign, nil
}

// UpdateCampaignStatus updates the status of a campaign
func (c *Cache) UpdateCampaignStatus(id int, status Status) error {
	c.Lock()
	defer c.Unlock()

	campaign, exists := c.campaigns[id]
	if !exists {
		return fmt.Errorf("campaign with ID %d not found", id)
	}

	// Handle scheduler based on status change
	if campaign.Status == ACTIVE && status == PAUSED {
		c.scheduler.Stop(campaign)
	} else if campaign.Status == PAUSED && status == ACTIVE {
		c.scheduler.Start(campaign)
	}

	campaign.Status = status
	return nil
}

// GetAllCampaigns returns all campaigns (for monitoring purposes)
func (c *Cache) GetAllCampaigns() []*Campaign {
	c.RLock()
	defer c.RUnlock()

	result := make([]*Campaign, 0, len(c.campaigns))
	for _, campaign := range c.campaigns {
		result = append(result, campaign)
	}

	return result
}

// NewCampaignController creates a new campaign controller
func NewCampaignController(scheduler *Scheduler) *Controller {
	return &Controller{
		cache: NewCache(scheduler),
	}
}

// CreateNewCampaign handles campaign creation
func (ctrl *Controller) CreateNewCampaign(c *gin.Context) {
	var dto DTO
	if err := c.ShouldBindJSON(&dto); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body: " + err.Error()})
		return
	}

	campaign, err := ctrl.cache.AddCampaign(dto)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"campaign_id": campaign.ID,
		"message":     "Campaign created successfully",
	})
}

// GetCampaign handles retrieving campaign details
func (ctrl *Controller) GetCampaign(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid campaign ID"})
		return
	}

	campaign, err := ctrl.cache.GetCampaign(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"campaignId":  campaign.ID,
		"customerId":  campaign.CustomerID,
		"sent":        campaign.Sent,
		"timezone":    campaign.Timezone,
		"maxMsg":      campaign.MaxMsg,
		"msgText":     campaign.MsgText,
		"clientCount": len(campaign.Clients),
		"status":      campaign.Status.String(),
	})
}

// StopCampaign handles pausing a campaign
func (ctrl *Controller) StopCampaign(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid campaign ID"})
		return
	}

	if err := ctrl.cache.UpdateCampaignStatus(id, PAUSED); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Campaign paused successfully",
		"status":  PAUSED.String(),
	})
}

// StartCampaign handles resuming a campaign
func (ctrl *Controller) StartCampaign(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid campaign ID"})
		return
	}

	if err := ctrl.cache.UpdateCampaignStatus(id, ACTIVE); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Campaign started successfully",
		"status":  ACTIVE.String(),
	})
}

// GetCampaigns returns all campaigns
func (ctrl *Controller) GetCampaigns(c *gin.Context) {
	campaigns := ctrl.cache.GetAllCampaigns()

	response := make([]gin.H, 0, len(campaigns))
	for _, campaign := range campaigns {
		response = append(response, gin.H{
			"campaign_id":  campaign.ID,
			"customer_id":  campaign.CustomerID,
			"sent":         campaign.Sent,
			"status":       campaign.Status.String(),
			"client_count": len(campaign.Clients),
		})
	}

	c.JSON(http.StatusOK, response)
}
