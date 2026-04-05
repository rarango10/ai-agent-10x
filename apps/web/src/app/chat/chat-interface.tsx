"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: string;
  content: string;
  created_at?: string;
}

interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  message: string;
}

interface Props {
  agentName: string;
  initialMessages: Message[];
}

export function ChatInterface({ agentName, initialMessages }: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [resolving, setResolving] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending]);

  async function resolvePending(action: "approve" | "reject") {
    if (!pending) return;
    setResolving(true);
    try {
      const res = await fetch(`/api/tool-calls/${pending.toolCallId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        result?: Record<string, unknown>;
      };

      if (action === "reject") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "Acción cancelada." },
        ]);
      } else if (action === "approve") {
        if (data.ok && data.result) {
          const r = data.result;
          let text = "Acción completada.";
          if (typeof r.issue_url === "string") {
            text = `Issue creado: ${r.issue_url}`;
          } else if (typeof r.html_url === "string") {
            text = `Repositorio creado: ${r.html_url}`;
          }
          setMessages((prev) => [...prev, { role: "assistant", content: text }]);
        } else if (data.error) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `No se pudo ejecutar: ${data.error}` },
          ]);
        }
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error al confirmar la acción." },
      ]);
    } finally {
      setPending(null);
      setResolving(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading || pending) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    setPending(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();

      if (data.pendingConfirmation) {
        setPending({
          toolCallId: data.pendingConfirmation.toolCallId,
          toolName: data.pendingConfirmation.toolName,
          message: data.pendingConfirmation.message,
        });
      } else if (data.response) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error al procesar tu mensaje. Intenta de nuevo." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-sm text-neutral-400 py-20">
              <p className="text-lg font-medium text-neutral-600 dark:text-neutral-300">
                ¡Hola! Soy {agentName}
              </p>
              <p className="mt-1">Escribe un mensaje para comenzar.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          ))}
          {pending && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                <p className="font-medium text-amber-900 dark:text-amber-50">
                  Confirmación requerida
                </p>
                <p className="mt-2 text-amber-900/90 dark:text-amber-100/90">
                  {pending.message}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={resolving}
                    onClick={() => resolvePending("approve")}
                    className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    Aprobar
                  </button>
                  <button
                    type="button"
                    disabled={resolving}
                    onClick={() => resolvePending("reject")}
                    className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm dark:bg-neutral-800">
                <span className="animate-pulse">Pensando...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <form
          onSubmit={handleSend}
          className="mx-auto flex max-w-2xl gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              pending ? "Responde con Aprobar o Cancelar arriba…" : "Escribe tu mensaje…"
            }
            disabled={loading || !!pending}
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={loading || !input.trim() || !!pending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
