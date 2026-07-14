import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getToken, patchJson, postJson } from "../lib/api";
import { useAuth } from "../lib/auth";
import { notifyAppError } from "../lib/errorToast";
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
  actorNameText?: string | null;
  attachments?: ChannelAttachment[];
  user: { id: string; displayName: string; username: string } | null;
  createdAt: string;
  pending?: boolean;
};

type ChannelAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

type AttachmentPayload = Omit<ChannelAttachment, "id"> & { dataBase64: string };

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

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

function sizeLabel(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function encodeFile(file: File): Promise<AttachmentPayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) return reject(new Error(`Could not encode ${file.name}.`));
      resolve({
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        dataBase64: result.slice(separator + 1)
      });
    };
    reader.readAsDataURL(file);
  });
}

function MessageAttachment({ attachment, pending }: { attachment: ChannelAttachment; pending?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (pending || attachment.id.startsWith("pending-")) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    fetch(`/api/channels/attachments/${attachment.id}`, {
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : undefined,
      signal: controller.signal
    })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load attachment.");
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, pending]);

  const isImage = attachment.mimeType.startsWith("image/");
  return (
    <div className="channel-message-attachment">
      {isImage && url && <img src={url} alt={attachment.fileName} />}
      {url ? (
        <a href={url} download={attachment.fileName}>{attachment.fileName} <span>{sizeLabel(attachment.sizeBytes)}</span></a>
      ) : (
        <span>{pending ? "Uploading attachment..." : attachment.fileName} <small>{sizeLabel(attachment.sizeBytes)}</small></span>
      )}
    </div>
  );
}

export function ChannelsPage() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [activeChannelId, setActiveChannelId] = useState("");
  const [message, setMessage] = useState("");
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [pendingMessages, setPendingMessages] = useState<Record<string, ChannelMessage[]>>({});
  const attachmentInputRef = useRef<HTMLInputElement>(null);

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
    mutationFn: (input: { body: string; clientMessageId: string; attachments: AttachmentPayload[] }) => postJson<any>(`/api/channels/${activeChannel!.id}/messages`, input),
    onMutate: ({ body, clientMessageId, attachments }) => {
      const channelId = activeChannel!.id;
      const optimistic: ChannelMessage = {
        id: clientMessageId,
        channelId,
        seq: Number.MAX_SAFE_INTEGER,
        body,
        clientMessageId,
        attachments: attachments.map((attachment, index) => ({
          id: `pending-${clientMessageId}-${index}`,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes
        })),
        user: { id: session?.user.id ?? "me", displayName: session?.user.displayName ?? "Me", username: session?.user.username ?? "me" },
        createdAt: new Date().toISOString(),
        pending: true
      };
      setPendingMessages((current) => ({ ...current, [channelId]: [...(current[channelId] ?? []), optimistic] }));
    },
    onSuccess: () => {
      setMessage("");
      setAttachmentFiles([]);
    },
    onError: (error) => notifyAppError(error instanceof Error ? error.message : "Could not send message."),
    onSettled: (_result, _error, variables) => {
      const channelId = activeChannel!.id;
      setPendingMessages((current) => ({ ...current, [channelId]: (current[channelId] ?? []).filter((item) => item.clientMessageId !== variables?.clientMessageId) }));
      queryClient.invalidateQueries({ queryKey: ["channels"] });
      queryClient.invalidateQueries({ queryKey: ["channel-messages", channelId] });
    }
  });

  const addAttachments = (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    const totalBytes = [...attachmentFiles, ...selected].reduce((total, file) => total + file.size, 0);
    if (attachmentFiles.length + selected.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      notifyAppError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.`);
    } else if (selected.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      notifyAppError("Each attachment must be 5 MB or smaller.");
    } else if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      notifyAppError("Message attachments must total 8 MB or less.");
    } else {
      setAttachmentFiles((current) => [...current, ...selected]);
    }
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
  };

  const submit = async () => {
    const body = message.trim();
    if ((!body && !attachmentFiles.length) || !activeChannel?.membership?.canWrite || sendMessage.isPending) return;
    try {
      const attachments = await Promise.all(attachmentFiles.map(encodeFile));
      sendMessage.mutate({ body, attachments, clientMessageId: crypto.randomUUID() });
    } catch (error) {
      notifyAppError(error instanceof Error ? error.message : "Could not prepare the attachment.");
    }
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
                const mine = Boolean(item.user?.id && item.user.id === session?.user.id);
                const actorName = item.user?.displayName ?? item.actorNameText ?? "System";
                return (
                  <article key={`${item.id}-${item.clientMessageId ?? item.seq}`} className={classNames("channel-message", mine && "mine", item.pending && "pending")}>
                    <div>
                      <strong>{actorName}</strong>
                      <span>{item.pending ? "sending..." : timeLabel(item.createdAt)}</span>
                    </div>
                    {item.body && <p>{item.body}</p>}
                    {item.attachments?.length ? <div className="channel-message-attachments">{item.attachments.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} pending={item.pending} />)}</div> : null}
                  </article>
                );
              })}
              {!messages.length && <div className="empty-state small">No messages yet.</div>}
            </div>
            <footer className="channel-composer">
              <input ref={attachmentInputRef} className="channel-attachment-input" type="file" multiple onChange={(event) => addAttachments(event.target.files)} />
              {attachmentFiles.length > 0 && <div className="channel-attachment-queue">{attachmentFiles.map((file, index) => <span key={`${file.name}-${index}`}>{file.name} <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttachmentFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}>Remove</button></span>)}</div>}
              <div className="channel-composer-row">
                <button className="channel-attach-button" type="button" onClick={() => attachmentInputRef.current?.click()} disabled={!activeChannel.membership?.canWrite || sendMessage.isPending}>Attach</button>
                <textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder={`Message ${activeChannel.name}`} disabled={!activeChannel.membership?.canWrite || sendMessage.isPending} />
                <button onClick={() => void submit()} disabled={(!message.trim() && !attachmentFiles.length) || !activeChannel.membership?.canWrite || sendMessage.isPending}>Send</button>
              </div>
            </footer>
          </>
        ) : (
          <div className="empty-state">Select a channel to start messaging.</div>
        )}
      </section>
    </div>
  );
}
