package main

import (
	"wa-bot/scheduler/src/campaign"

	"github.com/gin-gonic/gin"
)

func main() {
	app := gin.Default()

	// Initialize the scheduler and controller
	schedule := campaign.NewScheduler()
	controller := campaign.NewCampaignController(schedule)

	// Set up routes
	router := gin.Default()
	router.POST("/campaigns", controller.CreateNewCampaign)
	router.GET("/campaigns/:id", controller.GetCampaign)
	router.POST("/campaigns/:id/stop", controller.StopCampaign)
	router.POST("/campaigns/:id/start", controller.StartCampaign)
	router.GET("/campaigns", controller.GetCampaigns)
	err := app.Run(":80")
	if err != nil {
		panic(err)
	}
}
