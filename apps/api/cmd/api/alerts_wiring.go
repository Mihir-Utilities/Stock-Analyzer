package main

import (
	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/alerts"
	"github.com/india-analyzer/api/internal/config"
	"github.com/india-analyzer/api/internal/egress"
	"github.com/india-analyzer/api/internal/httpx"
	"github.com/india-analyzer/api/internal/telegram"
)

// alertsDeps wires the alerts service. The Telegram sender exists only when TELEGRAM_BOT_TOKEN is
// set (the owner creates the bot, D-9); its client may reach api.telegram.org and nothing else.
func alertsDeps(cfg config.Config, db alerts.DB, log zerolog.Logger) (httpx.AlertsDeps, error) {
	svc := alerts.New(db, log)
	svc.BotUsername = cfg.TelegramBotUsername
	if cfg.TelegramBotToken != "" {
		hc, err := egress.New(egress.Allow{Scheme: "https", Host: telegram.Host})
		if err != nil {
			return httpx.AlertsDeps{}, err
		}
		svc.Sender = telegram.NewClient(cfg.TelegramBotToken, hc)
	}
	return httpx.AlertsDeps{Svc: svc, WebhookSecret: cfg.TelegramWebhookSecret, BotUsername: cfg.TelegramBotUsername}, nil
}
