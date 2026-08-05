import React from 'react';
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('RxHive Error Boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
          <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-8 max-w-md text-center">
            <div className="w-16 h-16 bg-[#EF4444]/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertTriangle size={28} className="text-[#EF4444]" />
            </div>
            <h1
              className="text-2xl font-bold text-[#F5F5F5] mb-2"
              style={{ textShadow: '0 0 30px rgba(16,185,129,0.2)' }}
            >
              RxHive
            </h1>
            <p className="text-[#A3A3A3] text-sm mb-6">Something went wrong. Please reload the page.</p>
            <button
              onClick={() => window.location.reload()}
              className="flex items-center gap-2 mx-auto px-6 py-2.5 bg-[#10B981] text-[#0A0A0A] rounded-[6px] text-sm font-medium hover:bg-[#059669] transition-colors"
            >
              <RefreshCw size={16} />
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}


export class ChatErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('RxHive Chat Panel Error:', error, errorInfo);
  }

  // Retry alone is only an escape route when the panel is one pane of several.
  // Where the fallback is the entire screen — the mobile chat panel, whose own
  // back button died with the panel — a deterministic error re-throws straight
  // back into this fallback and there is nothing else to touch. Callers in that
  // position pass onBack to put a second, always-working exit next to Try again.
  render() {
    if (this.state.hasError) {
      const { onBack, backLabel = 'Back to chats' } = this.props;
      return (
        <div className="flex-1 flex items-center justify-center bg-[#0A0A0A]">
          <div className="text-center p-6">
            <AlertTriangle size={24} className="text-[#EF4444] mx-auto mb-3" />
            <p className="text-[#A3A3A3] text-sm mb-3">Something went wrong in this panel.</p>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => this.setState({ hasError: false })}
                className="px-4 py-1.5 bg-[#1F1F1F] text-[#F5F5F5] rounded-[6px] text-xs hover:bg-[#2A2A2A] transition-colors"
                data-testid="chat-error-retry"
              >
                Try again
              </button>
              {onBack && (
                // Clearing hasError here is belt-and-braces: the mobile caller
                // unmounts this boundary, and React batches both updates so the
                // unmount wins. It only matters for a caller that keeps the
                // boundary mounted, where leaving hasError set would strand it.
                <button
                  onClick={() => { this.setState({ hasError: false }); onBack(); }}
                  className="flex items-center gap-1.5 px-4 py-1.5 bg-[#1F1F1F] text-[#F5F5F5] rounded-[6px] text-xs hover:bg-[#2A2A2A] transition-colors"
                  data-testid="chat-error-back"
                >
                  <ArrowLeft size={12} />
                  {backLabel}
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
