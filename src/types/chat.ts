// Google Chat Webhook Types (Cards v2, Event payloads)

export interface GoogleChatAttachment {
  name: string;
  contentName: string;
  contentType: string;
  source: 'DRIVE_FILE' | 'UPLOADED_CONTENT';
  thumbnailUri?: string;
  downloadUri?: string;
}

export interface GoogleChatMessage {
  name?: string;
  text?: string;
  sender?: {
    name: string;
    displayName: string;
    email?: string;
    type: string;
  };
  createTime?: string;
  space?: {
    name: string;
    type: string;
    displayName?: string;
  };
  thread?: {
    name: string;
    threadKey?: string;
  };
  attachment?: GoogleChatAttachment[];
  actionResponse?: {
    type: string;
  };
}

export interface GoogleChatEvent {
  type: 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE' | 'MESSAGE' | 'CARD_CLICKED';
  eventTime: string;
  message?: GoogleChatMessage;
  user?: {
    name: string;
    displayName: string;
    email?: string;
    type: string;
  };
  space?: {
    name: string;
    type: string;
    displayName?: string;
  };
  action?: {
    actionMethodName: string;
    parameters?: Array<{ key: string; value: string }>;
  };
  configCompleteRedirectUrl?: string;
}
