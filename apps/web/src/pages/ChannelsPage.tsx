import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, patchJson, postJson } from "../lib/api";
import { useAuth } from "../lib/auth";
import { classNames } from "../lib/format";

type Channel = {
  id: string;
  name: string;
  type: string;
  lastMessageSeq: number;
  membership: { canWrite: boolean; lastReadSeq: number; unreadCount: number } | null;
};

type ChannelMessage = {
  id: string;
  channelId: string;
  seq: number;
  body: string;
  clientMessageId?: string | null;
  user: { id: string; displayName: string; username: string };
  createdAt: string;
  pending?: boolean;
};

function typeLabel(type: string) {
  const labels: Record<string, string> = {
    DEPARTMENT: "Departments",
    MACHINE_GROUP: "Machine Groups",
    MACHINE: "Machines",
    CUSTOM: "Custom"
  };
  return labels[type] ?? type;
}

function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ChannelsPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [activeChannelId, setActiveChannelId] = useState("");
  const [message, setMessage] = useState("");
  const [pendingMessages, setPendingMessages] = useState<Record<string, ChannelMessage[]>>({});

  const channelsQuery = useQuery({
    queryKey: ["channels"],
    queryFn: () => api<any>("/api/channels")
  });
  const channels = (channelsQuery.data?.data ?? []) as Channel[];
  const activeChannel = channels.find((channel) => channel.id === activeChannelId) ?? channels[0];

  useEffect(() => {
    if (!activeChannelId && channels[0]) setActiveChannelId(channels[0].id);
  }, [activeChannelId, channels]);

  const messagesQuery = useInfiniteQuery({
    queryKey: ["channel-messages", activeChannel?.id],
    enabled: Boolean(activeChannel?.id),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api<any>(`/api/channels/${activeChannel!.id}/messages?limit=50${pageParam ? `&beforeSeq=${pageParam}` : ""}`),
    getNextPageParam: (lastPage) => lastPage.data?.nextBeforeSeq ?? undefined
  });

  const messages = useMemo(() => {
    const serverMessages = (messagesQuery.data?.pages ?? []).flatMap((page: any) => page.data?.messages ?? []) as ChannelMessage[];
    const pending = pendingMessages[activeChannel?.id ?? ""] ?? [];
    const seenClientIds = new Set(serverMessages.map((item) => item.clientMessageId).filter(Boolean));
    return [...serverMessages, ...pending.filter((item) => !seenClientIds.has(item.clientMessageId))].sort((a, b) => a.seq - b.seq);
  }, [messagesQuery.data, pendingMessages, activeChannel?.id]);

  useEffect(() => {
    if (!activeChannel?.id || !messages.length) return;
    const lastSeq = Math.max(...messages.filter((item) => !item.pending).map((item) => item.seq), 0);
    if (lastSeq > (activeChannel.membership?.lastReadSeq ?? 0)) {
      patchJson(`/api/channels/${activeChannel.id}/read`, { lastReadSeq: lastSeq })
        .then(() => queryClient.invalidateQueries({ queryKey: ["channels"] }))
        .catch(() => undefined);
    }
  }, [activeChannel?.id, activeChannel?.membership?.lastReadSeq, messages, queryClient]);

  const sendMessage = useMutation({
    mutationFn: (input: { body: string; clientMessageId: string }) => postJson<any>(`/api/channels/${activeChannel!.id}/messages`, input),
    onMutate: ({ body, clientMessageId }) => {
      const channelId = activeChannel!.id;
      const optimistic: ChannelMessage = {
        id: clientMessageId,
        channelId,
        seq: Number.MAX_SAFE_INTEGER,
        body,
        clientMessageId,
        user: { id: session?.user.id ?? "me", displayName: session?.user.displayName ?? "Me", username: session?.user.username ?? "me" },
        createdAt: new Date().toISOString(),
        pending: true
      };
      setPendingMessages((current) => ({ ...current, [channelId]: [...(current[channelId] ?? []), optimistic] }));
    },
    onSettled: (_result, _error, variables) => {
      const channelId = activeChannel!.id;
      setPendingMessages((current) => ({ ...current, [channelId]: (current[channelId] ?? []).filter((item) => item.clientMessageId !== variables?.clientMessageId) }));
      queryClient.invalidateQueries({ queryKey: ["channels"] });
      queryClient.invalidateQueries({ queryKey: ["channel-messages", channelId] });
    }
  });

  const submit = () => {
    const body = message.trim();
    if (!body || !activeChannel?.membership?.canWrite || sendMessage.isPending) return;
    setMessage("");
    sendMessage.mutate({ body, clientMessageId: crypto.randomUUID() });
  };

  const groupedChannels = useMemo(() => {
    const groups = new Map<string, Channel[]>();
    for (const channel of channels) groups.set(channel.type, [...(groups.get(channel.type) ?? []), channel]);
    return Array.from(groups, ([type, items]) => ({ type, items }));
  }, [channels]);

  return (
    <div className="channels-page">
      <aside className="channels-list-panel">
        <header>
          <span>Communication</span>
          <h1>Channels</h1>
        </header>
        <div className="channels-list">
          {groupedChannels.map((group) => (
            <section key={group.type} className="channels-group">
              <strong>{typeLabel(group.type)}</strong>
              {group.items.map((channel) => (
                <button key={channel.id} className={classNames("channel-list-item", activeChannel?.id === channel.id && "active")} onClick={() => setActiveChannelId(channel.id)}>
                  <span>{channel.name}</span>
                  {(channel.membership?.unreadCount ?? 0) > 0 && <em>{channel.membership?.unreadCount}</em>}
                </button>
              ))}
            </section>
          ))}
          {channels.length === 0 && <div className="empty-state small">No channels assigned yet.</div>}
        </div>
      </aside>
      <section className="channel-conversation-panel">
        {activeChannel ? (
          <>
            <header className="channel-conversation-header">
              <div>
                <span>{typeLabel(activeChannel.type)}</span>
                <h2>{activeChannel.name}</h2>
              </div>
            </header>
            <div className="channel-message-scroll">
              {messagesQuery.hasNextPage && <button className="channel-load-more" onClick={() => messagesQuery.fetchNextPage()} disabled={messagesQuery.isFetchingNextPage}>Load older</button>}
              {messages.map((item) => {
                const mine = item.user.id === session?.user.id;
                return (
                  <article key={`${item.id}-${item.clientMessageId ?? item.seq}`} className={classNames("channel-message", mine && "mine", item.pending && "pending")}>
                    <div>
                      <strong>{item.user.displayName}</strong>
                      <span>{item.pending ? "sending..." : timeLabel(item.createdAt)}</span>
                    </div>
                    <p>{item.body}</p>
                  </article>
                );
              })}
              {!messages.length && <div className="empty-state small">No messages yet.</div>}
            </div>
            <footer className="channel-composer">
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={`Message ${activeChannel.name}`} disabled={!activeChannel.membership?.canWrite} />
              <button onClick={submit} disabled={!message.trim() || !activeChannel.membership?.canWrite || sendMessage.isPending}>Send</button>
            </footer>
          </>
        ) : (
          <div className="empty-state">Select a channel to start messaging.</div>
        )}
      </section>
    </div>
  );
}
