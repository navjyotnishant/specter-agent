// Author: Navjyot Nishant
// Created: 2026-07-31
// Last updated: 2026-07-31
// Description: Configures the signed-in user's Telegram bot credentials.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import { getStoredToken } from "@/lib/auth";

export function TelegramConfigForm() {
  const token = getStoredToken() ?? "";
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["telegram-config"],
    queryFn: () => api.telegramConfig(token),
    enabled: Boolean(token),
    retry: false,
  });

  const [botToken, setBotToken] = useState("");
  const [chatIds, setChatIds] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);

  // Seed from saved config once it loads. Secrets stay blank -- an empty field
  // means "unchanged" on save, so the token never has to round-trip.
  useEffect(() => {
    if (!data) return;
    setChatIds((data.allowed_chat_ids ?? []).join(", "));
  }, [data]);

  const [discovered, setDiscovered] = useState<{ id: number; name: string }[]>([]);
  const discover = useMutation({
    mutationFn: () => api.discoverTelegramChats(token, botToken.trim()),
    onSuccess: (res) => {
      setDiscovered(res.chats ?? []);
      setError(res.ok ? (res.message ?? "") : (res.message || "Could not reach Telegram."));
    },
    onError: (err: Error) => setError(err.message),
  });

  const save = useMutation({
    mutationFn: () =>
      api.saveTelegramConfig(token, {
        bot_token: botToken.trim(),
        allowed_chat_ids: chatIds.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: (res) => {
      if (!res.ok) { setError(res.message || "Could not save."); return; }
      setError("");
      setBotToken("");
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["telegram-config"] });
    },
    onError: (err: Error) => setError(err.message || "Could not save."),
  });

  if (isLoading) {
    return (
      <p className="flex items-center gap-1.5 py-2 text-[10px] text-[#9ca3af]">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking bot config…
      </p>
    );
  }

  const field = "w-full border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#374151]";

  // Already set up: this is one bot for the whole host, so re-showing the token
  // form on every trigger node reads as "configure it again". Show state instead.
  if (data?.configured && !editing) {
    return (
      <div className="mt-2 border border-[#e5e7eb] bg-[#fafafa] p-2.5">
        <p className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
          <CheckCircle2 className="h-3 w-3" />
          Bot connected ({data.bot_token_hint}) · {data.allowed_chat_ids.length} chat
          {data.allowed_chat_ids.length === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-[10px] text-[#9ca3af]">
          Shared by every Telegram trigger — set once for this machine.
        </p>
        <button
          onClick={() => setEditing(true)}
          className="mt-2 border border-[#d1d5db] bg-white px-2 py-1 text-[10px] font-medium text-[#374151]"
        >
          Change bot settings
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 border border-[#e5e7eb] bg-[#fafafa] p-2.5">
      {data?.configured && (
        <div className="mb-2 flex items-center justify-between">
          <p className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
            <CheckCircle2 className="h-3 w-3" />
            Bot connected ({data.bot_token_hint})
          </p>
          <button onClick={() => setEditing(false)} className="text-[10px] text-[#6b7280] underline">
            Cancel
          </button>
        </div>
      )}

      {!data?.configured && (
        <ol className="mb-2.5 space-y-1 border-b border-[#e5e7eb] pb-2.5 text-[10px] leading-relaxed text-[#6b7280]">
          <li>
            <strong>1.</strong> In Telegram, message{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-indigo-600 underline">
              @BotFather
            </a>{" "}
            → <code>/newbot</code> → copy the token it gives you.
          </li>
          <li>
            <strong>2.</strong> Send your new bot any message (it can't message you first).
          </li>
          <li>
            <strong>3.</strong> Paste the token below, click <em>Find my chat id</em>.
          </li>
        </ol>
      )}

      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-[#9ca3af]">
        Bot token {data?.bot_token_set && <span className="text-[#9ca3af]">(leave blank to keep)</span>}
      </label>
      <input
        className={field}
        type="password"
        value={botToken}
        onChange={(e) => setBotToken(e.target.value)}
        placeholder={data?.bot_token_set ? "••••••" : "123456:ABC-…  from @BotFather"}
      />

      <label className="mb-1 mt-2 block text-[10px] font-semibold uppercase tracking-widest text-[#9ca3af]">
        Allowed chat ids
      </label>
      <input
        className={field}
        value={chatIds}
        onChange={(e) => setChatIds(e.target.value)}
        placeholder="123456789, 987654321"
      />
      <button
        onClick={() => discover.mutate()}
        disabled={discover.isPending}
        className="mt-1 border border-[#d1d5db] bg-white px-2 py-1 text-[10px] font-medium text-[#374151] disabled:opacity-40"
      >
        {discover.isPending ? "Checking…" : "Find my chat id"}
      </button>
      {discovered.length > 0 && (
        <div className="mt-1 flex max-w-full flex-wrap gap-1">
          {discovered.map((c) => (
            <button
              key={c.id}
              onClick={() => setChatIds((cur) => (cur.split(",").map((s) => s.trim()).includes(String(c.id)) ? cur : [cur, String(c.id)].filter(Boolean).join(", ")))}
              className="max-w-full truncate border border-indigo-200 bg-indigo-50 px-1.5 py-[2px] text-[10px] text-indigo-700"
            >
              + {c.name} ({c.id})
            </button>
          ))}
        </div>
      )}
      <p className="mt-1 text-[10px] text-[#9ca3af]">
        Only these chats can start runs. Anyone else is rejected and logged.
      </p>



      {error && <p className="mt-2 text-[10px] font-semibold text-red-600">{error}</p>}

      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="mt-2.5 w-full border border-[#0f1117] bg-[#0f1117] px-2 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
      >
        {save.isPending ? "Saving…" : data?.configured ? "Update bot config" : "Save bot config"}
      </button>
      <p className="mt-1.5 text-[10px] leading-relaxed text-[#9ca3af]">
        Stored on the host at{" "}
        <code className="break-all" title={data?.path ?? "~/.specter/telegram.json"}>
          {data?.path ?? "~/.specter/telegram.json"}
        </code>{" "}
        (mode 0600).
      </p>
    </div>
  );
}
