import { FormEvent, KeyboardEvent, MouseEvent, useEffect, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowUp, Bot, Check, Clock3, Cpu, Database, Layers3, Plus, Sparkles, Trash2, UserRound, Zap } from "lucide-react";

type Metadata = {
  resolution_source: "LLM_CACHE" | "LIVE_INFERENCE";
  model: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  key_id: string | null;
  fallback_attempts: number;
};
type HealthInfo = { keys_configured: number; cache_enabled: boolean };
type Message = { role: "user" | "assistant"; content: string; metadata?: Metadata; error?: boolean };
type HistorySession = { session_id: string; preview: string; created_at: string; updated_at: string; message_count: number };
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");

function newSessionId() {
  return `s-${crypto.randomUUID()}`;
}

function formatHistoryDate(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const age = Math.max(0, Date.now() - timestamp);
  if (age < 60_000) return "Just now";
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 24 * 60 * 60_000) return `${Math.floor(age / (60 * 60_000))}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function App() {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [health, setHealth] = useState<"checking" | "ready" | "offline">("checking");
  const [healthInfo, setHealthInfo] = useState<HealthInfo | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showReliabilityDetails, setShowReliabilityDetails] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const activeSessionRef = useRef(sessionId);
  const sessionLoadRef = useRef(0);

  async function refreshSessions(showLoading = false) {
    if (showLoading) setHistoryLoading(true);
    try {
      const response = await fetch(`${API_BASE}/sessions?limit=50`);
      if (!response.ok) throw new Error("Could not load conversation history");
      const body = await response.json();
      setSessions(Array.isArray(body.sessions) ? body.sessions : []);
      setHistoryError("");
    } catch {
      setHistoryError("Conversation history is unavailable.");
    } finally {
      if (showLoading) setHistoryLoading(false);
    }
  }

  useEffect(() => {
    fetch(`${API_BASE}/health`).then((response) => {
      if (!response.ok) throw new Error("Backend unavailable");
      return response.json();
    }).then((data: HealthInfo) => {
      setHealthInfo(data);
      setHealth("ready");
    }).catch(() => {
      setHealthInfo(null);
      setHealth("offline");
    });
  }, []);

  useEffect(() => {
    void refreshSessions(true);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  function startNewChat() {
    sessionLoadRef.current += 1;
    const nextSessionId = newSessionId();
    activeSessionRef.current = nextSessionId;
    setSessionId(nextSessionId);
    setMessages([]);
    setDraft("");
    setSystemPrompt("");
    setShowPrompt(false);
    setShowProfileMenu(false);
    setCopyStatus("");
    setOpeningSessionId(null);
  }

  async function openConversation(session: HistorySession) {
    if (openingSessionId || deletingSessionId) return;
    const requestId = ++sessionLoadRef.current;
    setOpeningSessionId(session.session_id);
    setHistoryError("");
    try {
      const response = await fetch(`${API_BASE}/sessions/${encodeURIComponent(session.session_id)}/messages`);
      if (!response.ok) throw new Error("Could not open this conversation");
      const body = await response.json();
      if (!Array.isArray(body.messages)) throw new Error("The server returned invalid conversation history");
      if (requestId !== sessionLoadRef.current) return;
      activeSessionRef.current = session.session_id;
      setSessionId(session.session_id);
      setMessages(body.messages);
      setDraft("");
      setSystemPrompt("");
      setShowPrompt(false);
      setShowProfileMenu(false);
      setCopyStatus("");
    } catch {
      if (requestId === sessionLoadRef.current) setHistoryError("Could not open that conversation. Please try again.");
    } finally {
      if (requestId === sessionLoadRef.current) setOpeningSessionId(null);
    }
  }

  async function deleteConversation(event: MouseEvent<HTMLButtonElement>, session: HistorySession) {
    event.stopPropagation();
    if (openingSessionId || deletingSessionId || sending) return;
    setDeletingSessionId(session.session_id);
    setHistoryError("");
    try {
      const response = await fetch(`${API_BASE}/sessions/${encodeURIComponent(session.session_id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete this conversation");
      setSessions((current) => current.filter((item) => item.session_id !== session.session_id));
      if (activeSessionRef.current === session.session_id) startNewChat();
    } catch {
      setHistoryError("Could not delete that conversation. Please try again.");
    } finally {
      setDeletingSessionId(null);
    }
  }

  async function copySessionId() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(sessionId);
      setCopyStatus("Session ID copied");
    } catch {
      setCopyStatus("Could not access the clipboard");
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending || openingSessionId) return;
    const requestSessionId = sessionId;
    setDraft("");
    setMessages((current) => [...current, { role: "user", content: text }]);
    setSending(true);
    try {
      const response = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: requestSessionId, message: text, ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {}) }),
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
      if (activeSessionRef.current === requestSessionId) {
        setMessages((current) => [...current, { role: "assistant", content: body.reply, metadata: body.metadata }]);
      }
      void refreshSessions();
    } catch (error) {
      if (activeSessionRef.current === requestSessionId) {
        setMessages((current) => [...current, { role: "assistant", content: error instanceof Error ? error.message : "Something went wrong. Please try again.", error: true }]);
      }
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
        <a className="brand" href="#" aria-label="NAKSH AI home">
          <span className="brand-mark"><Sparkles size={17} strokeWidth={2.4} /></span>
          <span>NAKSH <span className="brand-ai">AI</span></span>
        </a>
        <button className="new-chat" onClick={startNewChat}><Plus size={17} /> New conversation</button>
        <div className="side-label">WORKSPACE</div>
        <div className="side-current"><span className="current-dot" /> AI assistant</div>
        <section className="history-panel" aria-label="Conversation history">
          <div className="history-heading"><span>HISTORY</span><span className="history-count">{sessions.length}</span></div>
          <div className="history-list">
            {historyLoading ? <div className="history-message">Loading conversations…</div> : sessions.length === 0 ? <div className="history-message">Your conversations will appear here.</div> : sessions.map((session) => (
              <div className={`history-row ${session.session_id === sessionId ? "active" : ""}`} key={session.session_id}>
                <button className="history-item" type="button" title={session.preview} aria-current={session.session_id === sessionId ? "page" : undefined} disabled={openingSessionId !== null || deletingSessionId !== null} onClick={() => void openConversation(session)}>
                  <span className="history-item-title">{session.preview}</span>
                  <span className="history-item-meta"><span>{formatHistoryDate(session.updated_at)}</span><span>{session.message_count} messages</span></span>
                </button>
                <button className="history-delete" type="button" title="Delete conversation" aria-label={`Delete conversation: ${session.preview}`} disabled={openingSessionId !== null || deletingSessionId !== null || sending} onClick={(event) => void deleteConversation(event, session)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {historyError && <div className="history-error" role="alert">{historyError}</div>}
          </div>
        </section>
        <div className="sidebar-bottom">
          <div className="reliability-block">
            <button className="sidebar-card" type="button" aria-expanded={showReliabilityDetails} onClick={() => setShowReliabilityDetails((open) => !open)}>
              <span className="sidebar-card-icon"><Zap size={16} /></span>
              <span><strong>Built for reliability</strong><small>Cache + automatic key failover</small></span>
            </button>
            {showReliabilityDetails && <div className="reliability-details" aria-live="polite">
              <div><span>Chat service</span><strong className={`detail-status ${health}`}>{health === "ready" ? "Operational" : health === "checking" ? "Checking" : "Offline"}</strong></div>
              <div><span>Provider keys</span><strong>{healthInfo ? `${healthInfo.keys_configured} configured` : "Unavailable"}</strong></div>
              <div><span>Response cache</span><strong>{healthInfo ? (healthInfo.cache_enabled ? "Enabled" : "Disabled") : "Unavailable"}</strong></div>
              <p>{healthInfo && healthInfo.keys_configured > 1 ? "Automatic failover is ready across configured keys." : "Configure more than one API key to enable key failover."}</p>
            </div>}
          </div>
          <div className="profile" onKeyDown={(event) => { if (event.key === "Escape") setShowProfileMenu(false); }}>
            <div className="avatar-small">G</div>
            <div className="profile-identity"><strong>Guest workspace</strong><small>Personal session</small></div>
            <button className="profile-menu" type="button" aria-label="Workspace options" aria-haspopup="true" aria-expanded={showProfileMenu} onClick={() => { setShowProfileMenu((open) => !open); setCopyStatus(""); }}>•••</button>
            {showProfileMenu && <div className="profile-popover" role="group" aria-label="Workspace options">
              <strong>Guest workspace</strong>
              <code>{sessionId}</code>
              <button type="button" onClick={() => void copySessionId()}>Copy session ID</button>
              {copyStatus && <small className="copy-status" role="status">{copyStatus}</small>}
              <button type="button" onClick={startNewChat}>New conversation</button>
            </div>}
          </div>
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
                  <div className="assistant-content"><div className="assistant-name">NAKSH assistant <span>AI</span></div><div className="assistant-text">{message.content}</div>
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
            <textarea data-testid="chat-input" aria-label="Your message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="Message your assistant…" rows={1} maxLength={4000} disabled={sending || openingSessionId !== null} />
            <div className="composer-tools"><div className="composer-hints"><button type="button" className={`prompt-toggle ${showPrompt ? "active" : ""}`} onClick={() => setShowPrompt(!showPrompt)} title="Set system prompt"><Sparkles size={14} /><span>System prompt</span></button><span className="key-hint"><kbd>↵</kbd> to send</span></div><div className="send-side"><span className="char-count">{draft.length ? `${draft.length}/4000` : ""}</span><button className="send-button" data-testid="send-button" type="submit" disabled={!draft.trim() || sending || openingSessionId !== null} aria-label="Send message"><ArrowUp size={18} /></button></div></div>
          </form>
          <div className="footer-note">AI can make mistakes. Verify important information.</div>
        </footer>
      </main>
    </div>
  );
}
