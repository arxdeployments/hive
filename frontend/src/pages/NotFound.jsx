import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
      <div className="text-center">
        <h1
          className="text-6xl font-bold text-[#F5F5F5] mb-2"
          style={{ textShadow: '0 0 40px rgba(16,185,129,0.3)' }}
        >
          RxHive
        </h1>
        <p className="text-[80px] font-bold text-[#1F1F1F] leading-none mb-2">404</p>
        <p className="text-[#A3A3A3] text-lg mb-6">Page not found</p>
        <button
          onClick={() => navigate('/chat')}
          className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#10B981] text-[#0A0A0A] rounded-[6px] text-sm font-medium hover:bg-[#059669] transition-colors"
        >
          <ArrowLeft size={16} />
          Go to Chat
        </button>
      </div>
    </div>
  );
}
