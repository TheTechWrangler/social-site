export interface MessageLike {
  id: number;
  createdAt?: string;
  [key: string]: any;
}

export function mergeMessages<T extends MessageLike>(current: T[], incoming: T[]): T[] {
  const byId = new Map<number, T>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, { ...byId.get(message.id), ...message });
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function highestObservedMessageId(messages: MessageLike[]): number | null {
  let highest: number | null = null;
  for (const message of messages) {
    if (Number.isSafeInteger(message.id) && (highest === null || message.id > highest)) highest = message.id;
  }
  return highest;
}

export function reconcileConversationPreview(
  conversations: any[],
  conversationId: number,
  lastMessage: any,
): any[] {
  return conversations
    .map(conversation => conversation.id === conversationId
      ? { ...conversation, lastMessage }
      : conversation)
    .sort((a, b) => {
      const aTime = a.lastMessage?.createdAt ?? '';
      const bTime = b.lastMessage?.createdAt ?? '';
      return bTime.localeCompare(aTime)
        || Number(b.lastMessage?.id || 0) - Number(a.lastMessage?.id || 0)
        || b.id - a.id;
    });
}

export function clearConversationUnread(conversations: any[], conversationId: number): any[] {
  return conversations.map(conversation => conversation.id === conversationId
    ? { ...conversation, unreadCount: 0 }
    : conversation);
}

export function setConversationDraft(
  drafts: Record<number, string>,
  conversationId: number,
  body: string,
): Record<number, string> {
  return { ...drafts, [conversationId]: body };
}

