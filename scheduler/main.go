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
	whRouter := app.Group("/wh")
	router := whRouter.Group("/campaign")
	router.POST("", controller.CreateNewCampaign)
	router.GET("/:id", controller.GetCampaign)
	router.POST("/:id/stop", controller.StopCampaign)
	router.POST("/:id/start", controller.StartCampaign)
	router.GET("", controller.GetCampaigns)
	err := app.Run(":80")
	if err != nil {
		panic(err)
	}
}
