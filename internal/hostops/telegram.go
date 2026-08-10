package hostops

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

type TelegramChat struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Type  string `json:"type"`
}

type TelegramChatsResult struct {
	OK      bool           `json:"ok"`
	Chats   []TelegramChat `json:"chats"`
	Message string         `json:"message,omitempty"`
}

// DiscoverTelegramChats lists chats that have messaged the bot, so the user does
// not have to hand-curl a token URL to find their chat id.
//
// The token goes in the PATH because that is the API Telegram exposes; nothing
// here logs the URL, and the token is never echoed back to the caller.
func DiscoverTelegramChats(botToken string) TelegramChatsResult {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://api.telegram.org/bot"+botToken+"/getUpdates", nil)
	if err != nil {
		return TelegramChatsResult{Message: "Could not reach Telegram."}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return TelegramChatsResult{Message: "Could not reach Telegram: " + err.Error()}
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		// The specific case worth naming: any other error reads as a network
		// problem, and this one is a wrong token.
		return TelegramChatsResult{Message: "Telegram rejected that bot token."}
	}

	var payload struct {
		OK     bool `json:"ok"`
		Result []struct {
			Message struct {
				Chat struct {
					ID        int64  `json:"id"`
					Title     string `json:"title"`
					Username  string `json:"username"`
					FirstName string `json:"first_name"`
					Type      string `json:"type"`
				} `json:"chat"`
			} `json:"message"`
		} `json:"result"`
	}
	if json.NewDecoder(resp.Body).Decode(&payload) != nil || !payload.OK {
		return TelegramChatsResult{Message: "Telegram returned an unexpected response."}
	}

	seen := map[int64]bool{}
	chats := []TelegramChat{}
	for _, update := range payload.Result {
		chat := update.Message.Chat
		if chat.ID == 0 || seen[chat.ID] {
			continue
		}
		seen[chat.ID] = true

		title := chat.Title
		if title == "" {
			title = chat.Username
		}
		if title == "" {
			title = chat.FirstName
		}
		chats = append(chats, TelegramChat{
			ID: strconv.FormatInt(chat.ID, 10), Title: title, Type: chat.Type,
		})
	}
	if len(chats) == 0 {
		return TelegramChatsResult{OK: true, Chats: chats,
			Message: "No chats yet. Send your bot a message, then check again."}
	}
	return TelegramChatsResult{OK: true, Chats: chats}
}
