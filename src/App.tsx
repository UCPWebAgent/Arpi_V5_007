import React, { useState, useEffect, useCallback, useRef } from 'react';
import { OrderState, ChatMessage, Language, MediaItem, VehicleIdentityLock, VehicleInfo, MechanicMemory } from './types';
import { processVehicleInput } from './lib/vinEngine';
import { OrderSummary } from './components/OrderSummary';
import { Conversation } from './components/Conversation';
import { AudioVisualizer } from './components/AudioVisualizer';
import { CameraModal } from './components/CameraModal';
import { HelpAgent } from './components/HelpAgent';
import { FeedbackModal } from './components/FeedbackModal';
import { PaymentModal } from './components/PaymentModal';
import { ArpiSession } from './lib/gemini';
import { orchestrator } from './lib/adapters';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, AlertCircle, FileText, Download } from 'lucide-react';
import { generateInvoicePDF, generateInvoiceText } from './lib/invoiceGenerator';

import { ErrorBoundary } from './components/ErrorBoundary';
import { auth, loginWithGoogle, db, handleFirestoreError, OperationType, syncUserProfile } from './lib/firebase';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, addDoc, serverTimestamp, getDocFromServer, doc, setDoc, updateDoc, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';

const INITIAL_STATE: OrderState = {
  vehicle: {},
  fluids: [],
  parts: [],
  media: [],
  mechanicName: 'Arman',
  shopName: 'ABC Auto',
  isConfirmed: false,
  status: 'draft',
  plateState: 'CA',
  needsCounterReview: true,
  fitmentConfidence: 0.8,
};

const getDeviceId = () => {
  let id = localStorage.getItem('arpi_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    localStorage.setItem('arpi_device_id', id);
  }
  return id;
};

const cleanObject = (obj: any): any => {
  if (Array.isArray(obj)) {
    return obj.map(item => cleanObject(item));
  }
  if (obj && typeof obj === 'object' && obj.constructor === Object) {
    const newObj: any = {};
    Object.keys(obj).forEach(key => {
      if (obj[key] !== undefined) {
        newObj[key] = cleanObject(obj[key]);
      }
    });
    return newObj;
  }
  return obj;
};

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [orderState, setOrderState] = useState<OrderState>(INITIAL_STATE);
  const [selectedLanguage, setSelectedLanguage] = useState<Language>('auto');
  const [activeTab, setActiveTab] = useState<'conversation' | 'input' | 'summary'>('input');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isFirebaseReady, setIsFirebaseReady] = useState(true);
  const [deviceId] = useState<string>(getDeviceId());
  const [cameraMode, setCameraMode] = useState<'photo' | 'video' | 'vin' | 'plate' | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<'card' | 'paypal'>('card');
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const wasListeningBeforeHelp = useRef(false);
  const [transcription, setTranscription] = useState<string>('');
  const [completedOrders, setCompletedOrders] = useState<OrderState[]>([]);
  const [showSaveOptions, setShowSaveOptions] = useState(false);
  const sessionRef = useRef<ArpiSession | null>(null);

  const [historyOrders, setHistoryOrders] = useState<OrderState[]>([]);
  const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null);
  const [mechanicMemory, setMechanicMemory] = useState<MechanicMemory | null>(null);

  const saveMechanicMemory = useCallback(async (updates: Partial<MechanicMemory>) => {
    if (!user) return;
    
    const memoryRef = doc(db, 'mechanic_memory', user.uid);
    const updatedMemory = {
      ...updates,
      userId: user.uid, // Always include userId for new docs
      updatedAt: serverTimestamp()
    };
    
    try {
      await setDoc(memoryRef, updatedMemory, { merge: true });
      setMechanicMemory(prev => prev ? { ...prev, ...updates } : null);
    } catch (error) {
      console.error("Error saving mechanic memory:", error);
      // We don't want to throw here to avoid crashing the app on auto-save
      // but we can log more details
      if (error instanceof Error && error.message.includes('permission')) {
        console.warn("Permission denied for mechanic memory save. Check firestore rules.");
      }
    }
  }, [user]);

  // Auto-save memory when state changes
  useEffect(() => {
    if (!user || !mechanicMemory) return;

    const timer = setTimeout(() => {
      saveMechanicMemory({
        lastDraft: orderState,
        recentHistory: messages.slice(-20), // Keep last 20 messages
        preferences: {
          mechanicName: orderState.mechanicName,
          shopName: orderState.shopName,
          language: selectedLanguage
        }
      });
    }, 10000); // 10s debounce to avoid too many writes

    return () => clearTimeout(timer);
  }, [orderState, messages, selectedLanguage, user, mechanicMemory, saveMechanicMemory]);

  useEffect(() => {
    if (!deviceId || !user) {
      if (!deviceId) setHistoryOrders([]);
      return;
    }

    const ordersRef = collection(db, 'orders');
    const q = query(
      ordersRef,
      where('userId', '==', user.uid),
      where('deviceId', '==', deviceId),
      orderBy('updatedAt', 'desc'),
      limit(20)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const orders = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as any[];
      setHistoryOrders(orders);
      console.log(`Loaded ${orders.length} historical orders for device ${deviceId}`);
    }, (error) => {
      // If it's an index error, we might want to fall back to a simpler query or just log it
      if (error.message.includes('index')) {
        console.warn("Query requires a composite index. Falling back to simple query.");
        const simpleQ = query(
          ordersRef,
          where('userId', '==', user.uid),
          limit(20)
        );
        onSnapshot(simpleQ, (snap) => {
          const orders = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
          setHistoryOrders(orders);
        }, (err) => handleFirestoreError(err, OperationType.LIST, 'orders'));
      } else {
        handleFirestoreError(error, OperationType.LIST, 'orders');
      }
    });

    return () => unsubscribe();
  }, [deviceId, user]);

  useEffect(() => {
    setOrderState(prev => ({ ...prev, deviceId }));
  }, [deviceId]);

  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
          setIsFirebaseReady(false);
        }
      }
    };
    testConnection();

    const checkKey = async () => {
      // Prioritize environment key for a "clean" experience
      if (process.env.GEMINI_API_KEY) {
        setHasApiKey(true);
        return;
      }

      if (window.aistudio) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        setHasApiKey(hasKey);
      }
    };
    checkKey();
  }, []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const handleSelectKey = async () => {
    if (window.aistudio) {
      try {
        await window.aistudio.openSelectKey();
        setHasApiKey(true);
      } catch (error) {
        console.error("Key selection failed:", error);
        alert("Failed to select API key. Please try again.");
      }
    } else {
      alert("To use Arpi's voice features, please open this app through the AI Studio 'Build' interface or the 'Share' link. Direct links require manual API key configuration.");
    }
  };

  useEffect(() => {
    if (isHelpOpen) {
      if (isListening) {
        wasListeningBeforeHelp.current = true;
        stopSession();
      } else {
        wasListeningBeforeHelp.current = false;
      }
    } else {
      if (wasListeningBeforeHelp.current) {
        startSession();
        wasListeningBeforeHelp.current = false;
      }
    }
  }, [isHelpOpen]);

  const handleVehicleIdentification = async (text: string) => {
    // If vehicle is already locked and confirmed, don't auto-process unless it's a reset
    if (orderState.vehicleIdentityLock?.isConfirmed) return;

    // Try VIN first
    let result = await processVehicleInput(text, 'vin', orderState.plateState || 'CA');
    
    // If no VIN candidate, try Plate
    if (result.status === 'NO_CANDIDATE') {
      result = await processVehicleInput(text, 'plate', orderState.plateState || 'CA');
    }

    if (result.status !== 'NO_CANDIDATE') {
      console.log('Vehicle Identification Result:', result);
      
      const update: Partial<OrderState> = {
        vehicleIdentityLock: result as VehicleIdentityLock
      };

      if (result.decodeResult) {
        update.vehicle = result.decodeResult;
      }

      handleUpdateState(update);

      // If we have a result, inform Gemini so it can ask for confirmation
      if (sessionRef.current && result.status === 'CONFIRMATION_REQUIRED') {
        const v = result.decodeResult;
        const vehicleStr = v ? `${v.year} ${v.make} ${v.model} ${v.trim || ''}`.trim() : 'vehicle';
        sessionRef.current.sendText(`[SYSTEM: Identified ${vehicleStr} from ${result.inputType}. Please ask user to confirm including the trim.]`);
      }
    }
  };

  const handleUpdateMessage = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', text, timestamp: Date.now() }]);
    setIsSpeaking(true);
    setTranscription(''); // Clear transcription when a full message arrives
  }, []);

  const handleTranscription = useCallback((text: string) => {
    setTranscription(text);
    // Spoken input: treat transcript as candidate source only
    if (text.length > 5) {
      handleVehicleIdentification(text);
    }
  }, [orderState.vehicleIdentityLock]);

  const handleUpdateState = useCallback((update: Partial<OrderState>) => {
    setOrderState((prev) => {
      const newState = { ...prev, ...update };
      
      // Merge vehicle info specifically
      if (update.vehicle) {
        newState.vehicle = { ...prev.vehicle, ...update.vehicle };
      }

      // Handle vehicle identity lock updates
      if (update.vehicleIdentityLock) {
        newState.vehicleIdentityLock = { 
          ...(prev.vehicleIdentityLock || {}), 
          ...update.vehicleIdentityLock 
        } as VehicleIdentityLock;
      } else if (update.vehicleIdentityLock === null) {
        newState.vehicleIdentityLock = undefined;
      }
      
      // Only append if the update actually contains new items
      if (update.fluids && update.fluids.length > 0) {
        const existingIds = new Set(prev.fluids.map(f => `${f.subcategory}-${f.spec}`));
        const newFluids = update.fluids.filter(f => !existingIds.has(`${f.subcategory}-${f.spec}`));
        newState.fluids = [...prev.fluids, ...newFluids];
      }
      if (update.parts && update.parts.length > 0) {
        const existingNames = new Set(prev.parts.map(p => p.name.toLowerCase()));
        const newParts = update.parts.filter(p => !existingNames.has(p.name.toLowerCase()));
        newState.parts = [...prev.parts, ...newParts];
      }
      if (update.media && update.media.length > 0) {
        const existingIds = new Set(prev.media.map(m => m.id));
        const newMedia = update.media.filter(m => !existingIds.has(m.id));
        newState.media = [...prev.media, ...newMedia];
      }
      return newState;
    });
  }, []);

  const handleCapture = (type: 'photo' | 'video' | 'vin' | 'plate') => {
    setCameraMode(type);
  };

  const onCameraCapture = (dataUrl: string, type: 'photo' | 'video' | 'vin' | 'plate', thumbnailUrl?: string, ocrText?: string) => {
    console.log(`${type} captured from modal`);
    
    if (type === 'vin' || type === 'plate') {
      if (ocrText) {
        handleVehicleIdentification(ocrText);
      }
      return;
    }

    const newItem: MediaItem = {
      id: Math.random().toString(36).substr(2, 9),
      type: type as 'photo' | 'video',
      url: dataUrl,
      thumbnailUrl: type === 'video' ? thumbnailUrl : undefined,
      timestamp: Date.now(),
    };
    handleUpdateState({ media: [newItem] });
  };

  const handleInterrupted = useCallback(() => {
    setIsSpeaking(false);
    setMessages((prev) => [...prev, { role: 'assistant', text: "[Interrupted]", timestamp: Date.now() }]);
  }, []);

  const handleLanguageChange = (lang: Language) => {
    setSelectedLanguage(lang);
    if (isListening) {
      stopSession();
      // Small delay to ensure cleanup before restart
      setTimeout(() => {
        startSession(lang);
      }, 100);
    }
  };

  const getHistoryContext = useCallback(() => {
    if (historyOrders.length === 0) return "";
    
    const summary = historyOrders.slice(0, 5).map(order => {
      const v = order.vehicle;
      const vehicleStr = v ? `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim() : "Unknown Vehicle";
      const partsStr = order.parts?.map(p => `${p.quantity}x ${p.name}`).join(', ') || "No parts";
      return `- ${vehicleStr}: ${partsStr}`;
    }).join('\n');

    return `\nHISTORICAL CONTEXT (Recent Orders on this device):\n${summary}\nUse this to recognize returning vehicles or common parts used by this mechanic.`;
  }, [historyOrders]);

  const startSession = async (langOverride?: Language) => {
    if (isConnecting || isListening) return;
    
    setIsConnecting(true);

    if (!hasApiKey && !process.env.GEMINI_API_KEY) {
      if (window.aistudio) {
        await handleSelectKey();
        // Assume success after dialog to avoid race condition
        setHasApiKey(true);
      } else {
        alert("Gemini API Key is required for voice features. Please use the 'Share' link from AI Studio.");
        setIsConnecting(false);
        return;
      }
    }

    if (!sessionRef.current) {
      const historyContext = getHistoryContext();
      const session = new ArpiSession(
        handleUpdateMessage,
        handleUpdateState,
        handleInterrupted,
        () => setIsSpeaking(false), // onSpeakingEnd
        handleTranscription,
        langOverride || selectedLanguage,
        undefined, // Use default system instruction
        mechanicMemory || undefined,
        (fact) => {
          console.log("Arpi learned a new fact:", fact);
          saveMechanicMemory({
            learnedFacts: [...(mechanicMemory?.learnedFacts || []), fact]
          });
        }
      );
      
      try {
        await session.connect();
        sessionRef.current = session;
        setIsListening(true);
        
        // Send historical context as a hidden prompt if available
        if (historyContext) {
          await session.sendText(`[SYSTEM CONTEXT: ${historyContext}] Please acknowledge internally but do not repeat this to the user unless relevant.`);
        }
      } catch (error) {
        console.error("Session connection failed:", error);
        setMessages(prev => [...prev, { 
          role: 'assistant', 
          text: "Failed to connect to Arpi. Please check your internet connection and API key.", 
          timestamp: Date.now() 
        }]);
      } finally {
        setIsConnecting(false);
      }
    } else {
      setIsConnecting(false);
    }
  };

  const stopSession = async () => {
    if (sessionRef.current) {
      await sessionRef.current.close();
      sessionRef.current = null;
      setIsListening(false);
      setIsSpeaking(false);
      setTranscription('');
    }
  };

  const toggleMic = async () => {
    if (isConnecting) return;
    
    if (isListening) {
      await stopSession();
    } else {
      await startSession();
    }
  };

  const handleToggleConfirm = () => {
    console.log("handleToggleConfirm called");
    setOrderState((prev) => ({ ...prev, isConfirmed: !prev.isConfirmed }));
  };

  const handleSubmitOrder = async () => {
    console.log("handleSubmitOrder called, isConfirmed:", orderState.isConfirmed);
    if (orderState.isConfirmed && user) {
      // For mechanics on monthly payments, we just submit the order with 'Account' payment method
      await handleProcessPayment('Account');
    }
  };

  const handlePayOrder = async (method: 'card' | 'paypal') => {
    console.log("handlePayOrder called with method:", method);
    if (user) {
      setSelectedPaymentMethod(method);
      setShowPaymentModal(true);
    }
  };

  const handleProcessPayment = async (method: string, details?: any) => {
    if (!user) return;
    
    try {
      const finalOrder: OrderState = {
        ...orderState,
        userId: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        status: 'confirmed' as const,
        paymentMethod: method,
        needsCounterReview: false, // Once confirmed, it's ready for fulfillment
        fitmentConfidence: 1.0, // Confirmed by human
      };

      // 1. Dispatch through adapters (Software-Agnostic Routing)
      const adapterResults = await orchestrator.dispatch(finalOrder);
      console.log("Orchestrator dispatch results:", adapterResults);

      const successfulAdapter = adapterResults.find(r => r.success);
      if (successfulAdapter) {
        finalOrder.backendOrderId = successfulAdapter.externalId;
      }

      // 2. Store in memory for UI
      setCompletedOrders(prev => [{ ...finalOrder, createdAt: new Date().toISOString() }, ...prev]);

      // 3. Save to Firestore (Primary Storage Layer)
      const path = 'orders';
      await addDoc(collection(db, path), cleanObject(finalOrder));
      
      setOrderState((prev) => ({ ...prev, status: 'confirmed' }));
      
      let methodText = '';
      if (method === 'Account') {
        methodText = 'Monthly Account';
      } else if (method === 'youtube') {
        methodText = 'YouTube';
      } else if (method === 'paypal') {
        methodText = 'PayPal';
      } else {
        methodText = 'Credit Card';
      }

      setMessages((prev) => [
        ...prev, 
        { 
          role: 'assistant', 
          text: `Order confirmed and processed via ${methodText}! The request has been routed to the shop dashboard and backend systems. Lav e, gortse verchatsav!`, 
          timestamp: Date.now() 
        }
      ]);
      setShowPaymentModal(false);
    } catch (error) {
      console.error("Submission failed:", error);
      handleFirestoreError(error, OperationType.CREATE, 'orders');
    }
  };

  const handleSaveToPhone = (format: 'pdf' | 'text') => {
    if (format === 'pdf') {
      generateInvoicePDF(orderState);
    } else {
      generateInvoiceText(orderState);
    }
    setShowSaveOptions(false);
  };

  const handleSendText = (text: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) return;

    // Typed input: route through deterministic pipeline
    handleVehicleIdentification(trimmedText);

    if (sessionRef.current) {
      sessionRef.current.sendText(trimmedText);
      setMessages((prev) => [...prev, { role: 'user', text: trimmedText, timestamp: Date.now() }]);
    } else {
      // If no session, start one and then send text
      startSession().then(() => {
        if (sessionRef.current) {
          sessionRef.current.sendText(trimmedText);
          setMessages((prev) => [...prev, { role: 'user', text: trimmedText, timestamp: Date.now() }]);
        }
      });
    }
  };

  const handleResetOrder = () => {
    setOrderState(INITIAL_STATE);
    setMessages([{
      role: 'assistant',
      text: "Order reset. I'm ready for the next vehicle. Please provide the vehicle details.",
      timestamp: Date.now()
    }]);
  };

  const handleSaveOrder = async () => {
    if (user) {
      try {
        const path = 'orders';
        if (orderState.id) {
          await updateDoc(doc(db, path, orderState.id), cleanObject({
            ...orderState,
            updatedAt: serverTimestamp()
          }));
        } else {
          const docRef = await addDoc(collection(db, path), cleanObject({
            ...orderState,
            userId: user.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            status: 'draft'
          }));
          setOrderState(prev => ({ ...prev, id: docRef.id }));
        }
        setMessages(prev => [...prev, { 
          role: 'assistant', 
          text: "Order saved as draft. You can access it later from this device.", 
          timestamp: Date.now() 
        }]);
      } catch (error) {
        console.error("Save failed:", error);
        handleFirestoreError(error, OperationType.WRITE, 'orders');
      }
    }
  };

  const handleFeedback = () => {
    setIsFeedbackOpen(true);
  };

  const handleSubmitFeedback = async (text: string) => {
    try {
      const path = 'feedback';
      await addDoc(collection(db, path), cleanObject({
        text,
        userId: user?.uid || null,
        userEmail: user?.email || null,
        deviceId: deviceId || null,
        targetEmail: 'beta@ucp-demo.online',
        timestamp: serverTimestamp(),
        status: 'new'
      }));
    } catch (error) {
      console.error("Feedback submission failed:", error);
      handleFirestoreError(error, OperationType.WRITE, 'feedback');
    }
  };

  const handleLoadOrder = (order: OrderState) => {
    setOrderState({
      ...order,
      id: undefined, // Clear ID to treat as new draft
      status: 'draft',
      isConfirmed: true,
      createdAt: undefined,
      updatedAt: undefined
    });
    setActiveTab('input');
    setMessages(prev => [...prev, {
      role: 'assistant',
      text: `Loaded order for ${order.vehicle.year} ${order.vehicle.make} ${order.vehicle.model} as a new draft.`,
      timestamp: Date.now()
    }]);
  };

  useEffect(() => {
    const handleVisibilityChange = async () => {
      // Wake lock removed due to environment restrictions
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isListening]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setUser(user);
      setAuthLoading(false);
      if (user) {
        setOrderState(prev => ({ ...prev, userId: user.uid }));
        // Sync user profile to Firestore
        if (!user.isAnonymous) {
          syncUserProfile(user);
        }

        // Fetch persistent memory
        const memoryRef = doc(db, 'mechanic_memory', user.uid);
        try {
          const memorySnap = await getDocFromServer(memoryRef);
          if (memorySnap.exists()) {
            const memoryData = memorySnap.data() as MechanicMemory;
            setMechanicMemory(memoryData);
            
            // Restore last draft if available and current state is initial
            if (memoryData.lastDraft && !orderState.vehicle.vin && orderState.parts.length === 0) {
              setOrderState(memoryData.lastDraft);
            }
            
            // Restore recent history if available
            if (memoryData.recentHistory && messages.length === 0) {
              setMessages(memoryData.recentHistory);
            }

            // Restore preferences
            if (memoryData.preferences?.language) {
              setSelectedLanguage(memoryData.preferences.language);
            }
          } else {
            // Initialize memory
            const initialMemory: MechanicMemory = {
              userId: user.uid,
              preferences: {
                mechanicName: orderState.mechanicName,
                shopName: orderState.shopName,
                language: selectedLanguage
              },
              learnedFacts: [],
              recentHistory: [],
              updatedAt: serverTimestamp()
            };
            await setDoc(memoryRef, initialMemory);
            setMechanicMemory(initialMemory);
          }
        } catch (error) {
          console.error("Error fetching mechanic memory:", error);
          handleFirestoreError(error, OperationType.GET, `mechanic_memory/${user.uid}`);
        }
      } else {
        setMechanicMemory(null);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!deviceId || !user) return;

    // Fetch latest draft order for this device and user
    const path = 'orders';
    const q = query(
      collection(db, path),
      where('userId', '==', user.uid),
      where('deviceId', '==', deviceId),
      where('status', '==', 'draft'),
      orderBy('updatedAt', 'desc'),
      limit(1)
    );

    const unsubscribeOrders = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        const data = doc.data();
        // Only update if we don't have an active unsaved session or if it's the same order
        setOrderState(prev => {
          if (!prev.id || prev.id === doc.id) {
            return { ...data, id: doc.id } as OrderState;
          }
          return prev;
        });
      }
    }, (error) => {
      // If it's a permission error, it might be because the user is not logged in yet
      if (error.message.includes('insufficient permissions')) {
        console.warn("Draft fetch waiting for auth...");
      } else if (error.message.includes('index')) {
        console.warn("Draft query requires index, falling back.");
      } else {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    });

    return () => unsubscribeOrders();
  }, [deviceId, user]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="bg-white p-10 rounded-3xl shadow-2xl max-w-md w-full border border-gray-100">
          <div className="w-20 h-20 bg-[#5B89B1] rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg rotate-3">
            <svg className="w-10 h-10 text-white -rotate-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2 tracking-tight flex items-baseline justify-center gap-2">
            Arpi
            <span className="text-sm font-normal text-gray-500">Powered by UnderCar Plus</span>
          </h1>
          <p className="text-gray-500 mb-8 max-w-xs mx-auto">Connecting to your shop assistant...</p>
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#5B89B1]"></div>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="bg-white p-10 rounded-3xl shadow-2xl max-w-md w-full border border-gray-100">
          <div className="w-20 h-20 bg-[#5B89B1] rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg rotate-3">
            <svg className="w-10 h-10 text-white -rotate-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2 tracking-tight flex items-baseline justify-center gap-2">
            Arpi
            <span className="text-sm font-normal text-gray-500">Powered by UnderCar Plus</span>
          </h1>
          <p className="text-gray-500 mb-8 max-w-xs mx-auto">Your intelligent shop assistant. Please sign in to continue.</p>
          <button 
            onClick={loginWithGoogle}
            className="w-full py-4 bg-[#5B89B1] text-white font-bold rounded-2xl hover:bg-[#4A7194] transition-all shadow-lg active:scale-95 flex items-center justify-center gap-3"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
              <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <AnimatePresence>
        {/* Media Viewer Modal */}
        <AnimatePresence>
          {selectedMedia && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedMedia(null)}
              className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md"
            >
              <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="relative max-w-4xl w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                {selectedMedia.type === 'photo' ? (
                  <img 
                    src={selectedMedia.url} 
                    alt="Captured" 
                    className="w-full h-full object-contain"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gray-900">
                    <video 
                      src={selectedMedia.url} 
                      controls 
                      autoPlay 
                      className="w-full h-full"
                    />
                  </div>
                )}
                <button 
                  onClick={() => setSelectedMedia(null)}
                  className="absolute top-4 right-4 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors"
                >
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {orderState.status === 'confirmed' && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm"
          >
            <div className="w-full max-w-sm p-8 text-center bg-white shadow-2xl rounded-3xl border border-emerald-100">
              <div className="flex items-center justify-center w-20 h-20 mx-auto mb-6 bg-emerald-100 rounded-full">
                <Check className="w-10 h-10 text-emerald-600" />
              </div>
              <h2 className="mb-2 text-2xl font-bold text-gray-900">Order Confirmed!</h2>
              <p className="mb-8 text-gray-600 italic">"Lav e, gortse verchatsav!"</p>
              <button 
                onClick={() => setOrderState({ ...INITIAL_STATE, status: 'draft' })}
                className="w-full py-4 font-semibold text-white transition-all bg-emerald-600 rounded-2xl hover:bg-emerald-700 active:scale-95"
              >
                Start New Order
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="h-screen w-screen bg-[#FDFDFD] text-gray-800 flex flex-col overflow-hidden font-sans relative">
        {/* Header with Logout */}
        <header className="h-12 border-b border-gray-100 flex items-center justify-between px-4 bg-white z-40">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-[#5B89B1] rounded flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
              </svg>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-bold text-[28px] tracking-tight">Arpi</span>
              <span className="text-xs text-gray-400 font-normal">Powered by UnderCar Plus</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {!process.env.GEMINI_API_KEY && window.aistudio && (
              <button 
                onClick={handleSelectKey}
                className={`text-[10px] font-bold uppercase tracking-widest transition-colors border rounded-full px-3 py-1 flex items-center gap-1 ${
                  hasApiKey ? 'text-green-500 border-green-500/20' : 'text-red-500 border-red-500/20'
                }`}
              >
                <div className={`w-1.5 h-1.5 rounded-full ${hasApiKey ? 'bg-green-500' : 'bg-red-500'}`} />
                {hasApiKey ? 'Key Active' : 'Key Missing'}
              </button>
            )}
            {!isFirebaseReady && (
              <div className="flex items-center gap-1 text-red-500 text-[10px] font-bold uppercase tracking-wider">
                <AlertCircle size={12} />
                Offline
              </div>
            )}
            <div className="flex items-center gap-2">
              {user ? (
                user.isAnonymous ? (
                  <button 
                    onClick={loginWithGoogle}
                    className="px-3 py-1.5 bg-[#5B89B1] text-white text-[10px] font-bold uppercase tracking-wider rounded-lg hover:bg-[#4A7194] transition-all shadow-sm"
                  >
                    Sync with Google
                  </button>
                ) : (
                  <>
                    <span className="text-xs text-gray-500 hidden sm:inline">{user.email}</span>
                    <button 
                      onClick={handleLogout}
                      className="text-[10px] font-bold uppercase tracking-widest text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Logout
                    </button>
                  </>
                )
              ) : (
                <div className="w-4 h-4 border-2 border-[#5B89B1] border-t-transparent rounded-full animate-spin" />
              )}
            </div>
          </div>
        </header>

        {/* Desktop Layout */}
        <main className="hidden md:flex flex-1 overflow-hidden">
          {/* Left Column: Conversation */}
          <div className="w-80 lg:w-96 h-full border-r border-gray-100 bg-white shrink-0">
            <Conversation messages={messages} />
          </div>

          {/* Center Column: Input */}
          <div className="flex-1 h-full bg-[#FDFDFD] overflow-hidden">
            <AudioVisualizer 
              isListening={isListening} 
              isConnecting={isConnecting}
              isSpeaking={isSpeaking} 
              onToggleMic={toggleMic} 
              selectedLanguage={selectedLanguage}
              onLanguageChange={handleLanguageChange}
              media={orderState.media}
              onCapture={handleCapture}
              isConfirmed={orderState.isConfirmed}
              onToggleConfirm={handleToggleConfirm}
              onSubmit={handleSubmitOrder}
              onSave={handleSaveOrder}
              onReset={handleResetOrder}
              onFeedback={handleFeedback}
              onHelp={() => setIsHelpOpen(true)}
              onPay={handlePayOrder}
              onSendText={handleSendText}
              transcription={transcription}
              hasApiKey={hasApiKey}
              onSelectKey={handleSelectKey}
              onSelectMedia={setSelectedMedia}
              vehicle={orderState.vehicle}
              vehicleIdentityLock={orderState.vehicleIdentityLock}
              plateState={orderState.plateState || 'CA'}
              onPlateStateChange={(s) => handleUpdateState({ plateState: s })}
              onUpdateVehicle={(v) => handleUpdateState({ vehicle: v })}
              onUpdateState={handleUpdateState}
            />
          </div>

          {/* Right Column: Order Summary */}
          <div className="w-80 lg:w-96 h-full border-l border-gray-100 bg-white shrink-0">
            <OrderSummary 
              user={user}
              state={orderState} 
              onSubmit={handleSubmitOrder} 
              onSave={handleSaveOrder}
              onReset={handleResetOrder} 
              onLoadOrder={handleLoadOrder}
              onToggleConfirm={handleToggleConfirm}
              language={selectedLanguage}
              inMemoryOrders={completedOrders}
              historyOrders={historyOrders}
            />
          </div>
        </main>

        {/* Mobile Layout */}
        <main className="flex md:hidden flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden relative">
            <div className={`absolute inset-0 transition-transform duration-300 ${activeTab === 'conversation' ? 'translate-x-0' : '-translate-x-full'}`}>
              <Conversation messages={messages} />
            </div>
            <div className={`absolute inset-0 transition-transform duration-300 ${activeTab === 'input' ? 'translate-x-0' : (activeTab === 'conversation' ? 'translate-x-full' : '-translate-x-full')}`}>
              <AudioVisualizer 
                isListening={isListening} 
                isSpeaking={isSpeaking} 
                onToggleMic={toggleMic} 
                selectedLanguage={selectedLanguage}
                onLanguageChange={handleLanguageChange}
                media={orderState.media}
                onCapture={handleCapture}
                isConfirmed={orderState.isConfirmed}
                onToggleConfirm={handleToggleConfirm}
                onSubmit={handleSubmitOrder}
                onSave={() => setShowSaveOptions(true)}
                onReset={handleResetOrder}
                onFeedback={handleFeedback}
                onHelp={() => setIsHelpOpen(true)}
                onPay={handlePayOrder}
                onSendText={handleSendText}
                transcription={transcription}
                hasApiKey={hasApiKey}
                onSelectKey={handleSelectKey}
                onSelectMedia={setSelectedMedia}
                vehicle={orderState.vehicle}
                vehicleIdentityLock={orderState.vehicleIdentityLock}
                plateState={orderState.plateState || 'CA'}
                onPlateStateChange={(s) => handleUpdateState({ plateState: s })}
                onUpdateVehicle={(v) => handleUpdateState({ vehicle: v })}
                onUpdateState={handleUpdateState}
              />
            </div>
            <div className={`absolute inset-0 transition-transform duration-300 ${activeTab === 'summary' ? 'translate-x-0' : 'translate-x-full'}`}>
              <OrderSummary 
                user={user}
                state={orderState} 
                onSubmit={handleSubmitOrder} 
                onSave={() => setShowSaveOptions(true)}
                onReset={handleResetOrder} 
                onLoadOrder={handleLoadOrder}
                onToggleConfirm={handleToggleConfirm}
                language={selectedLanguage}
                inMemoryOrders={completedOrders}
                historyOrders={historyOrders}
              />
            </div>
          </div>

          {/* Mobile Navigation Bar */}
          <nav className="h-24 bg-white border-t border-gray-100 flex items-center justify-around px-4 shadow-lg z-40">
            <button 
              onClick={() => setActiveTab('conversation')}
              className={`flex flex-col items-center gap-1 transition-colors ${activeTab === 'conversation' ? 'text-[#5B89B1]' : 'text-gray-400'}`}
            >
              <div className={`w-1 h-1 rounded-full mb-1 ${activeTab === 'conversation' ? 'bg-[#5B89B1]' : 'bg-transparent'}`} />
              <span className="text-[20px] font-bold uppercase tracking-widest">Chat</span>
            </button>
            <button 
              onClick={() => setActiveTab('input')}
              className={`flex flex-col items-center gap-1 transition-colors ${activeTab === 'input' ? 'text-[#5B89B1]' : 'text-gray-400'}`}
            >
              <div className={`w-1 h-1 rounded-full mb-1 ${activeTab === 'input' ? 'bg-[#5B89B1]' : 'bg-transparent'}`} />
              <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${activeTab === 'input' ? 'bg-[#5B89B1] text-white shadow-lg scale-110' : 'bg-gray-100 text-gray-400'}`}>
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
                </svg>
              </div>
              <span className="text-[20px] font-bold uppercase tracking-widest mt-1">Arpi</span>
            </button>
            <button 
              onClick={() => setActiveTab('summary')}
              className={`flex flex-col items-center gap-1 transition-colors ${activeTab === 'summary' ? 'text-[#5B89B1]' : 'text-gray-400'}`}
            >
              <div className={`w-1 h-1 rounded-full mb-1 ${activeTab === 'summary' ? 'bg-[#5B89B1]' : 'bg-transparent'}`} />
              <span className="text-[20px] font-bold uppercase tracking-widest">Order</span>
            </button>
          </nav>
        </main>

      {/* Camera Modal */}
      {cameraMode && (
        <CameraModal 
          mode={cameraMode} 
          onCapture={onCameraCapture} 
          onClose={() => setCameraMode(null)} 
        />
      )}

      {/* Payment Modal */}
      {showPaymentModal && (
        <PaymentModal 
          onClose={() => setShowPaymentModal(false)}
          onSuccess={handleProcessPayment}
          totalAmount={0} // total calculation could be added
          initialMethod={selectedPaymentMethod}
        />
      )}

      {/* Save Options Modal */}
      <AnimatePresence>
        {showSaveOptions && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="w-full max-w-xs bg-white rounded-3xl p-6 shadow-2xl"
            >
              <h3 className="text-lg font-bold text-gray-900 mb-6 text-center">Save Invoice Format</h3>
              <div className="space-y-3">
                <button 
                  onClick={() => handleSaveToPhone('pdf')}
                  className="w-full py-4 bg-[#5B89B1] text-white rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#4A7194] transition-all"
                >
                  <FileText size={20} />
                  <span>Save as PDF</span>
                </button>
                <button 
                  onClick={() => handleSaveToPhone('text')}
                  className="w-full py-4 bg-gray-100 text-gray-700 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-gray-200 transition-all"
                >
                  <Download size={20} />
                  <span>Save as Text</span>
                </button>
                <button 
                  onClick={() => setShowSaveOptions(false)}
                  className="w-full py-3 text-gray-400 font-bold text-sm uppercase tracking-widest"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Help Agent Modal */}
      <HelpAgent 
        isOpen={isHelpOpen} 
        onClose={() => setIsHelpOpen(false)} 
        isMainListening={isListening}
      />

      {/* Feedback Modal */}
      <FeedbackModal
        isOpen={isFeedbackOpen}
        onClose={() => setIsFeedbackOpen(false)}
        onSubmit={handleSubmitFeedback}
        userEmail={user?.email}
        userId={user?.uid}
        deviceId={deviceId}
      />
      </div>
    </ErrorBoundary>
  );
};

export default App;
