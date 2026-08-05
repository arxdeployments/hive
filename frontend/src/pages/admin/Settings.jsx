import { PageTransition } from '../../components/common/PageTransition';
import { Settings as SettingsIcon } from 'lucide-react';

export default function SettingsPage() {
  return (
    <PageTransition>
      <div className="max-w-[1400px] mx-auto flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="w-16 h-16 bg-[#141414] border border-[#1F1F1F] rounded-full flex items-center justify-center mx-auto mb-4">
            <SettingsIcon size={28} className="text-[#A3A3A3]/40" />
          </div>
          <h2 className="text-xl font-semibold text-[#F5F5F5] mb-2">Settings</h2>
          <p className="text-sm text-[#A3A3A3]">Platform settings will be available in a future update</p>
        </div>
      </div>
    </PageTransition>
  );
}
