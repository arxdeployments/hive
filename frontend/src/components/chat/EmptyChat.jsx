import { Lock, MessageSquare } from 'lucide-react';

export const EmptyChat = () => {
  return (
    <div className="flex-1 flex items-center justify-center bg-[#0A0A0A]">
      <div className="text-center">
        <MessageSquare size={64} className="text-[#A3A3A3] opacity-30 mx-auto mb-4" />
        <h2 className="text-2xl text-[#A3A3A3] font-medium mb-2">RxHive</h2>
        <p className="text-sm text-[#737373] mb-6">Select a conversation to start messaging</p>
        <div className="flex items-center justify-center gap-2 text-[#525252] text-xs">
          <Lock size={12} />
          <span>End-to-end messaging</span>
        </div>
      </div>
    </div>
  );
};
