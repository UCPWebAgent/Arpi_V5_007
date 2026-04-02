import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, MessageSquare, Mail, User, Smartphone } from 'lucide-react';

interface FeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (text: string) => Promise<void>;
  userEmail?: string | null;
  userId?: string;
  deviceId?: string;
}

export const FeedbackModal: React.FC<FeedbackModalProps> = ({ 
  isOpen, 
  onClose, 
  onSubmit,
  userEmail,
  userId,
  deviceId
}) => {
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async () => {
    if (!feedback.trim()) return;
    
    setIsSubmitting(true);
    try {
      await onSubmit(feedback.trim());
      setIsSuccess(true);
      setFeedback('');
      setTimeout(() => {
        setIsSuccess(false);
        onClose();
      }, 2000);
    } catch (error) {
      console.error("Feedback submission failed:", error);
      alert("Failed to send feedback. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const mailtoLink = `mailto:beta@ucp-demo.online?subject=Arpi Beta Feedback&body=${encodeURIComponent(feedback)}`;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="bg-white w-full max-w-md rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-gray-100"
          >
            {/* Header */}
            <div className="bg-indigo-600 p-6 text-white flex justify-between items-center shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                  <MessageSquare size={20} className="text-white" />
                </div>
                <div>
                  <h3 className="font-bold text-lg leading-tight">Beta Feedback</h3>
                  <p className="text-xs text-indigo-100 font-medium uppercase tracking-widest">Help us improve Arpi</p>
                </div>
              </div>
              <button 
                onClick={onClose}
                className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors"
              >
                <X size={24} />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-6">
              <div className="space-y-2">
                <p className="text-sm text-gray-600 leading-relaxed font-medium">
                  We'd love to hear your feedback! Please type it here and we'll make sure the team sees it.
                </p>
              </div>

              <div className="relative">
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Your thoughts, suggestions, or issues..."
                  className="w-full h-40 bg-gray-50 border border-gray-200 rounded-2xl p-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:bg-white transition-all shadow-sm resize-none"
                  disabled={isSubmitting || isSuccess}
                />
                {isSuccess && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-0 bg-white/90 backdrop-blur-sm flex flex-col items-center justify-center rounded-2xl"
                  >
                    <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-2">
                      <Send size={20} className="text-green-600" />
                    </div>
                    <p className="text-sm font-bold text-green-600 uppercase tracking-widest">Feedback Sent!</p>
                  </motion.div>
                )}
              </div>

              {/* Identification Info */}
              <div className="bg-gray-50 rounded-2xl p-4 space-y-2 border border-gray-100">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">Identification Info</p>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <User size={12} className="text-gray-400" />
                  <span className="truncate">{userEmail || 'Anonymous User'}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Smartphone size={12} className="text-gray-400" />
                  <span className="truncate font-mono text-[10px]">{deviceId || 'Unknown Device'}</span>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <button
                  onClick={handleSubmit}
                  disabled={!feedback.trim() || isSubmitting || isSuccess}
                  className={`w-full py-4 rounded-2xl font-bold flex items-center justify-center gap-3 transition-all shadow-lg active:scale-95 ${
                    feedback.trim() && !isSubmitting && !isSuccess
                      ? 'bg-indigo-600 text-white hover:bg-indigo-700' 
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  }`}
                >
                  {isSubmitting ? (
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                    >
                      <Send size={20} />
                    </motion.div>
                  ) : (
                    <Send size={20} />
                  )}
                  <span>Submit Feedback</span>
                </button>

                <a
                  href={mailtoLink}
                  className="w-full py-3 text-indigo-600 font-bold text-xs uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-indigo-50 rounded-xl transition-all"
                >
                  <Mail size={14} />
                  <span>Send via Email instead</span>
                </a>
              </div>
              
              <p className="text-[9px] text-center text-gray-400 font-bold uppercase tracking-widest">
                Linked to: beta@ucp-demo.online
              </p>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
