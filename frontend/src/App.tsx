import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowUp, Bot, Check, Clock3, Cpu, Database, Layers3, Plus, Sparkles, UserRound, Zap } from "lucide-react";

type Metadata = {
  resolution_source: "LLM_CACHE" | "LIVE_INFERENCE";
  model: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  key_id: string | null;
  fallback_attempts: number;
};
type Message = { role: "user" | "assistant"; content: string; metadata?: Metadata; error?: boolean };
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");

function newSessionId() {
  return `s-${crypto.randomUUID()}`;
}

export default function App() {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [health, setHealth] = useState<"checking" | "ready" | "offline">("checking");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API_BASE}/health`).then((response) => {
      if (!response.ok) throw new Error("Backend unavailable");
      return response.json();
    }).then(() => setHealth("ready")).catch(() => setHealth("offline"));
  }, []);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [messages, sending]);

  function startNewChat() {
    setSessionId(newSessionId());
    setMessages([]);
    setDraft("");
  }

  function copySessionId() {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(sessionId).catch(() => undefined);
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setMessages((current) => [...current, { role: "user", content: text }]);
    setSending(true);
    try {
      const response = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: text, ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = Array.isArray(body.detail)
          ? body.detail.map((item: { msg?: string }) => item.msg).filter(Boolean).join("; ")
          : body.detail;
        throw new Error(typeof detail === "string" ? detail : `Request failed (${response.status})`);
      }
      if (typeof body.reply !== "string" || !body.reply.trim() || !body.metadata) {
        throw new Error("The server returned an incomplete response. Please try again.");
      }
      setMessages((current) => [...current, { role: "assistant", content: body.reply, metadata: body.metadata }]);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: error instanceof Error ? error.message : "Something went wrong. Please try again.", error: true }]);
    } finally {
      setSending(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="Lyftr AI home">
          <span className="brand-mark"><Sparkles size={17} strokeWidth={2.4} /></span>
          <span>lyftr<span className="brand-ai">.ai</span></span>
        </a>
        <button className="new-chat" onClick={startNewChat}><Plus size={17} /> New conversation</button>
        <div className="side-label">WORKSPACE</div>
        <div className="side-current"><span className="current-dot" /> AI assistant</div>
        <div className="sidebar-bottom">
          <div className="sidebar-card"><div className="sidebar-card-icon"><Zap size={16} /></div><div><strong>Built for reliability</strong><small>Cache + automatic key failover</small></div></div>
          <div className="profile"><div className="avatar-small">G</div><div><strong>Guest workspace</strong><small>Personal session</small></div><span className="profile-menu">•••</span></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="slash">/</span><strong>AI assistant</strong></div>
          <div className="topbar-right"><span className={`service-status ${health}`}><i />{health === "ready" ? "All systems operational" : health === "checking" ? "Connecting" : "Backend offline"}</span><button className="share-button" onClick={copySessionId} title="Copy session ID">Session <span className="session-short">{sessionId.slice(0, 10)}…</span></button></div>
        </header>

        <section className={`conversation ${messages.length === 0 ? "empty" : "has-messages"}`}>
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-orb"><Sparkles size={24} /></div>
              <div className="eyebrow"><span /> YOUR AI WORKSPACE</div>
              <h1>Good ideas start<br />with a <em>conversation.</em></h1>
              <p>Ask anything. Your assistant remembers the context,<br className="desktop-only" /> while smart caching keeps things quick.</p>
              <div className="suggestions">
                <button onClick={() => setDraft("How can I improve customer retention?")}><span className="suggestion-icon indigo"><Activity size={16} /></span><span><b>Explore an idea</b><small>How can I improve customer retention?</small></span><ArrowUp size={15} /></button>
                <button onClick={() => setDraft("Summarize the benefits of caching in AI apps.")}><span className="suggestion-icon teal"><Layers3 size={16} /></span><span><b>Learn something</b><small>Why does caching make AI faster?</small></span><ArrowUp size={15} /></button>
              </div>
              <div className="feature-row"><span><Database size={14} /> SQLite memory</span><span><Zap size={14} /> Automatic failover</span><span><Clock3 size={14} /> Fast cached replies</span></div>
            </div>
          ) : (
            <div className="message-list">
              <div className="date-divider"><span>THIS CONVERSATION</span><i /></div>
              {messages.map((message, index) => message.role === "user" ? (
                <div className="user-row" key={`${index}-${message.content}`}><div className="user-bubble">{message.content}</div><div className="user-avatar"><UserRound size={16} /></div></div>
              ) : (
                <article className={`assistant-row ${message.error ? "is-error" : ""}`} key={`${index}-${message.content}`} data-testid="assistant-message">
                  <div className="bot-avatar"><Bot size={17} /></div>
                  <div className="assistant-content"><div className="assistant-name">Lyftr assistant <span>AI</span></div><div className="assistant-text">{message.content}</div>
                    {message.metadata && <div className="metadata-strip">
                      <span className={`meta-pill ${message.metadata.resolution_source === "LLM_CACHE" ? "cache" : "live"}`}><i /> <span data-testid="meta-source">{message.metadata.resolution_source}</span></span>
                      <span className="meta-item"><Cpu size={12} /><span data-testid="meta-model">{message.metadata.model}</span></span>
                      <span className="meta-item"><Clock3 size={12} /><span data-testid="meta-latency">{message.metadata.latency_ms} ms</span></span>
                      <span className="meta-item token-item"><ArrowDown size={12} /><span data-testid="meta-input-tokens">{message.metadata.input_tokens}</span></span>
                      <span className="meta-item token-item"><ArrowUp size={12} /><span data-testid="meta-output-tokens">{message.metadata.output_tokens}</span></span>
                      {message.metadata.fallback_attempts > 0 && <span className="meta-fallback"><Check size={12} /> Recovered after {message.metadata.fallback_attempts} failed key{message.metadata.fallback_attempts > 1 ? "s" : ""}</span>}
                    </div>}
                  </div>
                </article>
              ))}
              {sending && <div className="assistant-row typing"><div className="bot-avatar"><Bot size={17} /></div><div className="typing-bubble"><i /><i /><i /> <span>Thinking…</span></div></div>}
              <div ref={endRef} />
            </div>
          )}
        </section>

        <footer className="composer-wrap">
          {showPrompt && <div className="prompt-config"><label htmlFor="system-prompt-input">Session instructions</label><input id="system-prompt-input" data-testid="system-prompt-input" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="Set a system prompt for this chat (optional)" /><button onClick={() => setShowPrompt(false)}>Done</button></div>}
          <form className="composer" onSubmit={sendMessage}>
            <textarea data-testid="chat-input" aria-label="Your message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="Message your assistant…" rows={1} maxLength={4000} disabled={sending} />
            <div className="composer-tools"><div className="composer-hints"><button type="button" className={`prompt-toggle ${showPrompt ? "active" : ""}`} onClick={() => setShowPrompt(!showPrompt)} title="Set system prompt"><Sparkles size={14} /><span>System prompt</span></button><span className="key-hint"><kbd>↵</kbd> to send</span></div><div className="send-side"><span className="char-count">{draft.length ? `${draft.length}/4000` : ""}</span><button className="send-button" data-testid="send-button" type="submit" disabled={!draft.trim() || sending} aria-label="Send message"><ArrowUp size={18} /></button></div></div>
          </form>
          <div className="footer-note">AI can make mistakes. Verify important information.</div>
        </footer>
      </main>
    </div>
  );
}
