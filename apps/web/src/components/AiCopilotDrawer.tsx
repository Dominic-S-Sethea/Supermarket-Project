import { useEffect, useRef, useState } from "react";
import { Check, Plus, Send, Sparkles, Terminal, X } from "lucide-react";
import { apiGet, apiPost, formatApiErrorPayload } from "../api";

interface ToolTrace {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCallsJson?: ToolTrace[] | null;
  createdAt: string;
}

interface ProposedAction {
  id: string;
  actionType: "create_po" | "update_price" | "create_promo";
  title: string;
  summary: string;
  previewJson: Record<string, unknown>;
  status: "pending" | "executed" | "rejected";
  executedBy?: string | null;
}

interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  updatedAt: string;
}

interface SseEventPayload {
  type: string;
  conversationId?: string;
  tool?: string;
  args?: Record<string, unknown>;
  summary?: string;
  text?: string;
  model?: string;
  message?: ChatMessage;
  actions?: ProposedAction[];
  error?: string;
}

const STARTER_PROMPTS = [
  "Give me today's Morning Risk Briefing",
  "Diagnose why morning shift sales are underperforming & propose a fix",
  "Check vendor margin erosion alerts & propose a fix",
  "Draft an urgent supplier Purchase Order for critical stockouts",
  "Design a weekend combo promo from our top Market Basket pair",
];

export function AiCopilotDrawer({
  open,
  initialPrompt,
  onConsumeInitialPrompt,
  onClose,
  onActionExecuted,
}: {
  open: boolean;
  initialPrompt?: string | null;
  onConsumeInitialPrompt?: () => void;
  onClose: () => void;
  onActionExecuted: () => void;
}) {
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [modelName, setModelName] = useState("local-deterministic-tools");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [actions, setActions] = useState<ProposedAction[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [liveTools, setLiveTools] = useState<ToolTrace[]>([]);
  const [error, setError] = useState<string | null>(null);

  const streamAbortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const abortActiveStream = () => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
  };

  const loadStatusAndHistory = async (signal?: AbortSignal) => {
    try {
      const [status, convs] = await Promise.all([
        apiGet<{ geminiConfigured: boolean; model: string }>("/api/ai/status", signal),
        apiGet<{ conversations: ConversationSummary[] }>("/api/ai/conversations", signal),
      ]);
      setGeminiConfigured(status.geminiConfigured);
      setModelName(status.model);
      setConversations(convs.conversations);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Failed loading AI Copilot status");
      }
    }
  };

  useEffect(() => {
    if (!open) {
      abortActiveStream();
      return;
    }
    const controller = new AbortController();
    void loadStatusAndHistory(controller.signal);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      controller.abort();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    return () => {
      abortActiveStream();
    };
  }, []);

  useEffect(() => {
    if (open && initialPrompt && !sending) {
      const p = initialPrompt;
      onConsumeInitialPrompt?.();
      void sendMessage(p);
    }
  }, [open, initialPrompt]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamingText, liveTools.length]);

  const loadConversation = async (id: string) => {
    abortActiveStream();
    setSending(false);
    setStreamingText("");
    setLiveTools([]);
    setError(null);
    try {
      const data = await apiGet<{
        messages: ChatMessage[];
        actions: ProposedAction[];
      }>(`/api/ai/conversations/${id}`);
      setConversationId(id);
      setMessages(data.messages);
      setActions(data.actions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed loading conversation");
    }
  };

  const sendMessage = async (text = input) => {
    const clean = text.trim();
    if (!clean || sending) return;
    abortActiveStream();
    const controller = new AbortController();
    streamAbortRef.current = controller;

    setError(null);
    setSending(true);
    setStreamingText("");
    setLiveTools([]);
    setInput("");

    const optimisticUserMsg: ChatMessage = {
      id: `tmp-${Date.now()}`,
      role: "user",
      content: clean,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    let completedTurn = false;

    const processRawEvent = (rawEvent: string) => {
      const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) return;
      const jsonStr = dataLines.join("\n");
      if (!jsonStr) return;

      let ev: SseEventPayload;
      try {
        ev = JSON.parse(jsonStr) as SseEventPayload;
      } catch {
        return;
      }

      if (ev.type === "meta" && ev.conversationId) {
        setConversationId(ev.conversationId);
      } else if (ev.type === "tool_call" && ev.tool) {
        setLiveTools((prev) => [
          ...prev,
          { tool: ev.tool!, args: ev.args ?? {}, summary: "running..." },
        ]);
      } else if (ev.type === "tool_result" && ev.tool) {
        setLiveTools((prev) =>
          prev.map((t, idx) =>
            idx === prev.length - 1 && t.tool === ev.tool
              ? { ...t, summary: ev.summary ?? "OK" }
              : t
          )
        );
      } else if (ev.type === "delta" && ev.text) {
        setStreamingText((prev) => prev + ev.text);
      } else if (ev.type === "done" && ev.message) {
        completedTurn = true;
        setConversationId(ev.conversationId ?? null);
        if (ev.model) setModelName(ev.model);
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimisticUserMsg.id),
          optimisticUserMsg,
          ev.message!,
        ]);
        setActions(ev.actions ?? []);
        setStreamingText("");
        setLiveTools([]);
        void loadStatusAndHistory();
      } else if (ev.type === "error") {
        throw new Error(ev.error ?? "Streaming failed");
      }
    };

    try {
      const res = await fetch("/api/ai/chat/stream", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationId ?? undefined,
          message: clean,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => "");
        throw new Error(formatApiErrorPayload(errBody, res.status, "POST", "/api/ai/chat/stream"));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        let sepIdx = buffer.indexOf("\n\n");
        while (sepIdx >= 0) {
          const rawEvent = buffer.slice(0, sepIdx).trim();
          buffer = buffer.slice(sepIdx + 2);
          sepIdx = buffer.indexOf("\n\n");
          if (rawEvent) processRawEvent(rawEvent);
        }
      }

      if (buffer.trim()) {
        processRawEvent(buffer.trim());
      }
      if (!completedTurn && !controller.signal.aborted) {
        throw new Error("Copilot stream ended unexpectedly before finishing.");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Failed sending message");
        setMessages((prev) => prev.filter((m) => m.id !== optimisticUserMsg.id));
        setInput((curr) => (curr ? curr : clean));
      }
      setStreamingText("");
      setLiveTools([]);
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      setSending(false);
    }
  };

  const handleActionDecision = async (actionId: string, decision: "execute" | "reject") => {
    if (busyActionId) return;
    setError(null);
    setBusyActionId(actionId);
    try {
      const res = await apiPost<{ action: ProposedAction }>(
        `/api/ai/actions/${actionId}/${decision}`,
        {}
      );
      setActions((prev) => prev.map((a) => (a.id === actionId ? res.action : a)));
      if (decision === "execute") {
        onActionExecuted();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${decision} action`);
    } finally {
      setBusyActionId(null);
    }
  };

  if (!open) return null;

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer ai-drawer" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Sparkles size={17} color="var(--accent-primary)" />
              <h2 style={{ margin: 0, fontSize: 18 }}>Store Manager AI Copilot</h2>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <span className={`tag mono ${geminiConfigured ? "tag-green" : "tag-blue"}`}>
                {geminiConfigured ? `Gemini SSE: ${modelName}` : "Local Tool SSE Mode"}
              </span>
              <span className="tag tag-neutral">Human-in-the-Loop Guarded</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn btn-sm"
              onClick={() => {
                abortActiveStream();
                setSending(false);
                setConversationId(null);
                setMessages([]);
                setActions([]);
                setStreamingText("");
                setLiveTools([]);
                setError(null);
              }}
            >
              <Plus size={13} /> New
            </button>
            <button className="btn btn-sm" aria-label="Close AI Copilot" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>

        {conversations.length > 0 && (
          <select
            className="select"
            value={conversationId ?? ""}
            onChange={(e) => {
              if (e.target.value) void loadConversation(e.target.value);
            }}
          >
            <option value="">Recent Copilot Threads ({conversations.length})...</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}

        {error && (
          <div className="banner banner-red">
            <span>{error}</span>
            <button className="btn btn-sm" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="ai-messages">
          {messages.length === 0 && !sending ? (
            <div className="stack-md" style={{ gap: 10 }}>
              <p className="panel-desc">
                Ask about live sales, margin erosion, FEFO expiry batches, reorder POs, cashier anomalies, or promotional bundles. Write actions stage approval cards before touching PostgreSQL.
              </p>
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  className="quick-sku-btn"
                  onClick={() => void sendMessage(prompt)}
                >
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>{prompt}</span>
                </button>
              ))}
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`ai-bubble ${m.role}`}>
                <div className="ai-bubble-role">
                  {m.role === "user" ? "You" : "SupermarketOS Copilot"}
                </div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{m.content}</div>
                {m.toolCallsJson && m.toolCallsJson.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                    {m.toolCallsJson.map((t, idx) => (
                      <span key={`${t.tool}-${idx}`} className="tag tag-neutral mono" style={{ fontSize: 10.5 }}>
                        <Terminal size={10} /> {t.tool}: {t.summary}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
          {sending && (
            <div className="ai-bubble assistant">
              <div className="ai-bubble-role">
                SupermarketOS Copilot · <span className="mono">STREAMING</span>
              </div>
              {liveTools.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                  {liveTools.map((t, idx) => (
                    <span key={`live-${t.tool}-${idx}`} className="tag tag-blue mono" style={{ fontSize: 10.5 }}>
                      <Terminal size={10} /> {t.tool}: {t.summary}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
                {streamingText || "Running store tools & streaming response..."}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {actions.length > 0 && (
          <div className="stack-md" style={{ gap: 8 }}>
            <div className="kpi-label">Proposed Store Actions (Approval Required)</div>
            {actions.map((a) => (
              <div key={a.id} className="ai-action-card">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>{a.title}</strong>
                  <span
                    className={`tag ${
                      a.status === "executed"
                        ? "tag-green"
                        : a.status === "rejected"
                          ? "tag-red"
                          : "tag-amber"
                    }`}
                  >
                    {a.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-secondary)", marginTop: 4 }}>
                  {a.summary}
                </div>
                {a.status === "pending" && (
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button
                      id={`approve-ai-action-${a.id}`}
                      className="btn btn-primary btn-sm"
                      disabled={busyActionId !== null}
                      onClick={() => void handleActionDecision(a.id, "execute")}
                    >
                      <Check size={13} />{" "}
                      {busyActionId === a.id ? "Applying..." : "Approve & Execute"}
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={busyActionId !== null}
                      onClick={() => void handleActionDecision(a.id, "reject")}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <form
          className="pos-scan-bar"
          style={{ marginBottom: 0, marginTop: "auto" }}
          onSubmit={(e) => {
            e.preventDefault();
            void sendMessage();
          }}
        >
          <input
            id="ai-copilot-input"
            className="input"
            style={{ fontSize: 13 }}
            placeholder="Ask about margins, POs, expiry, or promos..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sending}
          />
          <button
            id="ai-copilot-send-btn"
            type="submit"
            className="btn btn-primary"
            disabled={sending || !input.trim()}
          >
            <Send size={14} />
          </button>
        </form>
      </aside>
    </div>
  );
}
