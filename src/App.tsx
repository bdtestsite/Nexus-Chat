import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { 
  MessageSquare, 
  Phone, 
  Video, 
  Send, 
  User as UserIcon, 
  Search, 
  MoreVertical,
  X,
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  PhoneOff,
  Smile,
  Square,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Message, CallType, Reaction } from './types';
import { GoogleGenAI } from "@google/genai";

const SOCKET_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
const AI_USER_ID = 'nexus-ai-bot';
const GEMINI_API_KEY = "AIzaSyD1vkGMvA8FYehBRPZjGz4QUyYhdJQidTI";

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  
  return (
    <AppContent currentUser={currentUser} setCurrentUser={setCurrentUser} />
  );
}

function AppContent({ currentUser, setCurrentUser }: { currentUser: User | null, setCurrentUser: (u: User | null) => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(true);
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [avatarInput, setAvatarInput] = useState('');
  const [roleSecretInput, setRoleSecretInput] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  
  // Voice Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Call State
  const [incomingCall, setIncomingCall] = useState<{ senderId: string, callType: CallType } | null>(null);
  const [activeCall, setActiveCall] = useState<{ targetId: string, callType: CallType, isCaller: boolean } | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isRinging, setIsRinging] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const filteredUsers = users.filter(u => 
    u.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Sync streams to video elements
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, activeCall]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream, activeCall]);

  // Initialize WebSocket
  useEffect(() => {
    if (!currentUser) return;

    const socket = new WebSocket(SOCKET_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', userId: currentUser.id }));
    };

    socket.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'chat':
          if (selectedUser && (data.senderId === selectedUser.id || data.receiverId === selectedUser.id)) {
            setMessages(prev => [...prev, {
              id: data.id,
              sender_id: data.senderId,
              receiver_id: data.receiverId,
              content: data.content,
              timestamp: data.timestamp,
              type: data.msgType || 'text',
              reactions: data.reactions || [],
              is_read: data.is_read || 0
            }]);

            // If we are the receiver and the chat is open, send read receipt
            if (data.receiverId === currentUser.id && selectedUser.id === data.senderId) {
              socket.send(JSON.stringify({
                type: 'read-receipt',
                senderId: data.senderId,
                userId: currentUser.id
              }));
            }
          }

          // AI Bot Response Logic
          if (data.receiverId === AI_USER_ID && data.senderId === currentUser.id) {
            setIsAIThinking(true);
            getAIResponse(data.content).then(aiResponse => {
              socket.send(JSON.stringify({
                type: 'chat',
                senderId: AI_USER_ID,
                receiverId: currentUser.id,
                content: aiResponse,
                msgType: 'text'
              }));
              setIsAIThinking(false);
            }).catch(err => {
              console.error('AI Error:', err);
              setIsAIThinking(false);
            });
          }
          break;

        case 'call-request':
          setIncomingCall({ senderId: data.senderId, callType: data.callType });
          break;

        case 'call-response':
          if (data.accepted) {
            setIsRinging(false);
            startWebRTC(data.senderId, true, activeCall?.callType || 'video');
          } else {
            setIsRinging(false);
            endCall();
            alert('Call declined');
          }
          break;

        case 'signal':
          handleSignalingData(data);
          break;

        case 'status-update':
          setUsers(prev => prev.map(u => 
            u.id === data.userId ? { ...u, isOnline: data.isOnline } : u
          ));
          if (selectedUser?.id === data.userId) {
            setSelectedUser(prev => prev ? { ...prev, isOnline: data.isOnline } : null);
          }
          break;

        case 'typing':
          if (selectedUser?.id === data.senderId) {
            setIsTyping(data.isTyping);
          }
          break;

        case 'reaction-update':
          setMessages(prev => prev.map(m => 
            m.id === data.messageId ? { ...m, reactions: data.reactions as Reaction[] } : m
          ));
          break;

        case 'read-update':
          setMessages(prev => prev.map(m => 
            (m.sender_id === data.senderId && m.receiver_id === data.receiverId) ? { ...m, is_read: 1 } : m
          ));
          break;
      }
    };

    return () => {
      socket.close();
    };
  }, [currentUser, selectedUser, activeCall]);

  useEffect(() => {
    const handleClickOutside = () => setLongPressedMessageId(null);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  // Fetch users
  useEffect(() => {
    if (currentUser) {
      axios.get('/api/users')
        .then(res => {
          const fetchedUsers = res.data.filter((u: User) => u.id !== currentUser?.id);
          const aiBot: User = {
            id: AI_USER_ID,
            username: 'Nexus AI',
            avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=NexusAI',
            role: 'user',
            isOnline: true
          };
          setUsers([aiBot, ...fetchedUsers]);
        })
        .catch(err => console.error('Error fetching users:', err));
    }
  }, [currentUser]);

  // Fetch messages when selected user changes
  useEffect(() => {
    if (currentUser && selectedUser) {
      axios.get(`/api/messages/${currentUser.id}/${selectedUser.id}`)
        .then(res => {
          setMessages(res.data);
          // Send read receipt for all unread messages from this user
          if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              type: 'read-receipt',
              senderId: selectedUser.id,
              userId: currentUser.id
            }));
          }
        })
        .catch(err => console.error('Error fetching messages:', err));
    }
  }, [currentUser, selectedUser]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!usernameInput.trim() || !passwordInput.trim()) {
      alert('Please enter both username and password');
      return;
    }

    const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';
    const payload = {
      username: usernameInput,
      password: passwordInput,
      avatar: avatarInput || `https://api.dicebear.com/7.x/avataaars/svg?seed=${usernameInput}`,
      roleSecret: roleSecretInput
    };

    try {
      const res = await axios.post(endpoint, payload);
      setCurrentUser(res.data);
      setIsAuthModalOpen(false);
    } catch (err: any) {
      console.error('Auth error:', err);
      alert(err.response?.data?.error || 'Authentication failed. Please try again.');
    }
  };

  const handleGuestLogin = async () => {
    const guestUsername = `Guest_${Math.floor(Math.random() * 10000)}`;
    const guestPassword = 'guest_password_123';
    
    try {
      // Try to register first
      try {
        await axios.post('/api/auth/register', {
          username: guestUsername,
          password: guestPassword
        });
      } catch (e) {
        // Ignore if already exists
      }
      
      const res = await axios.post('/api/auth/login', {
        username: guestUsername,
        password: guestPassword
      });
      setCurrentUser(res.data);
      setIsAuthModalOpen(false);
    } catch (err) {
      console.error('Guest login error:', err);
      alert('Guest login failed. Please try manual registration.');
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    // This is now replaced by handleAuth
    handleAuth(e);
  };

  const handleUpdateProfile = async () => {
    if (!currentUser || !avatarInput.trim()) return;
    try {
      await axios.post('/api/users/profile', { userId: currentUser.id, avatar: avatarInput });
      setCurrentUser({ ...currentUser, avatar: avatarInput });
      setIsProfileModalOpen(false);
    } catch (err) {
      alert('Failed to update profile');
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!currentUser || currentUser.role !== 'owner') return;
    if (!confirm('Are you sure you want to delete this user? All their messages will be deleted.')) return;
    
    try {
      await axios.delete(`/api/admin/users/${userId}`, { data: { adminId: currentUser.id } });
      setUsers(prev => prev.filter(u => u.id !== userId));
      if (selectedUser?.id === userId) setSelectedUser(null);
    } catch (err) {
      alert('Failed to delete user');
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setIsAuthModalOpen(true);
    setUsernameInput('');
    passwordInput && setPasswordInput('');
    socketRef.current?.close();
  };

  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [longPressedMessageId, setLongPressedMessageId] = useState<string | null>(null);
  const [isAIThinking, setIsAIThinking] = useState(false);

  const getAIResponse = async (prompt: string) => {
    try {
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });
      return response.text || "I'm sorry, I couldn't process that request.";
    } catch (err) {
      console.error('Gemini API Error:', err);
      return "Sorry, I'm having trouble connecting to my brain right now. Please check the API key.";
    }
  };

  const sendReaction = (messageId: string, emoji: string) => {
    if (!socketRef.current || !currentUser || !selectedUser) return;
    socketRef.current.send(JSON.stringify({
      type: 'reaction',
      messageId,
      userId: currentUser.id,
      emoji,
      targetId: selectedUser.id
    }));
    setLongPressedMessageId(null);
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value);
    
    if (!selectedUser || !currentUser) return;

    // Send typing start
    socketRef.current?.send(JSON.stringify({
      type: 'typing',
      senderId: currentUser.id,
      targetId: selectedUser.id,
      isTyping: true
    }));

    // Clear existing timeout
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    // Set timeout to send typing stop
    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current?.send(JSON.stringify({
        type: 'typing',
        senderId: currentUser.id,
        targetId: selectedUser.id,
        isTyping: false
      }));
    }, 2000);
  };

  const sendMessage = async () => {
    if (!inputText.trim() || !selectedUser || !currentUser) return;

    const messageContent = inputText;
    setInputText('');

    socketRef.current?.send(JSON.stringify({
      type: 'chat',
      senderId: currentUser.id,
      receiverId: selectedUser.id,
      content: messageContent,
      msgType: 'text'
    }));
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        sendVoiceMessage(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Error accessing microphone:', err);
      alert('Could not access microphone. Please check permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  };

  const sendVoiceMessage = async (blob: Blob) => {
    if (!currentUser || !selectedUser) return;

    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = () => {
      const base64Audio = reader.result as string;
      
      socketRef.current?.send(JSON.stringify({
        type: 'chat',
        senderId: currentUser.id,
        receiverId: selectedUser.id,
        content: base64Audio,
        msgType: 'voice'
      }));
    };
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // WebRTC Logic
  const startWebRTC = async (targetId: string, isCaller: boolean, callType: CallType) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: callType === 'video',
        audio: true
      });
      setLocalStream(stream);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.send(JSON.stringify({
            type: 'signal',
            senderId: currentUser?.id,
            targetId,
            signalType: 'candidate',
            data: event.candidate
          }));
        }
      };

      pc.ontrack = (event) => {
        console.log('Received remote track:', event.streams[0]);
        setRemoteStream(event.streams[0]);
      };

      if (isCaller) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.send(JSON.stringify({
          type: 'signal',
          senderId: currentUser?.id,
          targetId,
          signalType: 'offer',
          data: offer
        }));
      }

      peerRef.current = pc;
    } catch (err) {
      console.error('WebRTC Error:', err);
      endCall();
    }
  };

  const handleSignalingData = async (data: any) => {
    const pc = peerRef.current;
    if (!pc) return;

    try {
      if (data.signalType === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current?.send(JSON.stringify({
          type: 'signal',
          senderId: currentUser?.id,
          targetId: data.senderId,
          signalType: 'answer',
          data: answer
        }));
        
        // Process pending candidates
        while (pendingCandidates.current.length > 0) {
          const cand = pendingCandidates.current.shift();
          if (cand) await pc.addIceCandidate(new RTCIceCandidate(cand));
        }
      } else if (data.signalType === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.data));
        
        // Process pending candidates
        while (pendingCandidates.current.length > 0) {
          const cand = pendingCandidates.current.shift();
          if (cand) await pc.addIceCandidate(new RTCIceCandidate(cand));
        }
      } else if (data.signalType === 'candidate') {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(data.data));
        } else {
          pendingCandidates.current.push(data.data);
        }
      }
    } catch (err) {
      console.error('Signaling error:', err);
    }
  };

  const initiateCall = (type: CallType) => {
    if (!selectedUser || !currentUser) return;
    setActiveCall({ targetId: selectedUser.id, callType: type, isCaller: true });
    setIsRinging(true);
    socketRef.current?.send(JSON.stringify({
      type: 'call-request',
      senderId: currentUser.id,
      targetId: selectedUser.id,
      callType: type
    }));
  };

  const acceptCall = () => {
    if (!incomingCall || !currentUser) return;
    setActiveCall({ targetId: incomingCall.senderId, callType: incomingCall.callType, isCaller: false });
    socketRef.current?.send(JSON.stringify({
      type: 'call-response',
      senderId: currentUser.id,
      targetId: incomingCall.senderId,
      accepted: true
    }));
    startWebRTC(incomingCall.senderId, false, incomingCall.callType);
    setIncomingCall(null);
  };

  const declineCall = () => {
    if (!incomingCall || !currentUser) return;
    socketRef.current?.send(JSON.stringify({
      type: 'call-response',
      senderId: currentUser.id,
      targetId: incomingCall.senderId,
      accepted: false
    }));
    setIncomingCall(null);
  };

  const endCall = () => {
    localStream?.getTracks().forEach(track => track.stop());
    peerRef.current?.close();
    peerRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setActiveCall(null);
    setIsRinging(false);
    pendingCandidates.current = [];
  };

  const toggleMute = () => {
    if (localStream) {
      const newMuted = !isMuted;
      localStream.getAudioTracks().forEach(track => track.enabled = !newMuted);
      setIsMuted(newMuted);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const newVideoOff = !isVideoOff;
      localStream.getVideoTracks().forEach(track => track.enabled = !newVideoOff);
      setIsVideoOff(newVideoOff);
    }
  };

  if (isAuthModalOpen) {
    return (
      <div className="fixed inset-0 bg-[#f0f2f5] flex items-center justify-center p-4 z-50">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-2xl shadow-[0_12px_28px_0_rgba(0,0,0,0.2),0_2px_4px_0_rgba(0,0,0,0.1)] p-8 w-full max-w-md text-center"
        >
          <div className="flex flex-col items-center mb-8">
            <div className="w-20 h-20 bg-gradient-to-br from-[#0084FF] to-[#00C6FF] rounded-3xl flex items-center justify-center mb-6 shadow-lg shadow-blue-200 overflow-hidden">
              {avatarInput ? (
                <img src={avatarInput} className="w-full h-full object-cover" alt="Avatar Preview" />
              ) : (
                <MessageSquare className="text-white w-10 h-10" />
              )}
            </div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Nexus Chat</h1>
            <p className="text-slate-500 mt-2 font-medium">
              {isRegistering ? 'Create a new account' : 'Connect with friends and family'}
            </p>
          </div>
          <form onSubmit={handleAuth} className="space-y-4">
            <div className="space-y-3 text-left">
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase ml-1">Username</label>
                <input
                  type="text"
                  placeholder="Enter your username"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-slate-50 border-2 border-transparent focus:border-messenger-blue focus:bg-white focus:outline-none transition-all text-sm"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase ml-1">Password</label>
                <input
                  type="password"
                  placeholder="Enter your password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-slate-50 border-2 border-transparent focus:border-messenger-blue focus:bg-white focus:outline-none transition-all text-sm"
                />
              </div>
              {isRegistering && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-500 uppercase ml-1">Profile Picture URL (Optional)</label>
                    <input
                      type="text"
                      placeholder="https://example.com/photo.jpg"
                      value={avatarInput}
                      onChange={(e) => setAvatarInput(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-xl bg-slate-50 border-2 border-transparent focus:border-messenger-blue focus:bg-white focus:outline-none transition-all text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-500 uppercase ml-1">Admin Secret (Optional)</label>
                    <input
                      type="password"
                      placeholder="Enter secret for owner role"
                      value={roleSecretInput}
                      onChange={(e) => setRoleSecretInput(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-xl bg-slate-50 border-2 border-transparent focus:border-messenger-blue focus:bg-white focus:outline-none transition-all text-sm"
                    />
                  </div>
                </>
              )}
            </div>
            <button
              type="submit"
              className="w-full bg-messenger-blue text-white py-3.5 rounded-xl font-bold text-base hover:bg-[#0073e6] transition-all shadow-xl shadow-blue-100 active:scale-[0.98] mt-2"
            >
              {isRegistering ? 'Sign Up' : 'Login'}
            </button>
            {!isRegistering && (
              <button
                type="button"
                onClick={handleGuestLogin}
                className="w-full bg-slate-100 text-slate-700 py-3.5 rounded-xl font-bold text-base hover:bg-slate-200 transition-all active:scale-[0.98]"
              >
                Continue as Guest
              </button>
            )}
          </form>
          
          <div className="mt-6">
            <button 
              onClick={() => setIsRegistering(!isRegistering)}
              className="text-messenger-blue font-semibold hover:underline"
            >
              {isRegistering ? 'Already have an account? Login' : 'New to Nexus? Create an account'}
            </button>
          </div>
          
          <p className="mt-8 text-xs text-slate-400 uppercase tracking-widest font-bold">From AI Studio</p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#f0f2f5] overflow-hidden font-sans">
      {/* Sidebar */}
      <div className="w-[400px] bg-white border-r border-slate-200 flex flex-col z-20 shadow-xl">
        {/* Sidebar Header */}
        <div className="p-4 bg-[#f0f2f5] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div 
              onClick={() => {
                setAvatarInput(currentUser?.avatar || '');
                setIsProfileModalOpen(true);
              }}
              className="relative group cursor-pointer"
            >
              <img src={currentUser?.avatar} alt="Me" className="w-10 h-10 rounded-full border border-slate-200 object-cover" />
              <div className="absolute inset-0 bg-black/20 rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Smile size={14} className="text-white" />
              </div>
              {currentUser?.role === 'owner' && (
                <div className="absolute -top-1 -right-1 bg-amber-400 text-[8px] font-black px-1 rounded-sm text-white uppercase shadow-sm border border-white">
                  Owner
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 text-slate-600">
            {currentUser?.role === 'owner' && (
              <div className="px-2 py-1 bg-amber-100 text-amber-700 text-[10px] font-bold rounded-full uppercase tracking-wider">
                Admin Mode
              </div>
            )}
            <button className="p-2 hover:bg-slate-200 rounded-full transition-colors" title="Status">
              <div className="w-5 h-5 rounded-full border-2 border-slate-400 border-t-transparent animate-spin-slow" />
            </button>
            <button className="p-2 hover:bg-slate-200 rounded-full transition-colors" title="New Chat">
              <MessageSquare size={20} />
            </button>
            <button 
              onClick={handleLogout}
              className="p-2 hover:bg-red-100 rounded-full transition-colors text-red-500" 
              title="Logout"
            >
              <X size={20} />
            </button>
            <button className="p-2 hover:bg-slate-200 rounded-full transition-colors" title="Menu">
              <MoreVertical size={20} />
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="p-2 border-b border-slate-100">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search or start new chat"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-12 pr-4 py-2 bg-[#f0f2f5] rounded-lg focus:outline-none text-sm placeholder:text-slate-500"
            />
          </div>
        </div>

        {/* User List */}
        <div className="flex-1 overflow-y-auto scrollbar-hide">
          {filteredUsers.length > 0 ? (
            filteredUsers.map(user => (
              <button
                key={user.id}
                onClick={() => setSelectedUser(user)}
                className={`w-full px-4 py-3 flex items-center gap-4 hover:bg-[#f5f6f6] transition-colors relative group ${
                  selectedUser?.id === user.id ? 'bg-[#ebebeb]' : ''
                }`}
              >
                <div className="relative flex-shrink-0">
                  <img src={user.avatar} alt={user.username} className="w-12 h-12 rounded-full border border-slate-100 object-cover" />
                  {user.isOnline && (
                    <div className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 bg-[#25D366] border-2 border-white rounded-full"></div>
                  )}
                  {user.role === 'owner' && (
                    <div className="absolute -top-1 -left-1 bg-amber-400 text-[8px] font-black px-1 rounded-sm text-white uppercase shadow-sm border border-white">
                      Owner
                    </div>
                  )}
                </div>
                <div className="flex-1 text-left border-b border-slate-100 pb-3 group-last:border-0">
                  <div className="flex justify-between items-center mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900 text-[16px]">{user.username}</span>
                      {user.role === 'owner' && <span className="text-[10px] text-amber-600 font-bold">★</span>}
                    </div>
                    <span className="text-[12px] text-slate-500">
                      {user.isOnline ? 'Active' : user.last_seen ? new Date(user.last_seen.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <p className="text-[14px] text-slate-500 truncate max-w-[150px]">
                      {user.isOnline ? 'Click to chat' : 'Last seen recently'}
                    </p>
                    <div className="flex items-center gap-2">
                      {currentUser?.role === 'owner' && user.role !== 'owner' && (
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteUser(user.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-50 text-red-400 rounded-full transition-all"
                          title="Delete User"
                        >
                          <X size={14} />
                        </button>
                      )}
                      {Math.random() > 0.7 && !selectedUser && (
                        <div className="bg-[#25D366] text-white text-[11px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                          {Math.floor(Math.random() * 3) + 1}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            ))
          ) : (
            <div className="p-8 text-center text-slate-400">
              <p className="text-sm">No contacts found</p>
            </div>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative bg-[#efeae2]">
        {selectedUser ? (
          <>
            {/* Chat Header */}
            <div className="h-16 bg-[#f0f2f5] border-b border-slate-200 flex items-center justify-between px-4 z-10 shadow-sm">
              <div className="flex items-center gap-3 cursor-pointer">
                <img src={selectedUser.avatar} alt={selectedUser.username} className="w-10 h-10 rounded-full" />
                <div className="flex flex-col">
                  <h2 className="font-semibold text-slate-900 text-[16px] leading-tight">{selectedUser.username}</h2>
                  <span className={`text-[12px] ${isTyping || isAIThinking ? 'text-[#25D366] font-medium animate-pulse' : 'text-slate-500'}`}>
                    {isAIThinking ? 'thinking...' : isTyping ? 'typing...' : selectedUser.isOnline ? 'online' : 'last seen recently'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 text-slate-600">
                <button 
                  onClick={() => initiateCall('video')}
                  className="p-2.5 hover:bg-slate-200 rounded-full transition-colors"
                >
                  <Video size={20} />
                </button>
                <button 
                  onClick={() => initiateCall('audio')}
                  className="p-2.5 hover:bg-slate-200 rounded-full transition-colors"
                >
                  <Phone size={18} />
                </button>
                <div className="w-px h-6 bg-slate-300 mx-2"></div>
                <button className="p-2.5 hover:bg-slate-200 rounded-full transition-colors">
                  <Search size={18} />
                </button>
                <button className="p-2.5 hover:bg-slate-200 rounded-full transition-colors">
                  <MoreVertical size={20} />
                </button>
              </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-2 whatsapp-bg scrollbar-hide">
              <div className="flex justify-center mb-4">
                <span className="bg-[#d1d7db] text-slate-600 text-[11px] font-bold px-3 py-1 rounded-lg uppercase tracking-wide shadow-sm">
                  Today
                </span>
              </div>
              
              {messages.map((msg, idx) => {
                const isMe = msg.sender_id === currentUser?.id;
                const prevMsg = messages[idx - 1];
                const showTail = !prevMsg || prevMsg.sender_id !== msg.sender_id;

                return (
                  <div 
                    key={msg.id}
                    className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} mb-2 group`}
                  >
                    <div 
                      className={`max-w-[85%] md:max-w-[65%] px-3 py-1.5 shadow-sm relative cursor-pointer select-none ${
                        isMe 
                          ? 'message-bubble-out text-slate-800' 
                          : 'message-bubble-in text-slate-800'
                      }`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setLongPressedMessageId(msg.id);
                      }}
                    >
                      {showTail && (
                        <div className={`absolute top-0 w-3 h-3 ${
                          isMe 
                            ? 'right-[-8px] bg-[#DCF8C6] [clip-path:polygon(0_0,0_100%,100%_0)]' 
                            : 'left-[-8px] bg-white [clip-path:polygon(100%_0,100%_100%,0_0)]'
                        }`} />
                      )}
                      {msg.type === 'voice' ? (
                        <div className="flex items-center gap-2 py-1 min-w-[200px]">
                          <audio src={msg.content} controls className="h-8 w-full max-w-[240px] custom-audio" />
                        </div>
                      ) : (
                        <p className="text-[14.5px] leading-relaxed pr-12">{msg.content}</p>
                      )}
                      
                      {/* Reaction Picker (Simple Hover/LongPress Menu) */}
                      <div className={`absolute -top-10 ${isMe ? 'right-0' : 'left-0'} ${longPressedMessageId === msg.id ? 'flex' : 'hidden group-hover:flex'} bg-white shadow-xl rounded-full px-2 py-1.5 gap-2 border border-slate-100 z-50 animate-in fade-in zoom-in duration-200`}>
                        {['❤️', '👍', '😂', '😮', '😢', '🙏'].map(emoji => (
                          <button
                            key={emoji}
                            onClick={(e) => {
                              e.stopPropagation();
                              sendReaction(msg.id, emoji);
                            }}
                            className="hover:scale-150 transition-transform text-[20px] leading-none"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>

                      <div className="absolute bottom-1 right-2 flex items-center gap-1">
                        <span className="text-[10px] text-slate-500">
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {isMe && (
                          <div className={`flex ${msg.is_read ? 'text-[#53bdeb]' : 'text-slate-400'}`}>
                            <svg viewBox="0 0 16 11" width="16" height="11" fill="currentColor">
                              <path d="M11.01 1.492a.5.5 0 0 0-.707 0L5.348 6.447 3.695 4.794a.5.5 0 1 0-.707.707l2 2a.5.5 0 0 0 .707 0l5.315-5.303a.5.5 0 0 0 0-.706z"/>
                              <path d="M15.01 1.492a.5.5 0 0 0-.707 0L8.955 6.84l-.353-.353a.5.5 0 1 0-.707.707l.707.707a.5.5 0 0 0 .707 0l5.701-5.701a.5.5 0 0 0 0-.708z"/>
                            </svg>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Reactions Display - Now Below Bubble */}
                    {msg.reactions && msg.reactions.length > 0 && (
                      <div className={`flex flex-wrap gap-1 mt-1 ${isMe ? 'mr-2' : 'ml-2'}`}>
                        {Array.from(new Set(msg.reactions.map(r => r.emoji))).map((emoji: string) => {
                          const count = msg.reactions?.filter(r => r.emoji === emoji).length;
                          const hasReacted = msg.reactions?.some(r => r.emoji === emoji && r.user_id === currentUser?.id);
                          return (
                            <button
                              key={emoji}
                              onClick={(e) => {
                                e.stopPropagation();
                                sendReaction(msg.id, emoji);
                              }}
                              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] shadow-sm transition-all hover:scale-110 ${
                                hasReacted ? 'bg-blue-100 border border-blue-200' : 'bg-white border border-slate-100'
                              }`}
                            >
                              <span>{emoji}</span>
                              {count && count > 1 && <span className="text-[9px] font-bold text-slate-600">{count}</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-3 bg-[#f0f2f5] flex items-center gap-2 z-10">
              {isRecording ? (
                <div className="flex-1 flex items-center justify-between bg-white rounded-lg px-4 py-2 shadow-sm animate-pulse">
                  <div className="flex items-center gap-3 text-red-500">
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-ping" />
                    <span className="font-medium">{formatTime(recordingTime)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={cancelRecording}
                      className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 size={20} />
                    </button>
                    <button 
                      onClick={stopRecording}
                      className="p-2 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                    >
                      <Square size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1">
                    <button className="p-2 text-slate-500 hover:bg-slate-200 rounded-full transition-colors">
                      <Smile size={24} />
                    </button>
                    <button className="p-2 text-slate-500 hover:bg-slate-200 rounded-full transition-colors">
                      <X size={24} className="rotate-45" />
                    </button>
                  </div>
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      placeholder="Type a message"
                      value={inputText}
                      onChange={handleTyping}
                      onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                      className="w-full px-4 py-2.5 bg-white rounded-lg focus:outline-none text-[15px] shadow-sm"
                    />
                  </div>
                  <button 
                    onClick={inputText.trim() ? sendMessage : startRecording}
                    className="p-3 text-slate-500 hover:bg-slate-200 rounded-full transition-all"
                  >
                    {inputText.trim() ? (
                      <Send size={24} className="text-[#0084FF]" />
                    ) : (
                      <Mic size={24} />
                    )}
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-64 h-64 mb-8 opacity-80">
              <img 
                src="https://static.whatsapp.net/rsrc.php/v3/y6/r/wa669ae5z23.png" 
                alt="WhatsApp Web" 
                className="w-full h-full object-contain"
              />
            </div>
            <h1 className="text-3xl font-light text-slate-600 mb-4">Nexus for Web</h1>
            <p className="text-slate-500 max-w-md leading-relaxed">
              Send and receive messages without keeping your phone online.<br/>
              Use Nexus on up to 4 linked devices and 1 phone at the same time.
            </p>
            <div className="mt-auto flex items-center gap-2 text-slate-400 text-sm">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
              </svg>
              End-to-end encrypted
            </div>
          </div>
        )}

        {/* Profile Settings Modal */}
        <AnimatePresence>
          {isProfileModalOpen && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[100]">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="bg-white rounded-3xl shadow-2xl p-8 w-full max-w-md"
              >
                <div className="flex justify-between items-center mb-6">
                  <h2 className="text-2xl font-bold text-slate-900">Profile Settings</h2>
                  <button onClick={() => setIsProfileModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-full">
                    <X size={20} />
                  </button>
                </div>
                
                <div className="flex flex-col items-center mb-8">
                  <div className="w-24 h-24 rounded-full border-4 border-messenger-blue/20 p-1 mb-4">
                    <img 
                      src={avatarInput || currentUser?.avatar} 
                      className="w-full h-full rounded-full object-cover bg-slate-100" 
                      alt="Avatar" 
                    />
                  </div>
                  <p className="text-sm text-slate-500 font-medium">@{currentUser?.username}</p>
                  {currentUser?.role === 'owner' && (
                    <span className="mt-2 px-3 py-1 bg-amber-100 text-amber-700 text-[10px] font-black rounded-full uppercase tracking-widest">
                      System Owner
                    </span>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase ml-1">Profile Picture URL</label>
                    <input
                      type="text"
                      placeholder="Enter image URL"
                      value={avatarInput}
                      onChange={(e) => setAvatarInput(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl bg-slate-50 border-2 border-transparent focus:border-messenger-blue focus:bg-white focus:outline-none transition-all"
                    />
                  </div>
                  <button
                    onClick={handleUpdateProfile}
                    className="w-full bg-messenger-blue text-white py-3.5 rounded-xl font-bold hover:bg-[#0073e6] transition-all shadow-lg shadow-blue-100"
                  >
                    Save Changes
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Call Overlay */}
        <AnimatePresence>
          {activeCall && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-slate-900 z-[60] flex flex-col"
            >
              {/* Video Grid */}
              <div className="flex-1 relative grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
                {/* Hidden video elements for audio calls to ensure sound plays */}
                <video ref={remoteVideoRef} autoPlay playsInline className={activeCall.callType === 'video' && !isRinging ? "hidden" : "hidden"} />
                <video ref={localVideoRef} autoPlay playsInline muted className="hidden" />

                {isRinging ? (
                  <div className="col-span-2 flex flex-col items-center justify-center">
                    <div className="w-32 h-32 rounded-full bg-messenger-blue/20 flex items-center justify-center mb-6 relative">
                      <motion.div 
                        animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                        transition={{ duration: 2, repeat: Infinity }}
                        className="absolute inset-0 rounded-full bg-messenger-blue/30"
                      />
                      <img 
                        src={users.find(u => u.id === activeCall.targetId)?.avatar} 
                        className="w-24 h-24 rounded-full relative z-10"
                        alt="Calling"
                      />
                    </div>
                    <h2 className="text-2xl font-bold text-white mb-2">
                      Calling {users.find(u => u.id === activeCall.targetId)?.username}...
                    </h2>
                    <p className="text-slate-400 font-medium animate-pulse">Ringing</p>
                  </div>
                ) : activeCall.callType === 'video' ? (
                  <>
                    <div className="relative bg-slate-800 rounded-2xl overflow-hidden shadow-2xl">
                      <video 
                        ref={(el) => {
                          if (el && remoteStream) el.srcObject = remoteStream;
                        }} 
                        autoPlay 
                        playsInline 
                        className="w-full h-full object-cover" 
                      />
                      <div className="absolute bottom-4 left-4 bg-black/40 backdrop-blur-md px-3 py-1 rounded-lg text-white text-xs">
                        {users.find(u => u.id === activeCall.targetId)?.username}
                      </div>
                    </div>
                    <div className="relative bg-slate-800 rounded-2xl overflow-hidden shadow-2xl">
                      <video 
                        ref={(el) => {
                          if (el && localStream) el.srcObject = localStream;
                        }} 
                        autoPlay 
                        playsInline 
                        muted 
                        className="w-full h-full object-cover" 
                      />
                      <div className="absolute bottom-4 left-4 bg-black/40 backdrop-blur-md px-3 py-1 rounded-lg text-white text-xs">
                        You (Local)
                      </div>
                      {isVideoOff && (
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-800">
                          <UserIcon size={64} className="text-slate-600" />
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="col-span-2 flex flex-col items-center justify-center">
                    {/* Audio call still needs the remote stream attached somewhere */}
                    <audio 
                      ref={(el) => {
                        if (el && remoteStream) el.srcObject = remoteStream;
                      }} 
                      autoPlay 
                    />
                    <div className="w-32 h-32 rounded-full bg-indigo-600/20 flex items-center justify-center mb-6 relative">
                      <motion.div 
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{ duration: 2, repeat: Infinity }}
                        className="absolute inset-0 rounded-full bg-indigo-600/10"
                      />
                      <img 
                        src={users.find(u => u.id === activeCall.targetId)?.avatar} 
                        className="w-24 h-24 rounded-full relative z-10"
                        alt="Caller"
                      />
                    </div>
                    <h2 className="text-2xl font-bold text-white mb-2">
                      {users.find(u => u.id === activeCall.targetId)?.username}
                    </h2>
                    <p className="text-indigo-400 font-medium animate-pulse">On Call...</p>
                  </div>
                )}
              </div>

              {/* Call Controls */}
              <div className="h-32 bg-slate-900/80 backdrop-blur-xl flex items-center justify-center gap-6">
                <button 
                  onClick={toggleMute}
                  className={`p-4 rounded-full transition-all ${isMuted ? 'bg-red-500 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                </button>
                {activeCall.callType === 'video' && (
                  <button 
                    onClick={toggleVideo}
                    className={`p-4 rounded-full transition-all ${isVideoOff ? 'bg-red-500 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                  >
                    {isVideoOff ? <VideoOff size={24} /> : <VideoIcon size={24} />}
                  </button>
                )}
                <button 
                  onClick={endCall}
                  className="p-4 bg-red-600 text-white rounded-full hover:bg-red-700 transition-all shadow-xl shadow-red-900/20"
                >
                  <PhoneOff size={28} />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Incoming Call Notification */}
        <AnimatePresence>
          {incomingCall && (
            <motion.div 
              initial={{ y: -100, opacity: 0 }}
              animate={{ y: 20, opacity: 1 }}
              exit={{ y: -100, opacity: 0 }}
              className="fixed top-0 left-1/2 -translate-x-1/2 bg-white rounded-2xl shadow-2xl p-4 flex items-center gap-4 z-[70] border border-slate-100 min-w-[320px]"
            >
              <img 
                src={users.find(u => u.id === incomingCall.senderId)?.avatar} 
                className="w-12 h-12 rounded-full bg-slate-100"
                alt="Caller"
              />
              <div className="flex-1">
                <h3 className="font-bold text-slate-900">
                  {users.find(u => u.id === incomingCall.senderId)?.username}
                </h3>
                <p className="text-xs text-slate-500 flex items-center gap-1">
                  {incomingCall.callType === 'video' ? <Video size={12} /> : <Phone size={12} />}
                  Incoming {incomingCall.callType} call...
                </p>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={declineCall}
                  className="p-2.5 bg-red-100 text-red-600 rounded-xl hover:bg-red-200 transition-colors"
                >
                  <X size={20} />
                </button>
                <button 
                  onClick={acceptCall}
                  className="p-2.5 bg-emerald-500 text-white rounded-xl hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-200"
                >
                  <Phone size={20} className="animate-bounce" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

