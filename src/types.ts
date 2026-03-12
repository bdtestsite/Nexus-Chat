export interface User {
  id: string;
  username: string;
  avatar: string;
  role?: 'owner' | 'user';
  last_seen?: string;
  isOnline?: boolean;
}

export interface Reaction {
  message_id: string;
  user_id: string;
  emoji: string;
}

export interface Message {
  id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  timestamp: string;
  type: 'text' | 'system' | 'voice';
  reactions?: Reaction[];
  is_read?: number;
}

export type CallType = 'audio' | 'video';

export interface SignalData {
  type: 'offer' | 'answer' | 'candidate';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}
