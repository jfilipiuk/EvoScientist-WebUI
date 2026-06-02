"use client";

import { useCallback, useState } from "react";
import { useStream } from "@langchain/langgraph-sdk/react";
import { type Message, type Assistant } from "@langchain/langgraph-sdk";
import { v4 as uuidv4 } from "uuid";
import type { UseStreamThread } from "@langchain/langgraph-sdk/react";
import type { TodoItem } from "@/app/types/types";
import { useClient } from "@/providers/ClientProvider";
import { useQueryState } from "nuqs";
import {
  extractSubAgentSteps,
  type SubAgentStep,
} from "@/lib/subAgentActivity";

export type StateType = {
  messages: Message[];
  todos: TodoItem[];
  files: Record<string, string>;
  email?: {
    id?: string;
    subject?: string;
    page_content?: string;
  };
  ui?: any;
};

export function useChat({
  activeAssistant,
  onHistoryRevalidate,
  thread,
}: {
  activeAssistant: Assistant | null;
  onHistoryRevalidate?: () => void;
  thread?: UseStreamThread<StateType>;
}) {
  const [threadId, setThreadId] = useQueryState("threadId");
  const client = useClient();

  // Live sub-agent activity captured from subgraph stream events, keyed by the
  // subgraph namespace (e.g. "tools:<id>"). Ephemeral: it resets when the chat
  // session remounts on thread switch, and is not persisted (lost on reload).
  const [subAgentActivity, setSubAgentActivity] = useState<
    Record<string, SubAgentStep[]>
  >({});

  const stream = useStream<StateType>({
    assistantId: activeAssistant?.assistant_id || "",
    client: client ?? undefined,
    reconnectOnMount: true,
    threadId: threadId ?? null,
    onThreadId: setThreadId,
    defaultHeaders: { "x-auth-scheme": "langsmith" },
    // Enable fetching state history when switching to existing threads
    fetchStateHistory: true,
    // Revalidate thread list when stream finishes, errors, or creates new thread
    onFinish: onHistoryRevalidate,
    onError: onHistoryRevalidate,
    onCreated: onHistoryRevalidate,
    // Capture sub-agent (subgraph) node outputs as they stream. `namespace` is
    // non-empty (e.g. ["tools:<id>"]) for subgraphs and empty for the main graph,
    // which we skip.
    onUpdateEvent: (data, options) => {
      const ns = options?.namespace;
      if (!ns || ns.length === 0) return;
      const steps = extractSubAgentSteps(data);
      if (steps.length === 0) return;
      const key = ns.join("|");
      setSubAgentActivity((prev) => ({
        ...prev,
        [key]: [...(prev[key] ?? []), ...steps],
      }));
    },
    experimental_thread: thread,
  });

  const sendMessage = useCallback(
    (content: string) => {
      const newMessage: Message = { id: uuidv4(), type: "human", content };
      stream.submit(
        { messages: [newMessage] },
        {
          optimisticValues: (prev) => ({
            messages: [...(prev.messages ?? []), newMessage],
          }),
          config: { ...(activeAssistant?.config ?? {}), recursion_limit: 100 },
          streamSubgraphs: true,
          streamMode: ["updates"],
        }
      );
      // Update thread list immediately when sending a message
      onHistoryRevalidate?.();
    },
    [stream, activeAssistant?.config, onHistoryRevalidate]
  );

  const setFiles = useCallback(
    async (files: Record<string, string>) => {
      if (!threadId) return;
      // TODO: missing a way how to revalidate the internal state
      // I think we do want to have the ability to externally manage the state
      await client.threads.updateState(threadId, { values: { files } });
    },
    [client, threadId]
  );

  const resumeInterrupt = useCallback(
    (value: any) => {
      stream.submit(null, {
        command: { resume: value },
        streamSubgraphs: true,
        streamMode: ["updates"],
      });
      // Update thread list when resuming from interrupt
      onHistoryRevalidate?.();
    },
    [stream, onHistoryRevalidate]
  );

  const stopStream = useCallback(() => {
    stream.stop();
  }, [stream]);

  return {
    stream,
    todos: stream.values.todos ?? [],
    files: stream.values.files ?? {},
    email: stream.values.email,
    ui: stream.values.ui,
    setFiles,
    messages: stream.messages,
    isLoading: stream.isLoading,
    isThreadLoading: stream.isThreadLoading,
    interrupt: stream.interrupt,
    sendMessage,
    stopStream,
    resumeInterrupt,
    subAgentActivity,
  };
}
