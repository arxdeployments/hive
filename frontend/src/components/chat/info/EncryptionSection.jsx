/**
 * Encryption explainer.
 *
 * DELIBERATELY NOT a "your messages are end-to-end encrypted" panel. RX HIVE
 * does not implement E2E encryption: the server can read message content, and
 * so can whoever administers it. Copy here describes what is actually true —
 * encrypted transport, server-side authorisation, org-scoped access — and says
 * plainly that E2E is not in place. Do not "improve" this into a WhatsApp-style
 * privacy promise; it would be a false security claim.
 */

import React from 'react';
import { Building2, Info, Lock, ServerCog, ShieldCheck } from 'lucide-react';

const POINTS = [
  {
    icon: Lock,
    title: 'Encrypted in transit',
    body: 'Messages, calls and file transfers travel over TLS (HTTPS) and secure WebSockets. Someone sharing your network — office Wi-Fi, a café hotspot, your ISP — cannot read them off the wire.',
  },
  {
    icon: ShieldCheck,
    title: 'Authorised on every request',
    body: 'Your session lives in a httpOnly cookie that scripts on the page cannot read. Every read and write is checked server-side against your membership of the conversation.',
  },
  {
    icon: Building2,
    title: 'Scoped to your organization',
    body: 'Conversations are isolated per organization. People outside it cannot list, open or search this chat, and cross-organization groups only reach the organizations explicitly added to them.',
  },
  {
    icon: ServerCog,
    title: 'Stored on RX HIVE servers',
    // Kept in step with what the product can actually do. This previously
    // described per-message "delete for me" / "delete for everyone", both of
    // which were removed, and then "Clear chat", also since removed. Deleting a
    // conversation is now the only action that hides history, and it hides it
    // for the caller alone.
    body: 'History is retained on the server so you can search it and pick it up on another device. Deleting a chat hides your copy; everyone else keeps theirs.',
  },
];

export const EncryptionSection = ({ testIdPrefix = 'info-encryption' }) => (
  <div className="p-5 space-y-5" data-testid={`${testIdPrefix}-panel`}>
    <div className="flex flex-col items-center text-center pt-2 pb-1">
      <div className="w-14 h-14 rounded-full bg-[#10B981]/10 flex items-center justify-center mb-3">
        <Lock size={22} className="text-[#10B981]" />
      </div>
      <h4 className="text-base font-semibold text-[#F5F5F5]">How this chat is protected</h4>
      <p className="text-sm text-[#A3A3A3] mt-1 max-w-[420px]">
        RX HIVE secures your conversations in transit and controls who can reach them. Here is exactly
        what that does and does not cover.
      </p>
    </div>

    <div className="space-y-2">
      {POINTS.map((point) => {
        const Icon = point.icon;
        return (
          <div key={point.title} className="flex gap-3 p-4 bg-[#141414] border border-[#1F1F1F] rounded-[10px]">
            <Icon size={18} className="text-[#10B981] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-[#F5F5F5]">{point.title}</p>
              <p className="text-sm text-[#A3A3A3] mt-1 leading-relaxed">{point.body}</p>
            </div>
          </div>
        );
      })}
    </div>

    {/* The honest caveat. Keep it visible — it is the point of this section. */}
    <div
      className="flex gap-3 p-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[10px]"
      data-testid={`${testIdPrefix}-disclaimer`}
    >
      <Info size={18} className="text-[#A3A3A3] shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-[#F5F5F5]">Not end-to-end encrypted</p>
        <p className="text-sm text-[#A3A3A3] mt-1 leading-relaxed">
          Message content is readable on the RX HIVE server, so your organization&apos;s administrators can
          access it where policy, compliance or the law requires. Treat this as a work chat, not a private
          one — for anything that must stay unreadable to your organization, use a channel designed for it.
        </p>
      </div>
    </div>
  </div>
);
