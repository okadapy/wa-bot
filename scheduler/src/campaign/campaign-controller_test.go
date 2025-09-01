package campaign

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestCampaignStatus_ToString(t *testing.T) {
	tests := []struct {
		status   Status
		expected string
	}{
		{ACTIVE, "active"},
		{STOP, "stopped"},
		{DONE, "done"},
		{100, "kill me plz"},
	}

	for _, test := range tests {
		assert.Equal(t, test.expected, test.status.ToString())
	}
}

func TestCampaignCache_AddCampaign(t *testing.T) {
	cache := Cache{}
	campaign := Campaign{
		DTO: DTO{
			Clients: []ClientDTO{},
		},
	}
	id := cache.AddCampaign(campaign)
	assert.Equal(t, 0, id)
	assert.Len(t, cache.values, 1)
}

func TestCampaignCache_CheckCampaignExists(t *testing.T) {
	cache := Cache{}
	id := 0
	err := cache.CheckCampaignExists(&id)
	assert.Error(t, err)

	campaign := Campaign{
		DTO: DTO{
			Clients: []ClientDTO{},
		},
	}
	cache.values = append(cache.values, campaign)
	err = cache.CheckCampaignExists(&id)
	assert.NoError(t, err)
}

func TestCampaignCache_GetCampaign(t *testing.T) {
	cache := Cache{}
	id := 0
	_, err := cache.GetCampaign(&id)
	assert.Error(t, err)

	campaign := Campaign{
		DTO: DTO{
			Clients: []ClientDTO{},
		},
	}
	cache.values = append(cache.values, campaign)
	retrieved, err := cache.GetCampaign(&id)
	assert.NoError(t, err)
	assert.Equal(t, &campaign, retrieved)
}

func TestCampaignCache_ChangeCampaignStatus(t *testing.T) {
	cache := Cache{}
	id := 0
	err := cache.ChangeCampaignStatus(&id, STOP)
	assert.Error(t, err)

	campaign := Campaign{
		DTO: DTO{
			Clients: []ClientDTO{},
		},
		Status: ACTIVE,
	}
	cache.values = append(cache.values, campaign)
	err = cache.ChangeCampaignStatus(&id, STOP)
	assert.NoError(t, err)
	assert.Equal(t, STOP, cache.values[id].Status)
}

func TestNewCampaignController(t *testing.T) {
	// Reset global cache for this test
	cache = Cache{
		values: []Campaign{},
	}

	ctrl := NewCampaignController()
	assert.IsType(t, &Controller{}, ctrl)
	assert.Len(t, cache.values, 0)
}

func TestParseID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		id       string
		wantErr  bool
		expected int
	}{
		{"0", false, 0},
		{"invalid", true, 0},
	}

	for _, test := range tests {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Params = gin.Params{gin.Param{Key: "id", Value: test.id}}

		result, err := ParseID(c)
		if test.wantErr {
			assert.Error(t, err)
			assert.Equal(t, http.StatusBadRequest, w.Code)
		} else {
			assert.NoError(t, err)
			assert.Equal(t, test.expected, *result)
		}
	}
}

func TestCampaignController_CreateNewCampaign(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctrl := Controller{}

	tests := []struct {
		name       string
		payload    interface{}
		wantStatus int
	}{
		{
			"Valid Request",
			DTO{
				CustomerID: 1,
				Timezone:   0,
				Clients:    []ClientDTO{{Name: "test", PhoneNumber: "123"}},
				MaxMsg:     100,
				MsgText:    "test",
			},
			http.StatusOK,
		},
		{
			"Invalid JSON",
			"invalid",
			http.StatusUnprocessableEntity,
		},
		{
			"No Clients",
			DTO{Clients: nil},
			http.StatusBadRequest,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Reset global cache for each test
			cache = Cache{
				values: []Campaign{},
			}

			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			jsonData, _ := json.Marshal(test.payload)
			c.Request = httptest.NewRequest("POST", "/", bytes.NewBuffer(jsonData))
			c.Request.Header.Set("Content-Type", "application/json")

			ctrl.CreateNewCampaign(c)

			assert.Equal(t, test.wantStatus, w.Code)
			if test.wantStatus == http.StatusOK {
				var response gin.H
				err := json.Unmarshal(w.Body.Bytes(), &response)
				if err != nil {
					return
				}
				assert.Contains(t, response, "campaign_id")
			}
		})
	}
}

func TestCampaignController_GetCampaign(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctrl := Controller{}

	// Reset global cache
	cache = Cache{
		values: []Campaign{},
	}

	// Test non-existent campaign
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{gin.Param{Key: "id", Value: "0"}}
	ctrl.GetCampaign(c)
	assert.Equal(t, http.StatusNotFound, w.Code)

	// Test existing campaign
	campaign := Campaign{
		DTO: DTO{
			CustomerID: 1,
			Timezone:   2,
			MaxMsg:     100,
			MsgText:    "test",
			Clients:    []ClientDTO{{Name: "Test", PhoneNumber: "123"}},
		},
		Sent:   5,
		Status: ACTIVE,
	}
	id := cache.AddCampaign(campaign)

	w = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(w)
	c.Params = gin.Params{gin.Param{Key: "id", Value: strconv.Itoa(id)}}
	ctrl.GetCampaign(c)

	assert.Equal(t, http.StatusOK, w.Code)
	var response gin.H
	err := json.Unmarshal(w.Body.Bytes(), &response)
	if err != nil {
		return
	}
	assert.Equal(t, float64(id), response["campaign_id"].(float64))
	assert.Equal(t, float64(5), response["sent"].(float64))
	assert.Equal(t, "active", response["status"])
}

func TestCampaignController_StopAndStartCampaign(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctrl := Controller{}

	// Reset global cache
	cache = Cache{
		values: []Campaign{},
	}

	// Test non-existent campaign
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{gin.Param{Key: "id", Value: "0"}}
	ctrl.StopCampaign(c)
	assert.Equal(t, http.StatusBadRequest, w.Code)

	// Test existing campaign
	campaign := Campaign{
		DTO: DTO{
			Clients: []ClientDTO{{Name: "Test", PhoneNumber: "123"}},
		},
	}
	id := cache.AddCampaign(campaign)

	w = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(w)
	c.Params = gin.Params{gin.Param{Key: "id", Value: strconv.Itoa(id)}}
	ctrl.StopCampaign(c)
	assert.Equal(t, http.StatusOK, w.Code)

	// Check that status was changed
	campaignPtr, _ := cache.GetCampaign(&id)
	assert.Equal(t, STOP, campaignPtr.Status)

	w = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(w)
	c.Params = gin.Params{gin.Param{Key: "id", Value: strconv.Itoa(id)}}
	ctrl.StartCampaign(c)
	assert.Equal(t, http.StatusOK, w.Code)

	// Check that status was changed back
	campaignPtr, _ = cache.GetCampaign(&id)
	assert.Equal(t, ACTIVE, campaignPtr.Status)
}
