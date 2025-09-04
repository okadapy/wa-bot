package main

import (
	"log"
	"wa-bot/scheduler/src/campaign"

	"github.com/gin-gonic/gin"
)

func main() {
	app := gin.Default()

	logger := log.Default()

	// Initialize the scheduler and controller
	schedule := campaign.NewScheduler(logger)
	controller := campaign.NewCampaignController(schedule)

	app.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"status": "ok",
		})

	})

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
