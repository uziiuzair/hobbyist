/**
 * Queues Provider
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import * as api from "../api.js";
import { useProject } from "./project-provider.js";

// Cloudflare's own bounds, which the daemon rejects outside of rather than
// clamping to. Named here so a form can refuse locally with the same numbers
// instead of learning them from a round trip.
const MIN_RETENTION_SECONDS = 60;
const MAX_RETENTION_SECONDS = 1_209_600;

/**
 * Every queue in the current project, plus the messages in a selected one.
 *
 * The list comes from the project-scoped route rather than the resource list:
 * depth, oldest message age and the consumer worker are joins the daemon
 * computes in one pass, and fanning out per queue from here would be several
 * requests for the same answer.
 *
 * Mount inside ProjectProvider.
 */
interface QueuesContextType {
  queues: api.QueueEntry[] | null;
  error: string | null;
  refresh: () => void;

  selected: string | null;
  select: (resourceId: string | null) => void;
  active: api.QueueEntry | undefined;

  messages: api.QueueMessage[] | null;
  messagesError: string | null;
  peek: (limit?: number) => Promise<void>;

  send: (body: unknown, delaySeconds?: number) => Promise<void>;
  purge: () => Promise<number>;
  setRetention: (seconds: number) => Promise<void>;
  retentionBounds: { min: number; max: number };
}

const NOT_MOUNTED = (): Promise<never> =>
  Promise.reject(new Error("no QueuesProvider"));

const QueuesContext = createContext<QueuesContextType>({
  queues: null,
  error: null,
  refresh: () => {},
  selected: null,
  select: () => {},
  active: undefined,
  messages: null,
  messagesError: null,
  peek: NOT_MOUNTED,
  send: NOT_MOUNTED,
  purge: NOT_MOUNTED,
  setRetention: NOT_MOUNTED,
  retentionBounds: { min: MIN_RETENTION_SECONDS, max: MAX_RETENTION_SECONDS },
});

export const QueuesProvider = ({
  children,
}: {
  children?: React.ReactNode;
}) => {
  const { project } = useProject();
  const projectName = project?.name ?? null;

  const [queues, setQueues] = useState<api.QueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<api.QueueMessage[] | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (projectName === null) return;
    api
      .listQueues(projectName)
      .then((result) => {
        setQueues(result.queues);
        setError(null);
      })
      .catch((err: unknown) => {
        setQueues([]);
        setError(
          err instanceof api.ApiError
            ? err.message
            : "Could not reach the daemon",
        );
      });
  }, [projectName]);

  useEffect(() => {
    setQueues(null);
    setSelected(null);
    setMessages(null);
    setMessagesError(null);
    refresh();
  }, [projectName, refresh]);

  const active = useMemo(
    () => (queues ?? []).find((q) => q.resource.id === selected),
    [queues, selected],
  );

  /**
   * Reads messages without claiming them.
   *
   * peek never touches a message's lease, so a message read here is still
   * exactly as deliverable afterwards as it was before. That is the whole
   * reason this is safe to call from an interface: looking at a queue must
   * not consume it.
   */
  const peek = useCallback(
    async (limit?: number): Promise<void> => {
      if (selected === null) return;
      try {
        const result = await api.peekQueue(selected, limit);
        setMessages(result.messages);
        setMessagesError(null);
      } catch (err) {
        setMessages([]);
        setMessagesError(
          err instanceof api.ApiError ? err.message : "Could not read messages",
        );
      }
    },
    [selected],
  );

  // Selecting a queue and reading it are one action from the outside, so the
  // peek follows the selection rather than waiting for a second call.
  useEffect(() => {
    if (selected === null) {
      setMessages(null);
      setMessagesError(null);
      return;
    }
    void peek();
  }, [selected, peek]);

  /**
   * Sends the value itself, not a pre-encoded string: the daemon runs the
   * codec once, so nothing here needs to know the queue's wire format.
   */
  const send = useCallback(
    async (body: unknown, delaySeconds?: number): Promise<void> => {
      if (selected === null) return NOT_MOUNTED();
      await api.sendQueueMessage(selected, body, delaySeconds);
      await peek();
      refresh();
    },
    [selected, peek, refresh],
  );

  /**
   * Drops every message and returns how many were lost.
   *
   * The count is returned rather than swallowed because a queue that cannot
   * say how much it dropped is a queue that silently lied about it. This is
   * destructive and has no undo: whatever calls it should have confirmed
   * first.
   */
  const purge = useCallback(async (): Promise<number> => {
    if (selected === null) return NOT_MOUNTED();
    const { purged } = await api.purgeQueue(selected);
    await peek();
    refresh();
    return purged;
  }, [selected, peek, refresh]);

  const setRetention = useCallback(
    async (seconds: number): Promise<void> => {
      if (selected === null) return NOT_MOUNTED();
      await api.setQueueRetention(selected, seconds);
      refresh();
    },
    [selected, refresh],
  );

  return (
    <QueuesContext.Provider
      value={{
        queues: queues,
        error: error,
        refresh: refresh,
        selected: selected,
        select: setSelected,
        active: active,
        messages: messages,
        messagesError: messagesError,
        peek: peek,
        send: send,
        purge: purge,
        setRetention: setRetention,
        retentionBounds: {
          min: MIN_RETENTION_SECONDS,
          max: MAX_RETENTION_SECONDS,
        },
      }}
    >
      {children}
    </QueuesContext.Provider>
  );
};

export const useQueues = () => {
  return useContext(QueuesContext);
};
