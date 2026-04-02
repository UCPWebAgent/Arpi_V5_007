import React, { useEffect, useRef } from 'react';
import { ChatMessage } from '../types';

interface ConversationProps {
  messages: ChatMessage[];
}

export const Conversation: React.FC<ConversationProps> = ({ messages }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="h-full bg-white p-4 md:p-6 flex flex-col font-sans text-gray-800">
      <h2 className="text-[40px] font-bold mb-4 md:mb-8">Chat</h2>

      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-8 pr-2 custom-scrollbar">
        {messages.map((msg, idx) => (
          <div key={`${msg.timestamp}-${idx}`} className="space-y-1">
            <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider ml-1">
              {msg.role === 'user' ? 'Mechanic' : 'Assistant'}
            </p>
            <div className="text-sm leading-relaxed text-gray-700">
              {msg.text.split(/(\(.*?\))/g).map((part, i) => {
                if (part.startsWith('(') && part.endsWith(')')) {
                  return (
                    <span key={i} className="block text-[11px] text-gray-400 italic font-medium mt-1">
                      {part}
                    </span>
                  );
                }
                return <span key={i}>{part}</span>;
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
