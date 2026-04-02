import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, Bot, User, Loader2, Sparkles, Mic, MicOff } from 'lucide-react';
import { ChatMessage } from '../types';
import { ArpiSession } from '../lib/gemini';

interface HelpAgentProps {
  isOpen: boolean;
  onClose: () => void;
  isMainListening: boolean;
}

export const HelpAgent: React.FC<HelpAgentProps> = ({ isOpen, onClose, isMainListening }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcription, setTranscription] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ArpiSession | null>(null);

  const systemInstruction = "You are the Arpi App Help Assistant. You are a reasoning agent designed to help mechanics navigate the Arpi app and solve technical problems. Be concise, professional, and helpful. You have deep knowledge of the Arpi app's features: fluid capacity lookup, parts search, service order management, and vehicle identification via VIN or License Plate. Explain that Arpi uses a deterministic engine to identify vehicles and requires user confirmation for accuracy. ALWAYS start the conversation by saying 'May I help you?' and wait for the user to speak. Respond primarily via voice.";

  useEffect(() => {
    if (isOpen) {
      startVoiceSession();
    } else {
      stopVoiceSession();
    }
    return () => stopVoiceSession();
  }, [isOpen]);

  const startVoiceSession = async () => {
    if (sessionRef.current) return;

    const session = new ArpiSession(
      (text) => {
        setMessages(prev => [...prev, { role: 'assistant', text, timestamp: Date.now() }]);
        setIsSpeaking(true);
        setTranscription('');
      },
      (update) => console.log("Help Agent State Update:", update),
      () => {
        setIsSpeaking(false);
        setMessages(prev => [...prev, { role: 'assistant', text: "[Interrupted]", timestamp: Date.now() }]);
      },
      () => setIsSpeaking(false), // onSpeakingEnd
      (text) => setTranscription(text),
      'en',
      systemInstruction
    );

    // Override system instruction for help
    // We need to modify ArpiSession to allow custom system instructions or just use a different class
    // For now, let's assume we can pass it or we'll modify ArpiSession
    
    try {
      await session.connect();
      sessionRef.current = session;
      setIsListening(true);
      
      // Trigger the initial greeting
      session.sendText("Greet the user with 'May I help you?' and wait for their response.");
    } catch (error) {
      console.error("Help Session Error:", error);
    }
  };

  const stopVoiceSession = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
      setIsListening(false);
      setIsSpeaking(false);
      setTranscription('');
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, transcription]);

  const handleSend = async () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text, timestamp: Date.now() }]);
    if (sessionRef.current) {
      sessionRef.current.sendText(text);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="bg-white w-full max-w-lg h-[600px] rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-gray-100"
          >
            {/* Header */}
            <div className="bg-[#5B89B1] p-6 text-white flex justify-between items-center shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                  <Sparkles size={20} className="text-white" />
                </div>
                <div>
                  <h3 className="font-bold text-lg leading-tight">Arpi Help Agent</h3>
                  <p className="text-xs text-blue-100 font-medium uppercase tracking-widest">Reasoning Assistant</p>
                </div>
              </div>
              <button 
                onClick={onClose}
                className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors"
              >
                <X size={24} />
              </button>
            </div>

            {/* Chat Area */}
            <div 
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-6 space-y-4 bg-gray-50/50 custom-scrollbar relative"
            >
              {messages.map((msg, i) => (
                <motion.div
                  key={`${msg.timestamp}-${i}`}
                  initial={{ opacity: 0, x: msg.role === 'user' ? 20 : -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`flex gap-3 max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 shadow-sm ${
                      msg.role === 'user' ? 'bg-[#5B89B1] text-white' : 'bg-white text-gray-400 border border-gray-100'
                    }`}>
                      {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
                    </div>
                    <div className={`p-4 rounded-2xl text-sm leading-relaxed shadow-sm ${
                      msg.role === 'user' 
                        ? 'bg-[#5B89B1] text-white rounded-tr-none' 
                        : 'bg-white text-gray-700 border border-gray-100 rounded-tl-none'
                    }`}>
                      {msg.text}
                    </div>
                  </div>
                </motion.div>
              ))}
              
              {transcription && (
                <div className="flex justify-end">
                  <div className="flex gap-3 max-w-[85%] flex-row-reverse">
                    <div className="w-8 h-8 rounded-lg bg-[#5B89B1] text-white flex items-center justify-center shrink-0 shadow-sm animate-pulse">
                      <User size={16} />
                    </div>
                    <div className="p-4 rounded-2xl text-sm leading-relaxed shadow-sm bg-[#5B89B1]/10 text-[#5B89B1] rounded-tr-none italic border border-[#5B89B1]/20">
                      "{transcription}..."
                    </div>
                  </div>
                </div>
              )}

              {isSpeaking && (
                <div className="flex justify-start">
                  <div className="flex gap-3 max-w-[85%]">
                    <div className="w-8 h-8 rounded-lg bg-white text-green-500 border border-green-100 flex items-center justify-center shrink-0 shadow-sm">
                      <Bot size={16} className="animate-bounce" />
                    </div>
                    <div className="bg-white p-4 rounded-2xl rounded-tl-none border border-green-100 shadow-sm text-xs font-bold text-green-600 uppercase tracking-widest">
                      Arpi is speaking...
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Input Area */}
            <div className="p-6 bg-white border-t border-gray-100 shrink-0">
              <div className="flex items-center gap-4 mb-4">
                <div className={`flex-1 h-12 rounded-2xl flex items-center justify-center gap-3 transition-all ${
                  isListening ? 'bg-red-50 text-red-500 border border-red-100' : 'bg-gray-50 text-gray-400 border border-gray-100'
                }`}>
                  {isListening ? (
                    <>
                      <div className="w-2 h-2 bg-red-500 rounded-full" />
                      <span className="text-xs font-bold uppercase tracking-widest">Listening...</span>
                    </>
                  ) : (
                    <>
                      <MicOff size={16} />
                      <span className="text-xs font-bold uppercase tracking-widest">Voice Offline</span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => isListening ? stopVoiceSession() : startVoiceSession()}
                  className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all shadow-md active:scale-95 ${
                    isListening ? 'bg-red-500 text-white' : 'bg-[#5B89B1] text-white'
                  }`}
                >
                  <Mic size={20} />
                </button>
              </div>

              <div className="relative">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                  placeholder="Ask me anything about Arpi..."
                  className="w-full bg-gray-50 border border-gray-200 rounded-2xl py-4 pl-5 pr-14 text-sm focus:outline-none focus:ring-2 focus:ring-[#5B89B1]/50 focus:bg-white transition-all shadow-sm"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                    input.trim()
                      ? 'bg-[#5B89B1] text-white shadow-md active:scale-90' 
                      : 'bg-gray-100 text-gray-300 cursor-not-allowed'
                  }`}
                >
                  <Send size={18} />
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
