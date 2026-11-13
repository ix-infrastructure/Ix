package main
import (
 "os"
 "flag"
 "net/http"
 "github.com/spf13/cobra"
 "github.com/spf13/pflag"
 "github.com/spf13/viper"
 "github.com/gin-gonic/gin"
 "github.com/labstack/echo/v4"
 "github.com/go-chi/chi/v5"
)
func boot() string { return os.Getenv("APP_HOST") + viper.GetString("server.host") }
func health(w http.ResponseWriter, r *http.Request) {}
func ginHealth(c *gin.Context) {}
func echoHealth(c echo.Context) error { return nil }
func setup() {
 host := flag.String("host", "localhost", "Host")
 println(*host)
 pflag.Bool("verbose", false, "Verbose")
 cmd := &cobra.Command{RunE: run}
 cmd.Flags().Int("count", 3, "Count")
 http.HandleFunc("/health", health)
 g := gin.Default()
 g.GET("/gin/:id", ginHealth)
 e := echo.New()
 e.POST("/echo/:id", echoHealth)
 r := chi.NewRouter()
 r.Get("/chi/{id}", health)
}
func run(cmd *cobra.Command, args []string) error {
 cmd.Flags().GetInt("count")
 return nil
}
